import { createHash } from "node:crypto";
import { z } from "zod";
import {
  supportRequestIdSchema,
  createSupportRequestSchema,
  supportRequestsQuerySchema,
  updateSupportRequestStatusSchema,
  supportRequestSchema,
  adminSupportRequestSchema,
  serviceConsentPolicySchema,
  type CreateSupportRequest,
  type SupportRequestsQuery,
  type UpdateSupportRequestStatus,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  buildServiceConsentPolicy,
  consentPolicyHash,
} from "./service-consent-policy.js";

const contextSchema = z.strictObject({
  userId: supportRequestIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type HumanSupportContext = z.infer<typeof contextSchema>;
const utc = (c: string) =>
  `to_char(${c} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const fields = `r.id::text,r.operation_id::text as "operationId",r.body,r.status,r.revision::text,
 ${utc("r.created_at")} as "createdAt",${utc("r.updated_at")} as "updatedAt",${utc("r.closed_at")} as "closedAt"`;
const ownerFields = `json_build_object('userId',u.id::text,'email',case when u.username='admin' and c.email='admin@citygo.invalid' then null else c.email end,'username',u.username) as owner`;
const missing = () => new DomainError(404, "Обращение не найдено");
async function authorize(tx: Sql, raw: HumanSupportContext, admin: boolean) {
  const ctx = contextSchema.parse(raw);
  if (
    (
      await tx.query(
        "select id from account_security_state where id=1 for update",
      )
    ).rows.length !== 1
  )
    throw new DomainError(503, "Хранилище аккаунтов не готово");
  const user = (
    await tx.query<{ role: string; must_change_password: boolean }>(
      "select role,must_change_password from users where id=$1 and status='active' for update",
      [ctx.userId],
    )
  ).rows[0];
  if (
    !user ||
    !(
      await tx.query(
        "select token_hash from sessions where token_hash=$1 and user_id=$2 and expires_at>clock_timestamp() for update",
        [ctx.sessionTokenHash, ctx.userId],
      )
    ).rows.length
  )
    throw new DomainError(401, "Войдите в аккаунт");
  if (user.must_change_password)
    throw new DomainError(403, "Сначала смените временный пароль");
  if (admin && !["admin", "super_admin"].includes(user.role))
    throw new DomainError(403, "Доступ только для администратора");
  // Latest personal-data decision, never a historical grant past withdrawal.
  // Human support requires no AI grant or balance. Provider policy is not read.
  const evidence = (
    await tx.query<{
      decision: string;
      policy_snapshot: unknown;
      policy_hash: string;
    }>(
      "select decision,policy_snapshot,policy_hash from service_consent_events where user_id=$1 and purpose='personal-data' order by id desc limit 1",
      [ctx.userId],
    )
  ).rows[0];
  const policy = serviceConsentPolicySchema.safeParse(
    evidence?.policy_snapshot,
  );
  if (
    evidence?.decision !== "granted" ||
    !policy.success ||
    consentPolicyHash(policy.data) !==
      consentPolicyHash(
        buildServiceConsentPolicy(policy.data.aiProcessing ?? null),
      ) ||
    consentPolicyHash(policy.data) !== evidence.policy_hash
  )
    throw new DomainError(
      403,
      "Подтвердите согласие на обработку персональных данных.",
      "SERVICE_CONSENT_REQUIRED",
    );
  return ctx;
}
function parsed(row: Record<string, unknown>, admin = false) {
  const { request_hash: _hash, ...publicRow } = row;
  void _hash;
  try {
    return (admin ? adminSupportRequestSchema : supportRequestSchema).parse({
      ...publicRow,
      revision: Number(row.revision),
    });
  } catch {
    throw new DomainError(500, "Не удалось прочитать обращение");
  }
}
async function audit(
  tx: Sql,
  actorId: string,
  action: string,
  id: string | null,
  payload: Record<string, unknown>,
) {
  await tx.query(
    "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,'human-support-request',$3,$4::jsonb)",
    [actorId, action, id, JSON.stringify(payload)],
  );
}

/** Private requests, never AI messages, outbound notifications or CRM promises. */
export class HumanSupportRequests {
  constructor(private readonly db: Database) {}
  async create(raw: HumanSupportContext, command: CreateSupportRequest) {
    const input = createSupportRequestSchema.parse(command);
    const hash = createHash("sha256").update(input.body).digest("hex");
    return this.db.transaction(async (tx) => {
      const ctx = await authorize(tx, raw, false);
      const old = (
        await tx.query<Record<string, unknown>>(
          `select ${fields},r.request_hash from human_support_requests r where r.user_id=$1 and r.operation_id=$2`,
          [ctx.userId, input.operationId],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== hash)
          throw new DomainError(
            409,
            "Этот номер операции уже использован для другого вопроса.",
            "CONFLICT",
          );
        return { userId: ctx.userId, request: parsed(old) };
      }
      const count = (
        await tx.query<{ count: number }>(
          "select count(*)::integer as count from human_support_requests where user_id=$1",
          [ctx.userId],
        )
      ).rows[0]!.count;
      if (count >= 200)
        throw new DomainError(
          409,
          "Достигнут предел сохранённых обращений.",
          "CONFLICT",
        );
      const row = (
        await tx.query<Record<string, unknown>>(
          `insert into human_support_requests as r(user_id,operation_id,request_hash,body) values($1,$2,$3,$4) returning ${fields}`,
          [ctx.userId, input.operationId, hash, input.body],
        )
      ).rows[0]!;
      await audit(tx, ctx.userId, "human-support-created", String(row.id), {
        revision: 1,
      });
      return { userId: ctx.userId, request: parsed(row) };
    });
  }
  async list(
    raw: HumanSupportContext,
    query: SupportRequestsQuery = {},
    admin = false,
  ) {
    const input = supportRequestsQuerySchema.parse(query);
    return this.db.transaction(async (tx) => {
      const ctx = await authorize(tx, raw, admin);
      const rows = (
        await tx.query<Record<string, unknown>>(
          `select ${fields}${admin ? "," + ownerFields : ""} from human_support_requests r ${admin ? "join users u on u.id=r.user_id left join user_credentials c on c.user_id=u.id" : ""}
        where ($1::bigint is null or r.user_id=$1) and ($2::bigint is null or r.id<$2) and ($3::text is null or r.status=$3) order by r.id desc limit 21`,
          [
            admin ? null : ctx.userId,
            input.before ?? null,
            input.status ?? null,
          ],
        )
      ).rows;
      const requests = rows.slice(0, 20).map((row) => parsed(row, admin));
      if (admin)
        await audit(tx, ctx.userId, "human-support-inbox-viewed", null, {
          rowCount: requests.length,
        });
      return {
        ...(admin ? { actorId: ctx.userId } : { userId: ctx.userId }),
        requests,
        nextBefore: rows.length > 20 ? requests.at(-1)!.id : null,
      };
    });
  }
  async detail(raw: HumanSupportContext, id: string) {
    supportRequestIdSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const ctx = await authorize(tx, raw, true);
      const row = (
        await tx.query<Record<string, unknown>>(
          `select ${fields},${ownerFields} from human_support_requests r join users u on u.id=r.user_id left join user_credentials c on c.user_id=u.id where r.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw missing();
      await audit(tx, ctx.userId, "human-support-viewed", id, {});
      return { actorId: ctx.userId, request: parsed(row, true) };
    });
  }
  async setStatus(
    raw: HumanSupportContext,
    id: string,
    command: UpdateSupportRequestStatus,
  ) {
    supportRequestIdSchema.parse(id);
    const input = updateSupportRequestStatusSchema.parse(command);
    return this.db.transaction(async (tx) => {
      const ctx = await authorize(tx, raw, true);
      const old = (
        await tx.query<{ revision: string; status: string }>(
          "select revision::text,status from human_support_requests where id=$1 for update",
          [id],
        )
      ).rows[0];
      if (!old) throw missing();
      const revision = Number(old.revision);
      if (revision !== input.expectedRevision)
        throw new DomainError(
          409,
          "Обращение изменилось. Обновите список.",
          "REVISION_CONFLICT",
          revision,
        );
      if (revision === Number.MAX_SAFE_INTEGER)
        throw new DomainError(409, "Достигнут предел версий обращения.");
      if (old.status !== input.status) {
        await tx.query(
          `update human_support_requests set status=$2,revision=revision+1,
         updated_at=greatest(statement_timestamp(),updated_at+interval '1 microsecond'),
         closed_at=case when $2='closed' then greatest(statement_timestamp(),updated_at+interval '1 microsecond') else null end where id=$1`,
          [id, input.status],
        );
        await audit(tx, ctx.userId, "human-support-status-changed", id, {
          from: old.status,
          to: input.status,
          revision: revision + 1,
        });
      }
      const row = (
        await tx.query<Record<string, unknown>>(
          `select ${fields},${ownerFields} from human_support_requests r join users u on u.id=r.user_id left join user_credentials c on c.user_id=u.id where r.id=$1`,
          [id],
        )
      ).rows[0]!;
      return { actorId: ctx.userId, request: parsed(row, true) };
    });
  }
}
