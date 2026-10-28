import { z } from "zod";
import {
  adminCustomerAccountsQuerySchema,
  adminCustomerPageQuerySchema,
  adminCustomerMessagesQuerySchema,
  adminCustomerActivityQuerySchema,
  adminCustomerFunnelQuerySchema,
  customerAccountIdSchema,
  customerInteractionInputSchema,
  customerInteractionNameSchema,
  type AdminCustomerAccountsPage,
  type AdminCustomerAccount,
  type AdminCustomerConversationsPage,
  type AdminCustomerMessagesPage,
  type AdminCustomerFavoritesPage,
  type AdminCustomerPlanPage,
  type AdminCustomerActivityPage,
  type AdminCustomerFunnel,
  type AdminCustomerSummary,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const contextSchema = z.strictObject({
  userId: customerAccountIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CustomerObservabilityContext = z.infer<typeof contextSchema>;
const utc = (column: string) =>
  `to_char((${column}) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const missing = () => new DomainError(404, "Аккаунт или диалог не найден");
const summaryFields = `u.id::text as "userId",c.email,u.username,u.role,u.status,
 ${utc("u.created_at")} as "createdAt",
 ${utc("greatest(u.created_at,(select max(s.created_at)from sessions s where s.user_id=u.id),(select max(m.created_at)from agent_threads t join messages m on m.thread_id=t.id where t.user_id=u.id and m.role in('user','assistant')),(select max(e.created_at)from analytics_events e where e.user_id=u.id),(select max(p.updated_at)from personal_plan_items p where p.user_id=u.id))")} as "lastActivityAt",
 exists(select 1 from account_email_verifications e where e.user_id=u.id and e.email=c.email) as "emailVerified",
 exists(select 1 from phone_contact_bindings b where b.user_id=u.id and b.unlinked_at is null) as "phoneVerified",
 exists(select 1 from ai_credit_entries e where e.user_id=u.id and e.kind='bonus') as "giftClaimed",
 (coalesce(a.granted_micros,0)-coalesce(a.held_micros,0)-coalesce(a.spent_micros,0))::text as "availableMicros",
 coalesce(a.held_micros,0)::text as "heldMicros",coalesce(a.spent_micros,0)::text as "spentMicros",
 (select count(*)::integer from agent_threads t join messages m on m.thread_id=t.id where t.user_id=u.id and m.role in('user','assistant')) as "messageCount",
 (select count(*)::integer from agent_threads t where t.user_id=u.id) as "conversationCount"`;
type SummaryRow = Omit<
  AdminCustomerSummary,
  "availableMicros" | "heldMicros" | "spentMicros"
> & { availableMicros: string; heldMicros: string; spentMicros: string };
const summary = (v: SummaryRow): AdminCustomerSummary => ({
  ...v,
  availableMicros: Number(v.availableMicros),
  heldMicros: Number(v.heldMicros),
  spentMicros: Number(v.spentMicros),
});
const summaryFrom =
  "from users u join user_credentials c on c.user_id=u.id left join ai_credit_accounts a on a.user_id=u.id";

async function authorize(
  tx: Sql,
  raw: CustomerObservabilityContext,
  admin: boolean,
) {
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
  if (!user) throw new DomainError(401, "Войдите в аккаунт");
  if (
    (
      await tx.query(
        "select token_hash from sessions where token_hash=$1 and user_id=$2 and expires_at>clock_timestamp() for update",
        [ctx.sessionTokenHash, ctx.userId],
      )
    ).rows.length !== 1
  )
    throw new DomainError(401, "Войдите в аккаунт");
  if (user.must_change_password)
    throw new DomainError(403, "Сначала смените временный пароль");
  if (admin && user.role !== "super_admin")
    throw new DomainError(
      403,
      "Просмотр кабинетов доступен супер-администратору",
    );
  return ctx;
}
async function requireTarget(tx: Sql, userId: string) {
  customerAccountIdSchema.parse(userId);
  if (
    (await tx.query("select id from users where id=$1", [userId])).rows
      .length !== 1
  )
    throw missing();
}
async function audit(
  tx: Sql,
  actorId: string,
  target: string | null,
  view: string,
  count: number,
  conversationId?: string,
) {
  await tx.query(
    "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'customer-account-viewed','customer-account',$2,$3::jsonb)",
    [
      actorId,
      target,
      JSON.stringify({
        view,
        rowCount: count,
        readOnly: true,
        ...(conversationId ? { conversationId } : {}),
      }),
    ],
  );
}
const planFields = `id::text,title,details,status,${utc("created_at")} as "createdAt",${utc("updated_at")} as "updatedAt"`;
async function planPage(
  tx: Sql,
  userId: string,
  before: string | undefined,
  limit: number,
): Promise<AdminCustomerPlanPage> {
  const rows = (
    await tx.query<AdminCustomerPlanPage["items"][number]>(
      `select ${planFields} from personal_plan_items where user_id=$1 and deleted_at is null and ($2::bigint is null or id<$2::bigint) order by id desc limit $3`,
      [userId, before ?? null, limit + 1],
    )
  ).rows;
  const items = rows.slice(0, limit);
  return {
    userId,
    items,
    nextBeforeId: rows.length > limit ? items.at(-1)!.id : null,
  };
}
function bounded<T extends { id: string }>(rows: T[], limit: number) {
  const values: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > 6 * 1024 * 1024)
      throw new DomainError(
        503,
        "Сообщение слишком велико для безопасного просмотра",
      );
    if (bytes + size > 6 * 1024 * 1024) break;
    values.push(row);
    bytes += size;
  }
  return {
    values,
    next: rows.length > values.length ? values.at(-1)!.id : null,
  };
}
const uiLabels: Record<string, string> = {
  assistant_opened: "Открыл помощника",
  mode_selected: "Выбрал режим работы",
  favorite_added: "Сохранил сообщение",
  favorite_removed: "Убрал сообщение из избранного",
  wallet_opened: "Открыл баланс",
  phone_opened: "Открыл подтверждение телефона",
  profile_opened: "Открыл личный кабинет",
  plan_opened: "Открыл личный план",
  conversation_opened: "Открыл диалог",
  ai_request_submitted: "Нажал отправку сообщения",
  payment_redirected: "Перешёл на оплату",
};
const activityCursor = z.tuple([
  z.iso.datetime(),
  z.number().int().min(1).max(9),
  customerAccountIdSchema,
]);
type ActivityRow = {
  source: number;
  sourceId: string;
  kind: string;
  occurredAt: string;
  conversationId: string | null;
  messageId: string | null;
  amountMicros: string | null;
};
function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.toString("base64url") !== value) throw Error();
    return activityCursor.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new DomainError(400, "Некорректный курсор истории");
  }
}

/** Administrative projections only. No user session, consent, ledger or message is changed. */
export class CustomerObservability {
  constructor(private readonly db: Database) {}
  private admin<T>(
    ctx: CustomerObservabilityContext,
    target: string | null,
    view: string,
    work: (tx: Sql) => Promise<{ value: T; count: number }>,
    conversationId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const actor = await authorize(tx, ctx, true);
      if (target) await requireTarget(tx, target);
      const out = await work(tx);
      await audit(tx, actor.userId, target, view, out.count, conversationId);
      return out.value;
    });
  }
  async list(
    ctx: CustomerObservabilityContext,
    raw: unknown,
  ): Promise<AdminCustomerAccountsPage> {
    const q = adminCustomerAccountsQuerySchema.parse(raw);
    return this.admin(ctx, null, "accounts", async (tx) => {
      const rows = (
        await tx.query<SummaryRow>(
          `select ${summaryFields} ${summaryFrom} where ($1::text is null or strpos(lower(c.email),lower($1::text))>0 or strpos(coalesce(u.username,''),lower($1::text))>0 or u.id::text=$1::text) and u.id>coalesce($2::bigint,0) order by u.id limit $3`,
          [q.search ?? null, q.afterUserId ?? null, q.limit + 1],
        )
      ).rows;
      const accounts = rows.slice(0, q.limit).map(summary);
      return {
        value: {
          accounts,
          nextAfterUserId:
            rows.length > q.limit ? accounts.at(-1)!.userId : null,
        },
        count: accounts.length,
      };
    });
  }
  async detail(
    ctx: CustomerObservabilityContext,
    userId: string,
  ): Promise<AdminCustomerAccount> {
    return this.admin(ctx, userId, "account", async (tx) => {
      const row = (
        await tx.query<SummaryRow>(
          `select ${summaryFields} ${summaryFrom} where u.id=$1`,
          [userId],
        )
      ).rows[0];
      if (!row) throw missing();
      const profile =
        (
          await tx.query<NonNullable<AdminCustomerAccount["profile"]>>(
            `select origin_city as "originCity",target_city as "targetCity",monthly_budget::text as "monthlyBudget",move_target_date::text as "moveTargetDate" from relocation_profiles where user_id=$1`,
            [userId],
          )
        ).rows[0] ?? null;
      const counts = (
        await tx.query<{ favoritesCount: number; activeSessions: number }>(
          `select (select count(*)::integer from agent_threads t join messages m on m.thread_id=t.id where t.user_id=$1 and m.role in('user','assistant') and m.metadata->'citygoFavorite'='true'::jsonb) as "favoritesCount",(select count(*)::integer from sessions where user_id=$1 and expires_at>clock_timestamp()) as "activeSessions"`,
          [userId],
        )
      ).rows[0]!;
      const plan = await planPage(tx, userId, undefined, 50);
      return {
        value: {
          account: summary(row),
          analyticsUserId: null,
          profile,
          personalPlan: { items: plan.items, nextBeforeId: plan.nextBeforeId },
          ...counts,
        },
        count: 1,
      };
    });
  }
  async conversations(
    ctx: CustomerObservabilityContext,
    userId: string,
    raw: unknown,
  ): Promise<AdminCustomerConversationsPage> {
    const q = adminCustomerPageQuerySchema.parse(raw);
    return this.admin(ctx, userId, "conversations", async (tx) => {
      const rows = (
        await tx.query<AdminCustomerConversationsPage["conversations"][number]>(
          `select t.id::text,t.agent_key as "agentKey",t.conversation_agent_key as "assistantKey",t.status,${utc("t.created_at")} as "createdAt",${utc("(select max(m.created_at)from messages m where m.thread_id=t.id and m.role in('user','assistant'))")} as "lastMessageAt",(select count(*)::integer from messages m where m.thread_id=t.id and m.role in('user','assistant')) as "messageCount" from agent_threads t where t.user_id=$1 and ($2::bigint is null or t.id<$2::bigint) order by t.id desc limit $3`,
          [userId, q.before ?? null, q.limit + 1],
        )
      ).rows;
      const conversations = rows.slice(0, q.limit);
      return {
        value: {
          userId,
          conversations,
          nextBeforeId: rows.length > q.limit ? conversations.at(-1)!.id : null,
        },
        count: conversations.length,
      };
    });
  }
  async messages(
    ctx: CustomerObservabilityContext,
    userId: string,
    conversationId: string,
    raw: unknown,
  ): Promise<AdminCustomerMessagesPage> {
    customerAccountIdSchema.parse(conversationId);
    const q = adminCustomerMessagesQuerySchema.parse(raw);
    return this.admin(
      ctx,
      userId,
      "messages",
      async (tx) => {
        if (
          (
            await tx.query(
              "select id from agent_threads where id=$1 and user_id=$2",
              [conversationId, userId],
            )
          ).rows.length !== 1
        )
          throw missing();
        const rows = (
          await tx.query<AdminCustomerMessagesPage["messages"][number]>(
            `select m.id::text,m.role,m.content,${utc("m.created_at")} as "createdAt" from messages m join agent_threads t on t.id=m.thread_id where t.user_id=$1 and t.id=$2 and m.role in('user','assistant') and ($3::bigint is null or m.id<$3::bigint) order by m.id desc limit $4`,
            [userId, conversationId, q.before ?? null, q.limit + 1],
          )
        ).rows;
        const page = bounded(rows, q.limit);
        return {
          value: {
            userId,
            conversationId,
            messages: page.values.reverse(),
            nextBeforeId: page.next,
          },
          count: page.values.length,
        };
      },
      conversationId,
    );
  }
  async favorites(
    ctx: CustomerObservabilityContext,
    userId: string,
    raw: unknown,
  ): Promise<AdminCustomerFavoritesPage> {
    const q = adminCustomerPageQuerySchema.parse(raw);
    return this.admin(ctx, userId, "favorites", async (tx) => {
      const rows = (
        await tx.query<AdminCustomerFavoritesPage["items"][number]>(
          `select m.id::text,m.id::text as "messageId",t.id::text as "conversationId",m.role,m.content,${utc("m.created_at")} as "createdAt" from agent_threads t join messages m on m.thread_id=t.id where t.user_id=$1 and m.role in('user','assistant') and m.metadata->'citygoFavorite'='true'::jsonb and ($2::bigint is null or m.id<$2::bigint) order by m.id desc limit $3`,
          [userId, q.before ?? null, q.limit + 1],
        )
      ).rows;
      const page = bounded(rows, q.limit);
      return {
        value: { userId, items: page.values, nextBeforeId: page.next },
        count: page.values.length,
      };
    });
  }
  async plan(
    ctx: CustomerObservabilityContext,
    userId: string,
    raw: unknown,
  ): Promise<AdminCustomerPlanPage> {
    const q = adminCustomerPageQuerySchema.parse(raw);
    return this.admin(ctx, userId, "plan", async (tx) => {
      const value = await planPage(tx, userId, q.before, q.limit);
      return { value, count: value.items.length };
    });
  }
  async activity(
    ctx: CustomerObservabilityContext,
    userId: string,
    raw: unknown,
  ): Promise<AdminCustomerActivityPage> {
    const q = adminCustomerActivityQuerySchema.parse(raw),
      cursor = decodeCursor(q.before);
    return this.admin(ctx, userId, "activity", async (tx) => {
      const rows = (
        await tx.query<ActivityRow>(
          `with events as(
       select 1 as source,u.id as source_id,'registered'::text as kind,u.created_at as occurred_at,null::bigint as thread_id,null::bigint as message_id,null::bigint as amount from users u where u.id=$1
       union all select 2,e.user_id,'email_verified',e.verified_at,null::bigint,null::bigint,null::bigint from account_email_verifications e where e.user_id=$1
       union all select 3,m.id,case when m.role='user'then'message_sent'else'assistant_replied'end,m.created_at,t.id,m.id,null::bigint from messages m join agent_threads t on t.id=m.thread_id where t.user_id=$1 and m.role in('user','assistant')
       union all select 4,e.id,'credit_'||e.kind,e.created_at,null::bigint,null::bigint,e.amount_micros from ai_credit_entries e where e.user_id=$1 and e.kind in('bonus','topup','settle')
       union all select 5,p.id,'plan_created',p.created_at,null::bigint,p.source_message_id,null::bigint from personal_plan_items p where p.user_id=$1
       union all select 6,e.id,'ui_'||substring(e.name from 4),e.created_at,null::bigint,null::bigint,null::bigint from analytics_events e where e.user_id=$1 and e.name=any($2::text[])
       union all select 7,b.user_id,'phone_verified',b.claimed_at,null::bigint,null::bigint,null::bigint from phone_welcome_claims b where b.user_id=$1
       union all select 8,e.sequence,'refund_'||e.action,e.created_at,null::bigint,null::bigint,r.amount_kopeks*10000 from payment_refund_events e join payment_refunds r on r.id=e.refund_id where r.user_id=$1
       union all select 9,p.id,case when p.deleted_at is null then'plan_updated'else'plan_deleted'end,p.updated_at,null::bigint,p.source_message_id,null::bigint from personal_plan_items p where p.user_id=$1 and p.revision>1)
       select source,source_id::text as "sourceId",kind,${utc("occurred_at")} as "occurredAt",thread_id::text as "conversationId",message_id::text as "messageId",amount::text as "amountMicros" from events
       where ($3::timestamptz is null or (occurred_at,source,source_id)<($3::timestamptz,$4::integer,$5::bigint)) order by occurred_at desc,source desc,source_id desc limit $6`,
          [
            userId,
            customerInteractionNameSchema.options.map((n) => "ui_" + n),
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            cursor?.[2] ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
      const selected = rows.slice(0, q.limit),
        last = selected.at(-1);
      const labels: Record<string, string> = {
        registered: "Создал аккаунт",
        email_verified: "Подтвердил почту",
        phone_verified: "Подтвердил телефон",
        message_sent: "Написал сообщение",
        assistant_replied: "Получил ответ помощника",
        credit_bonus: "Получил подарок",
        credit_topup: "Пополнил баланс",
        credit_settle: "Расчёт за ответ помощника",
        plan_created: "Добавил шаг в план",
        plan_updated: "Последнее изменение шага плана",
        plan_deleted: "Последнее изменение: удалил шаг плана",
        refund_reserved: "Запрошен возврат",
        refund_dispatch_started: "Возврат отправлен",
        refund_provider_observed: "Получен статус возврата",
        refund_review_required: "Проверка возврата",
        refund_dispatch_failed: "Не удалось отправить возврат",
      };
      const events = selected.map((row) => ({
        id: row.source + ":" + row.sourceId,
        kind: row.kind,
        label: row.kind.startsWith("ui_")
          ? uiLabels[row.kind.slice(3)]!
          : labels[row.kind]!,
        occurredAt: row.occurredAt,
        conversationId: row.conversationId,
        messageId: row.messageId,
        amountMicros:
          row.amountMicros === null ? null : Number(row.amountMicros),
      }));
      return {
        value: {
          userId,
          events,
          nextCursor:
            rows.length > q.limit && last
              ? Buffer.from(
                  JSON.stringify([last.occurredAt, last.source, last.sourceId]),
                ).toString("base64url")
              : null,
        },
        count: events.length,
      };
    });
  }
  async funnel(
    ctx: CustomerObservabilityContext,
    raw: unknown,
  ): Promise<AdminCustomerFunnel> {
    const q = adminCustomerFunnelQuerySchema.parse(raw);
    return this.admin(ctx, null, "funnel", async (tx) => {
      await tx.exec("set local timezone='UTC'");
      const clock = (
        await tx.query<{ from: string; to: string }>(
          `select ${utc("clock_timestamp()-$1::integer*interval '1 day'")} as "from",${utc("clock_timestamp()")} as "to"`,
          [q.days],
        )
      ).rows[0]!;
      const totals = (
        await tx.query<Record<string, number>>(
          `with cohort as(select id from users where created_at>=$1::timestamptz and created_at<=$2::timestamptz)
       select count(*)::integer as registered,
       count(*)filter(where exists(select 1 from account_email_verifications e where e.user_id=c.id and e.verified_at<=$2::timestamptz))::integer as email_verified,
       count(*)filter(where exists(select 1 from phone_welcome_claims p where p.user_id=c.id and p.claimed_at<=$2::timestamptz))::integer as phone_verified,
       count(*)filter(where exists(select 1 from ai_credit_entries e where e.user_id=c.id and e.kind='bonus' and e.created_at<=$2::timestamptz))::integer as gift_granted,
       count(*)filter(where exists(select 1 from agent_threads t join messages m on m.thread_id=t.id where t.user_id=c.id and m.role='user' and m.created_at<=$2::timestamptz))::integer as first_request,
       count(*)filter(where exists(select 1 from agent_threads t join messages m on m.thread_id=t.id where t.user_id=c.id and m.role='assistant' and coalesce(m.metadata->>'status','complete')='complete'and m.created_at<=$2::timestamptz))::integer as first_reply,
       count(*)filter(where exists(select 1 from ai_credit_topups p where p.user_id=c.id and not p.test and p.created_at<=$2::timestamptz))::integer as paid_topup,
       count(*)filter(where (select count(distinct(m.created_at at time zone 'UTC')::date)from agent_threads t join messages m on m.thread_id=t.id where t.user_id=c.id and m.role='user'and m.created_at<=$2::timestamptz)>=2)::integer as repeated_usage from cohort c`,
          [clock.from, clock.to],
        )
      ).rows[0]!;
      const recentActivity = (
        await tx.query<AdminCustomerFunnel["recentActivity"][number]>(
          `with days as(select generate_series(date_trunc('day',$1::timestamptz),date_trunc('day',$2::timestamptz),interval'1 day')as day),activity as(select m.created_at,m.role,t.user_id from messages m join agent_threads t on t.id=m.thread_id where m.role in('user','assistant')and m.created_at>=$1::timestamptz and m.created_at<=$2::timestamptz)
       select to_char(d.day at time zone 'UTC','YYYY-MM-DD')as day,
       (select count(distinct a.user_id)::integer from activity a where a.created_at>=d.day and a.created_at<d.day+interval'1 day')as "activeUsers",
       (select count(*)::integer from activity a where a.role='user'and a.created_at>=d.day and a.created_at<d.day+interval'1 day')as "userMessages",
       (select count(*)::integer from activity a where a.role='assistant'and a.created_at>=d.day and a.created_at<d.day+interval'1 day')as "assistantMessages",
       (select coalesce(sum(p.credited_micros),0)::float8 from ai_credit_topups p where not p.test and p.created_at>=greatest(d.day,$1::timestamptz)and p.created_at<least(d.day+interval'1 day',$2::timestamptz))as "paidMicros" from days d order by d.day`,
          [clock.from, clock.to],
        )
      ).rows;
      const labels: Record<string, string> = {
        registered: "Регистрация",
        email_verified: "Почта подтверждена",
        phone_verified: "Телефон подтверждён",
        gift_granted: "Подарок получен",
        first_request: "Первый вопрос",
        first_reply: "Первый успешный ответ",
        paid_topup: "Оплаченное пополнение",
        repeated_usage: "Вернулся в другой день",
      };
      return {
        value: {
          days: q.days,
          ...clock,
          basis: "registered_cohort",
          steps: Object.entries(labels).map(([key, label]) => ({
            key,
            label,
            users: totals[key]!,
          })),
          recentActivity,
        },
        count: 8,
      };
    });
  }
  async recordInteraction(ctx: CustomerObservabilityContext, raw: unknown) {
    const input = customerInteractionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const actor = await authorize(tx, ctx, false);
      await tx.query(
        "insert into analytics_events(user_id,name)values($1,$2)",
        [actor.userId, "ui_" + input.event],
      );
      return { recorded: true as const };
    });
  }
  async checkIdentity(ctx: CustomerObservabilityContext) {
    return this.db.transaction(async (tx) => {
      await authorize(tx, ctx, false);
      return ctx.userId;
    });
  }
}
