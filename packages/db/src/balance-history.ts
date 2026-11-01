import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  BALANCE_HISTORY_PAGE_SIZE,
  balanceHistoryPageSchema,
  balanceHistoryQuerySchema,
  balanceHistoryFilterSchema,
  creditUserIdSchema,
  serviceConsentPolicySchema,
  type BalanceHistoryQuery,
  type BalanceHistoryPage,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  buildServiceConsentPolicy,
  consentPolicyHash,
} from "./service-consent-policy.js";

const contextSchema = z.strictObject({
  userId: creditUserIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BalanceHistoryContext = z.infer<typeof contextSchema>;
const bigint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
const cursorBodySchema = z.strictObject({
  v: z.literal(1),
  filter: balanceHistoryFilterSchema,
  creditThrough: bigint,
  refundThrough: bigint,
  at: z.iso.datetime({ precision: 6 }),
  lane: z.enum(["credit", "refund"]),
  id: bigint,
  expires: z.number().int().positive(),
});
type Cursor = z.infer<typeof cursorBodySchema>;
const invalidCursor = () =>
  new DomainError(
    400,
    "История изменилась. Откройте её заново.",
    "VALIDATION_ERROR",
  );
function signature(context: BalanceHistoryContext, body: string) {
  return createHmac("sha256", context.sessionTokenHash)
    .update("balance-history-v1:" + context.userId + ":" + body)
    .digest("base64url");
}
function readCursor(
  context: BalanceHistoryContext,
  value: string,
  filter: string,
) {
  try {
    const [body, mac] = value.split(".");
    const expected = signature(context, body!);
    if (
      !mac ||
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    )
      throw invalidCursor();
    const json = Buffer.from(body!, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== body) throw invalidCursor();
    const cursor = cursorBodySchema.parse(JSON.parse(json));
    if (
      cursor.filter !== filter ||
      cursor.id === "0" ||
      BigInt(cursor.id) >
        BigInt(
          cursor.lane === "credit"
            ? cursor.creditThrough
            : cursor.refundThrough,
        )
    )
      throw invalidCursor();
    if (cursor.expires < Date.now())
      throw new DomainError(409, "Обновите историю баланса.", "CONFLICT");
    return cursor;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidCursor();
  }
}
function writeCursor(context: BalanceHistoryContext, cursor: Cursor) {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return body + "." + signature(context, body);
}
async function authorize(tx: Sql, raw: BalanceHistoryContext) {
  const context = contextSchema.parse(raw);
  // Same global/user/session lock order as account revocation and consent writes.
  // SHARE locks keep this endpoint read-only while excluding concurrent revocation.
  if (
    !(
      await tx.query(
        "select id from account_security_state where id=1 for share",
      )
    ).rows.length
  )
    throw new DomainError(503, "Хранилище аккаунтов не готово");
  const user = (
    await tx.query<{ must_change_password: boolean }>(
      "select must_change_password from users where id=$1 and status='active' for share",
      [context.userId],
    )
  ).rows[0];
  if (
    !user ||
    !(
      await tx.query(
        "select token_hash from sessions where token_hash=$1 and user_id=$2 and expires_at>clock_timestamp() for share",
        [context.sessionTokenHash, context.userId],
      )
    ).rows.length
  )
    throw new DomainError(401, "Войдите в аккаунт");
  if (user.must_change_password)
    throw new DomainError(403, "Сначала смените временный пароль");
  const evidence = (
    await tx.query<{
      decision: string;
      policy_snapshot: unknown;
      policy_hash: string;
    }>(
      "select decision,policy_snapshot,policy_hash from service_consent_events where user_id=$1 and purpose='personal-data' order by id desc limit 1",
      [context.userId],
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
  return context;
}
const successfulRefund = `from payment_refunds r join credit_refund_allocations a on a.refund_id=r.id and a.user_id=r.user_id and a.state='settled' and a.amount_micros=r.amount_kopeks*10000
 join lateral (select sequence,created_at from payment_refund_events where refund_id=r.id and action='provider_observed' and payload->>'providerStatus'='succeeded' order by sequence limit 1) e on true
 where r.user_id=$1 and r.status='succeeded'`;
const stamp = (column: string) =>
  `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Authoritative settled history only. No reservations, balances or money writes. */
export class BalanceHistory {
  constructor(private readonly db: Database) {}
  async list(
    raw: BalanceHistoryContext,
    query: BalanceHistoryQuery = {},
  ): Promise<BalanceHistoryPage> {
    const input = balanceHistoryQuerySchema.parse(query),
      filter = input.filter ?? "all";
    return this.db.transaction(async (tx) => {
      await tx.exec("set local statement_timeout='5s'");
      const context = await authorize(tx, raw);
      const before = input.cursor
        ? readCursor(context, input.cursor, filter)
        : null;
      const snapshot =
        before ??
        (
          await tx.query<{ creditThrough: string; refundThrough: string }>(
            `select
        coalesce((select max(id) from ai_credit_entries where user_id=$1 and kind in ('bonus','topup','settle')),0)::text as "creditThrough",
        coalesce((select max(e.sequence) ${successfulRefund}),0)::text as "refundThrough"`,
            [context.userId],
          )
        ).rows[0]!;
      const args = [
        context.userId,
        snapshot.creditThrough,
        snapshot.refundThrough,
        filter,
        before?.at ?? null,
        before?.lane ?? null,
        before?.id ?? null,
      ];
      const creditBranches = [
        ["bonus", "gift", "credit"],
        ["topup", "topup", "credit"],
        ["settle", "spend", "debit"],
      ]
        .map(
          ([
            kind,
            publicKind,
            direction,
          ]) => `(select 'credit'::text as lane,id,'${publicKind}'::text as kind,'${direction}'::text as direction,amount_micros,created_at
        from ai_credit_entries where user_id=$1 and kind='${kind}' and id<=$2::bigint and ($4::text='all' or $4='${publicKind}')
        and ($5::timestamptz is null or (created_at,'credit'::text,id)<($5::timestamptz,$6::text,$7::bigint))
        order by created_at desc,id desc limit ${BALANCE_HISTORY_PAGE_SIZE + 1})`,
        )
        .join(" union all ");
      const rows = (
        await tx.query<{
          id: string;
          kind: string;
          direction: string;
          amountMicros: string;
          createdAt: string;
        }>(
          `select lane||':'||id::text as id,kind,direction,amount_micros::text as "amountMicros",${stamp("created_at")} as "createdAt" from (
        ${creditBranches} union all
        (select 'refund'::text as lane,e.sequence as id,'refund'::text as kind,'debit'::text as direction,a.amount_micros,e.created_at
          ${successfulRefund} and e.sequence<=$3::bigint and ($4::text='all' or $4='refund')
          and ($5::timestamptz is null or (e.created_at,'refund'::text,e.sequence)<($5::timestamptz,$6::text,$7::bigint))
          order by e.created_at desc,e.sequence desc limit ${BALANCE_HISTORY_PAGE_SIZE + 1})
        ) visible order by visible.created_at desc,visible.lane desc,visible.id desc limit ${BALANCE_HISTORY_PAGE_SIZE + 1}`,
          args,
        )
      ).rows;
      const entries = rows
        .slice(0, BALANCE_HISTORY_PAGE_SIZE)
        .map((row) => ({ ...row, amountMicros: Number(row.amountMicros) }));
      const last = entries.at(-1),
        [lane, id] = last?.id.split(":") ?? [];
      return balanceHistoryPageSchema.parse({
        userId: context.userId,
        filter,
        entries,
        nextCursor:
          rows.length > BALANCE_HISTORY_PAGE_SIZE && last
            ? writeCursor(context, {
                v: 1,
                filter,
                creditThrough: snapshot.creditThrough,
                refundThrough: snapshot.refundThrough,
                at: last.createdAt,
                lane: lane as Cursor["lane"],
                id: id!,
                expires: before?.expires ?? Date.now() + 30 * 60_000,
              })
            : null,
      });
    });
  }
}
