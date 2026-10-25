import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { creditUserIdSchema } from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingInput = z.strictObject({
  userId: creditUserIdSchema,
  phoneKey: digest,
  sourceChallengeId: z.uuid(),
  sourceClaimOperationId: z.uuid(),
});
const changeInput = z
  .strictObject({
    operationId: z.uuid(),
    fromUserId: creditUserIdSchema,
    toUserId: creditUserIdSchema.nullable(),
    expectedSourceBindingId: z.uuid(),
    expectedPhoneKey: digest,
    expectedPolicyFingerprint: digest,
    authoritySha256: digest,
    reason: z.literal("owner-request"),
  })
  .refine((v) => v.toUserId === null || v.toUserId !== v.fromUserId);
export type PhoneContactChangeInput = z.infer<typeof changeInput>;
export type PhoneContactChangeReceipt = {
  operationId: string;
  fromUserId: string;
  toUserId: string | null;
  sourceBindingId: string;
  targetBindingId: string | null;
  replayed: boolean;
};
export type ActivePhoneContact = {
  id: string;
  userId: string;
  phoneKey: string;
  proofUserId: string;
  sourceChallengeId: string;
  sourceClaimOperationId: string;
  policyFingerprint: string;
  method: "phone_code" | "operator_transfer";
};
const invalid = () =>
  new DomainError(400, "Некорректная операция привязки телефона");
const conflict = () =>
  new DomainError(
    409,
    "Привязка телефона изменилась. Требуется повторная проверка",
  );
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}

// A contact follows retained real evidence. An operator transfer does not rewrite
// the SMS owner, consume another code or imply a new gift for the current owner.
export async function activePhoneContact(tx: Sql, userId: string) {
  creditUserIdSchema.parse(userId);
  return (
    await tx.query<ActivePhoneContact>(
      `select b.id::text,b.user_id::text as "userId",b.phone_key as "phoneKey",
      b.proof_user_id::text as "proofUserId",b.source_challenge_id::text as "sourceChallengeId",
      b.source_claim_operation_id::text as "sourceClaimOperationId",b.policy_fingerprint as "policyFingerprint",b.method
    from phone_contact_bindings b
    join phone_welcome_claims w on w.user_id=b.proof_user_id and w.phone_key=b.phone_key
      and w.challenge_id=b.source_challenge_id and w.operation_id=b.source_claim_operation_id
    join phone_verification_challenges c on c.id=w.challenge_id and c.user_id=w.user_id and c.phone_key=w.phone_key
    join ai_credit_entries e on e.operation_id=w.operation_id and e.user_id=w.user_id and e.kind='bonus'
      and e.amount_micros=w.granted_micros
    join phone_verification_control p on p.id=1 and p.bound_at is not null
      and p.policy_fingerprint=c.policy_fingerprint and p.policy_fingerprint=b.policy_fingerprint
    where b.user_id=$1 and b.unlinked_at is null and c.consumed_at is not null
      and c.consumed_operation_id=w.operation_id and c.delivery='accepted' and c.superseded_at is null
      and c.consumed_at<=c.expires_at and w.granted_micros=500000000
      and (b.method='phone_code' and b.user_id=b.proof_user_id and b.previous_binding_id is null
        or b.method='operator_transfer' and exists(select 1 from phone_contact_bindings previous
          where previous.id=b.previous_binding_id and previous.phone_key=b.phone_key
            and previous.proof_user_id=b.proof_user_id and previous.source_challenge_id=b.source_challenge_id
            and previous.source_claim_operation_id=b.source_claim_operation_id
            and previous.policy_fingerprint=b.policy_fingerprint and previous.unlinked_at is not null
            and previous.unlink_operation_id=b.bind_operation_id))`,
      [userId],
    )
  ).rows[0];
}

// Called inside the original confirm transaction AFTER the exact claim. The
// unique operation id is its original bonus posting, never a replacement proof.
export async function createPhoneContactBinding(
  tx: Sql,
  raw: z.infer<typeof bindingInput>,
) {
  const input = parse(bindingInput, raw);
  await tx.query(
    `insert into phone_contact_bindings(id,user_id,phone_key,proof_user_id,source_challenge_id,
      source_claim_operation_id,policy_fingerprint,bind_operation_id)
    select $4,$1,$2,$1,$3,$4,c.policy_fingerprint,$4
      from phone_verification_challenges c where c.id=$3`,
    [
      input.userId,
      input.phoneKey,
      input.sourceChallengeId,
      input.sourceClaimOperationId,
    ],
  );
  const binding = await activePhoneContact(tx, input.userId);
  if (!binding || binding.id !== input.sourceClaimOperationId) throw conflict();
  return binding;
}

type StoredChange = {
  request_hash: string;
  operation_id: string;
  from_user_id: string;
  to_user_id: string | null;
  source_binding_id: string;
  target_binding_id: string | null;
};
const receipt = (
  row: StoredChange,
  replayed: boolean,
): PhoneContactChangeReceipt => ({
  operationId: row.operation_id,
  fromUserId: row.from_user_id,
  toUserId: row.to_user_id,
  sourceBindingId: row.source_binding_id,
  targetBindingId: row.target_binding_id,
  replayed,
});

// Database-owner/superuser operator tool only. No HTTP route or runtime grant.
export class PhoneContacts {
  constructor(private db: Database) {}
  async changeByOperator(
    raw: PhoneContactChangeInput,
  ): Promise<PhoneContactChangeReceipt> {
    const input = parse(changeInput, raw);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          operationId: input.operationId,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          expectedSourceBindingId: input.expectedSourceBindingId,
          expectedPhoneKey: input.expectedPhoneKey,
          expectedPolicyFingerprint: input.expectedPolicyFingerprint,
          authoritySha256: input.authoritySha256,
          reason: input.reason,
        }),
      )
      .digest("hex");
    return this.db.transaction(async (tx) => {
      const allowed = (
        await tx.query<{ allowed: boolean }>(
          `select current_user not in ('citygo_api','citygo_worker','citygo_backup')
          and (current_user=pg_get_userbyid(c.relowner) or r.rolsuper) as allowed
        from pg_class c join pg_roles r on r.rolname=current_user
        where c.oid='public.phone_contact_bindings'::regclass`,
        )
      ).rows[0]?.allowed;
      if (allowed !== true)
        throw new DomainError(
          403,
          "Изменение привязки доступно только оператору базы данных",
        );
      if (
        (
          await tx.query(
            "select id from account_security_state where id=1 for update",
          )
        ).rows.length !== 1
      )
        throw new DomainError(503, "Хранилище привязки телефона не готово");
      const ids = [
        input.fromUserId,
        ...(input.toUserId === null ? [] : [input.toUserId]),
      ].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
      );
      const users = await tx.query<{ id: string; status: string }>(
        "select id::text,status from users where id=any($1::bigint[]) order by users.id for update",
        [ids],
      );
      if (
        users.rows.length !== ids.length ||
        users.rows.some((u) => u.status !== "active")
      )
        throw conflict();
      const previous = (
        await tx.query<StoredChange>(
          `select request_hash,operation_id::text,from_user_id::text,to_user_id::text,
          source_binding_id::text,target_binding_id::text from phone_contact_changes where operation_id=$1`,
          [input.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw conflict();
        return receipt(previous, true);
      }
      const current = (
        await tx.query<{ policy_fingerprint: string | null }>(
          "select policy_fingerprint from phone_verification_control where id=1 and bound_at is not null",
        )
      ).rows[0];
      if (current?.policy_fingerprint !== input.expectedPolicyFingerprint)
        throw conflict();
      await tx.query(
        "select id from phone_contact_bindings where user_id=any($1::bigint[]) and unlinked_at is null order by user_id,id for update",
        [ids],
      );
      const source = await activePhoneContact(tx, input.fromUserId);
      if (
        !source ||
        source.id !== input.expectedSourceBindingId ||
        source.phoneKey !== input.expectedPhoneKey ||
        source.policyFingerprint !== input.expectedPolicyFingerprint
      )
        throw conflict();
      if (
        input.toUserId !== null &&
        (
          await tx.query(
            "select id from phone_contact_bindings where user_id=$1 and unlinked_at is null",
            [input.toUserId],
          )
        ).rows.length
      )
        throw conflict();
      const unlinked = await tx.query(
        `update phone_contact_bindings set unlinked_at=clock_timestamp(),unlink_operation_id=$2
        where id=$1 and user_id=$3 and unlinked_at is null returning id`,
        [source.id, input.operationId, input.fromUserId],
      );
      if (unlinked.rows.length !== 1) throw conflict();
      const targetId = input.toUserId === null ? null : randomUUID();
      if (targetId !== null)
        await tx.query(
          `insert into phone_contact_bindings(id,user_id,phone_key,proof_user_id,source_challenge_id,
          source_claim_operation_id,policy_fingerprint,method,previous_binding_id,bind_operation_id)
        values($1,$2,$3,$4,$5,$6,$7,'operator_transfer',$8,$9)`,
          [
            targetId,
            input.toUserId,
            source.phoneKey,
            source.proofUserId,
            source.sourceChallengeId,
            source.sourceClaimOperationId,
            source.policyFingerprint,
            source.id,
            input.operationId,
          ],
        );
      const changed = (
        await tx.query<StoredChange>(
          `insert into phone_contact_changes(operation_id,request_hash,from_user_id,to_user_id,
          source_binding_id,target_binding_id,phone_key,policy_fingerprint,authority_sha256,reason)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        returning request_hash,operation_id::text,from_user_id::text,to_user_id::text,source_binding_id::text,target_binding_id::text`,
          [
            input.operationId,
            requestHash,
            input.fromUserId,
            input.toUserId,
            source.id,
            targetId,
            source.phoneKey,
            source.policyFingerprint,
            input.authoritySha256,
            input.reason,
          ],
        )
      ).rows[0]!;
      // Null actor is intentional: the operator did not impersonate the target
      // account, authenticate its session, or assert a new target-owned SMS.
      await tx.query(
        `insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)
        values(null,$1,'phone-contact',$2,$3::jsonb)`,
        [
          input.toUserId === null
            ? "phone-contact-unlinked"
            : "phone-contact-transferred",
          input.fromUserId,
          JSON.stringify({
            ...receipt(changed, false),
            authoritySha256: input.authoritySha256,
            method: "database-operator",
          }),
        ],
      );
      return receipt(changed, false);
    });
  }
}
