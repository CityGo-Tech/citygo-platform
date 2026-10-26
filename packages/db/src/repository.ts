import type { Database, Sql } from "./index.js";
import type {
  AgentKey,
  Dashboard,
  Message,
  Questionnaire,
  Quest,
  ModelGeneration,
  AiPolicy,
  AiRouting,
  AiRoutingAudit,
  AiRoutingInput,
  AiAttemptOverview,
  AiProviderId,
  AiExecution,
  AiBudgetInput,
  ApiErrorCode,
  QuestPlanReference,
  CityGoTariffSnapshot,
  ConversationList,
  ConversationSummary,
  ConversationMessagesPage,
} from "@citygo/contracts";
import {
  LEGACY_AT_COST_TARIFF,
  conversationIdSchema,
  conversationHistoryIdSchema,
} from "@citygo/contracts";
import { randomUUID } from "node:crypto";
import { canTransitionQuest } from "@citygo/domain";
import { DomainError } from "./errors.js";
import { currentQuestPlan, lockQuestPlan } from "./quest-plans.js";
import { AiCreditLedger } from "./ai-credit.js";
import {
  AiCreditCharges,
  type AiCreditReservationMode,
} from "./ai-credit-charges.js";
import { lockPaymentMode } from "./payment-isolation.js";
import {
  aiBudget,
  aiUserBudget,
  changeAiBudget,
  reserveAiMoney,
} from "./ai-budget.js";

import {
  parseAiRequestModeSnapshot,
  recordAiRequestMode,
  assertAiRequestModeAttempt,
  type AiRequestModeSnapshot,
  type AiRequestModeDescriptor,
} from "./ai-request-modes.js";
import {
  GigaChatFixedFees,
  parseGigaChatFixedFeeInput,
  type GigaChatFixedFeeInput,
} from "./gigachat-fixed-fees.js";

export { DomainError } from "./errors.js";
const fail = (
  status: number,
  message: string,
  code?: ApiErrorCode,
  currentVersion?: number,
): never => {
  throw new DomainError(status, message, code, currentVersion);
};
type User = { id: string; email: string; password_hash: string };
type Thread = {
  id: string;
  agent_key: AgentKey;
  conversation_agent_key: AgentKey | null;
  busy_until: string | null;
};
export class Repository {
  constructor(
    public db: Database,
    private creditCharging = false,
    private creditTariff: CityGoTariffSnapshot = LEGACY_AT_COST_TARIFF,
    private topUpAvailable: boolean | (() => Promise<boolean>) = false,
    private creditReservationMode: AiCreditReservationMode = "full",
    private includeGigaFixedFees = false,
  ) {}
  aiBudget(executions: AiExecution[]) {
    return aiBudget(this.db, executions);
  }
  changeAiBudget(
    userId: string,
    input: AiBudgetInput,
    executions: AiExecution[],
  ) {
    return changeAiBudget(this.db, userId, input, executions);
  }
  async reserveAiAttempt(input: {
    userId: string;
    threadId: string;
    requestId: string;
    lease: string;
    attemptNumber: number;
    provider: AiProviderId;
    model: string;
    policyId: string;
    routingRevision: number;
    userDailyLimit: number;
    globalDailyLimit: number;
    execution: AiExecution;
    upstream?: string;
    consentPolicyId?: string;
    mode?: AiRequestModeDescriptor;
    fixedFee?: GigaChatFixedFeeInput;
  }) {
    // A caller may update its selector after send. Copy the accepted attempt
    // values before awaiting any transaction so that cannot retarget this call.
    input = {
      ...input,
      execution: structuredClone(input.execution),
      ...(input.mode === undefined ? {} : { mode: { ...input.mode } }),
      ...(input.fixedFee === undefined
        ? {}
        : { fixedFee: parseGigaChatFixedFeeInput(input.fixedFee) }),
    };
    const consentPolicyId = input.consentPolicyId ?? input.policyId;
    if (
      input.fixedFee !== undefined &&
      (!this.creditCharging ||
        this.creditTariff.version !== "citygo-10x-v1" ||
        this.creditReservationMode !== "fixed5_overdraft" ||
        input.provider !== "gigachat" ||
        input.model !== "GigaChat-3-Ultra" ||
        input.attemptNumber !== 1 ||
        input.upstream !== undefined ||
        input.mode?.id !== "minimum")
    )
      fail(
        503,
        "Для этого режима условия оплаты не подключены.",
        "AI_CREDIT_UNAVAILABLE",
      );
    if (
      this.creditCharging &&
      input.fixedFee === undefined &&
      (input.provider !== "routerai" ||
        input.attemptNumber !== 1 ||
        !input.upstream)
    )
      fail(
        503,
        "Для этого провайдера списание с баланса не подключено.",
        "AI_CREDIT_UNAVAILABLE",
      );
    if (
      !Number.isInteger(input.attemptNumber) ||
      input.attemptNumber < 1 ||
      input.attemptNumber > 2
    )
      fail(
        429,
        "Допустимое число попыток ответа исчерпано.",
        "AI_QUOTA_EXHAUSTED",
      );
    if (input.userDailyLimit === 0 || input.globalDailyLimit === 0)
      fail(503, "Обращения к AI временно отключены администратором.");
    return this.db.transaction(async (tx) => {
      // Isolation security -> user -> thread -> daily-counter order. Do not lock
      // current routing: an admitted answer keeps its pinned recipient.
      await lockPaymentMode(tx, "real");
      await tx.query("select id from users where id=$1 for update", [
        input.userId,
      ]);
      const owner = await tx.query(
        "select id from agent_threads where id=$1 and user_id=$2 and lease_token=$3 and busy_until>clock_timestamp() for update",
        [input.threadId, input.userId, input.lease],
      );
      if (!owner.rows.length) fail(409, "Запрос AI устарел.");
      const request = await tx.query(
        "select request_id from chat_requests where thread_id=$1 and request_id=$2 and status='running' and ai_policy_id=$3 and ai_routing_revision=$4",
        [
          input.threadId,
          input.requestId,
          consentPolicyId,
          input.routingRevision,
        ],
      );
      if (!request.rows.length) fail(409, "Запрос AI устарел.");
      if (
        input.execution.policy.id !== input.policyId ||
        input.execution.policy.provider !== input.provider ||
        input.execution.policy.model !== input.model
      )
        fail(409, "Денежный резерв не соответствует запросу.");
      const frozenMode = await assertAiRequestModeAttempt(tx, {
        userId: input.userId,
        threadId: input.threadId,
        requestId: input.requestId,
        consentPolicyId,
        policyId: input.policyId,
        routingRevision: input.routingRevision,
        provider: input.provider,
        model: input.model,
        execution: input.execution,
        upstream: input.upstream,
        mode: input.mode,
      });
      if (input.fixedFee !== undefined && !frozenMode)
        fail(409, "Режим ответа не закреплён за запросом.");
      const previous = (
        await tx.query<{
          attempt_number: number;
          provider: string;
          model: string;
        }>(
          "select attempt_number,provider,model from ai_model_attempts where thread_id=$1 and request_id=$2 order by attempt_number desc limit 1",
          [input.threadId, input.requestId],
        )
      ).rows[0];
      if (
        (previous?.attempt_number ?? 0) + 1 !== input.attemptNumber ||
        (previous &&
          (previous.provider !== input.provider ||
            previous.model !== input.model))
      )
        fail(409, "Попытка AI уже учтена или не соответствует запросу.");
      const day = (
        await tx.query<{ day: string }>(
          "select (now() at time zone 'UTC')::date::text as day",
        )
      ).rows[0]!.day;
      await tx.query(
        "insert into ai_model_attempt_daily(usage_day,user_limit,global_limit) values ($1,$2,$3) on conflict do nothing",
        [day, input.userDailyLimit, input.globalDailyLimit],
      );
      const global = (
        await tx.query<{
          reserved_attempts: number;
          user_limit: number;
          global_limit: number;
        }>(
          "select reserved_attempts,user_limit,global_limit from ai_model_attempt_daily where usage_day=$1 for update",
          [day],
        )
      ).rows[0]!;
      // The first reservation pins today's limits across replicas. A different
      // configuration fails closed; it cannot silently raise/reset the cap.
      if (
        global.user_limit !== input.userDailyLimit ||
        global.global_limit !== input.globalDailyLimit
      )
        fail(
          503,
          "Лимиты AI не согласованы между серверами. Обратитесь к администратору.",
        );
      const personal =
        (
          await tx.query<{ reserved_attempts: number }>(
            "select reserved_attempts from ai_user_model_attempt_daily where user_id=$1 and usage_day=$2",
            [input.userId, day],
          )
        ).rows[0]?.reserved_attempts ?? 0;
      if (
        global.reserved_attempts >= input.globalDailyLimit ||
        personal >= input.userDailyLimit
      )
        fail(
          429,
          "Суточный лимит обращений к AI исчерпан. Попробуйте после 00:00 UTC.",
          "AI_QUOTA_EXHAUSTED",
        );
      await tx.query(
        "update ai_model_attempt_daily set reserved_attempts=reserved_attempts+1 where usage_day=$1",
        [day],
      );
      await tx.query(
        "insert into ai_user_model_attempt_daily(user_id,usage_day,reserved_attempts) values ($1,$2,1) on conflict(user_id,usage_day) do update set reserved_attempts=ai_user_model_attempt_daily.reserved_attempts+1",
        [input.userId, day],
      );
      // A fixed product fee with free provider cost is never represented as a
      // RouterAI price/rule. The global administrative stop still applies.
      const money =
        input.fixedFee === undefined
          ? await reserveAiMoney(tx, input.execution, input.userId)
          : null;
      if (input.fixedFee !== undefined) {
        const budget = (
          await tx.query<{ enabled: boolean }>(
            "select enabled from ai_budget where id=1 for share",
          )
        ).rows[0];
        if (!budget?.enabled)
          fail(
            503,
            "Обращения к ИИ временно отключены.",
            "AI_BUDGET_UNAVAILABLE",
          );
      }
      // The explicit uncapped operator mode is only for the approved paid ×10
      // flow, never a way for an old/no-charge API process to consume RouterAI
      // without reserving user credit. Use the mode read under the budget lock;
      // refusal rolls back every quota and monetary counter in this transaction.
      if (
        money?.budgetMode === "routerai_balance" &&
        (!this.creditCharging || this.creditTariff.version !== "citygo-10x-v1")
      )
        fail(
          503,
          "Для режима баланса RouterAI нужны списания CityGo по тарифу ×10.",
          "AI_CREDIT_UNAVAILABLE",
        );
      if (this.creditCharging && money && money.currency !== "RUB")
        fail(
          503,
          "Для баланса AI нужен бюджет оператора в RUB.",
          "AI_CREDIT_UNAVAILABLE",
        );
      await tx.query(
        "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key,reserved_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13::timestamptz,clock_timestamp()))",
        [
          input.threadId,
          input.requestId,
          input.attemptNumber,
          input.userId,
          input.provider,
          input.model,
          input.policyId,
          input.routingRevision,
          money?.currency ?? null,
          money?.amountMicros ?? null,
          money?.revision ?? null,
          money?.ruleKey ?? null,
          money?.reservedAt ?? null,
        ],
      );
      if (input.fixedFee !== undefined && frozenMode)
        return new GigaChatFixedFees(this.db).reserve(tx, {
          userId: input.userId,
          threadId: input.threadId,
          requestId: input.requestId,
          chatLease: input.lease,
          catalogId: frozenMode.catalogId,
          executionKey: input.execution.key,
          pricing: input.fixedFee,
        });
      return this.creditCharging
        ? new AiCreditCharges(
            this.db,
            this.creditTariff,
            this.creditReservationMode,
          ).reserve(
            tx,
            {
              userId: input.userId,
              threadId: input.threadId,
              requestId: input.requestId,
              model: input.model,
              upstream: input.upstream!,
            },
            money!.amountMicros,
          )
        : null;
    });
  }
  async aiAttemptOverview(
    userDailyLimit: number,
    globalDailyLimit: number,
  ): Promise<AiAttemptOverview> {
    const today = (
      await this.db.query<{
        day: string;
        reserved: number;
        user_limit: number | null;
        global_limit: number | null;
      }>(
        `select d.day::text,coalesce(a.reserved_attempts,0) as reserved,a.user_limit,a.global_limit
       from (select (now() at time zone 'UTC')::date as day) d
       left join ai_model_attempt_daily a on a.usage_day=d.day`,
      )
    ).rows[0]!;
    const recent = (
      await this.db.query<AiAttemptOverview["recent"][number]>(
        `select a.user_id::text as "userId",a.thread_id::text as "threadId",a.request_id::text as "requestId",
       a.attempt_number as "attemptNumber",a.provider,a.model,a.routing_revision as "routingRevision",
       to_char(a.reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "reservedAt",r.status as "requestStatus",
       case when a.money_currency is null then null else jsonb_build_object('currency',a.money_currency,'amountMicros',a.money_reserved_micros,'revision',a.money_budget_revision,'ruleKey',a.money_rule_key) end as money
       from ai_model_attempts a join chat_requests r using(thread_id,request_id)
       order by a.reserved_at desc,a.thread_id desc,a.request_id desc,a.attempt_number desc limit 20`,
      )
    ).rows;
    return {
      day: today.day,
      reservedToday: today.reserved,
      userDailyLimit,
      globalDailyLimit,
      maxPerRequest: 2,
      pinnedLimits:
        today.user_limit === null
          ? null
          : {
              userDailyLimit: today.user_limit,
              globalDailyLimit: today.global_limit!,
            },
      configurationMatches:
        today.user_limit === null ||
        (today.user_limit === userDailyLimit &&
          today.global_limit === globalDailyLimit),
      recent,
    };
  }
  async initializeAiRouting(policy: AiPolicy | null) {
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query<AiRouting>(
        'insert into ai_routing(id,provider,policy_id,revision) values (1,$1,$2,1) on conflict do nothing returning provider,policy_id as "policyId",revision',
        [policy?.provider ?? "disabled", policy?.id ?? null],
      );
      if (inserted.rows[0])
        await tx.query(
          "insert into audit_log(action,entity_type,entity_id,payload) values ('ai-routing-initialized','ai-routing','1',$1)",
          [JSON.stringify({ from: null, to: inserted.rows[0], policy })],
        );
    });
  }
  async aiRouting(tx: Sql = this.db): Promise<AiRouting> {
    return (
      (
        await tx.query<AiRouting>(
          'select provider,policy_id as "policyId",revision from ai_routing where id=1',
        )
      ).rows[0] ?? fail(503, "Настройка AI не готова")
    );
  }
  async aiRoutingAudit(): Promise<AiRoutingAudit[]> {
    return (
      await this.db.query<AiRoutingAudit>(
        `select id::text,actor_user_id::text as "actorUserId",created_at::text as "createdAt",payload
       from audit_log where entity_type='ai-routing' and entity_id='1' order by id desc limit 20`,
      )
    ).rows;
  }
  async changeAiRouting(
    userId: string,
    input: AiRoutingInput,
    policy: AiPolicy | null,
  ): Promise<AiRouting> {
    if (
      input.provider === "disabled"
        ? policy !== null
        : !policy ||
          policy.id !== input.policyId ||
          policy.provider !== input.provider
    )
      fail(409, "Описание AI-получателя не соответствует выбору");
    return this.db.transaction(async (tx) => {
      await tx.query("select id from ai_routing where id=1 for update");
      const current = await this.aiRouting(tx);
      if (current.revision !== input.expectedRevision)
        fail(
          409,
          "Настройка AI уже изменена. Обновите её и подтвердите выбор заново.",
          "REVISION_CONFLICT",
          current.revision,
        );
      if (
        current.provider === input.provider &&
        current.policyId === input.policyId
      )
        return current;
      const next = (
        await tx.query<AiRouting>(
          'update ai_routing set provider=$1,policy_id=$2,revision=revision+1 where id=1 returning provider,policy_id as "policyId",revision',
          [input.provider, input.policyId],
        )
      ).rows[0]!;
      await tx.query(
        "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-routing-changed','ai-routing','1',$2)",
        [userId, JSON.stringify({ from: current, to: next, policy })],
      );
      return next;
    });
  }
  private async guardAiRouting(tx: Sql, revision: number, policyId: string) {
    // Shared reads allow concurrent admissions. A switch takes the exclusive
    // lock; both finish before any provider I/O. Always lock routing before users.
    const current = (
      await tx.query<AiRouting>(
        'select provider,policy_id as "policyId",revision from ai_routing where id=1 for share',
      )
    ).rows[0];
    if (
      !current ||
      current.provider === "disabled" ||
      current.revision !== revision ||
      current.policyId !== policyId
    )
      fail(
        409,
        "AI-получатель изменился. Обновите страницу и проверьте условия.",
        "AI_POLICY_CHANGED",
      );
  }
  async register(email: string, passwordHash: string) {
    return this.db.transaction(async (tx) => {
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject) values ($1) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,$2,$3)",
        [user.id, email, passwordHash],
      );
      return user.id;
    });
  }
  async credentials(email: string): Promise<User | undefined> {
    return (
      await this.db.query<User>(
        "select u.id::text,c.email,c.password_hash from users u join user_credentials c on c.user_id=u.id where c.email=$1 and u.status='active'",
        [email],
      )
    ).rows[0];
  }
  async session(tokenHash: string) {
    return (
      await this.db.query<{ id: string; email: string }>(
        "select u.id::text,c.email from sessions s join users u on u.id=s.user_id join user_credentials c on c.user_id=u.id where s.token_hash=$1 and s.expires_at>now() and u.status='active'",
        [tokenHash],
      )
    ).rows[0];
  }
  async createSession(userId: string, tokenHash: string) {
    await this.db.query(
      "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,now()+interval '7 days')",
      [tokenHash, userId],
    );
  }
  async logout(tokenHash: string) {
    await this.db.query("delete from sessions where token_hash=$1", [
      tokenHash,
    ]);
  }
  async dashboard(
    user: { id: string; email: string },
    provider: Dashboard["provider"],
    policy: AiPolicy | null,
    dailyLimit: number,
  ): Promise<Dashboard> {
    // Admission status may read through this.db. Resolve before taking the user
    // snapshot/transaction, including PGlite's single-connection transaction.
    // This hint never replaces the order's atomic live-checkout admission.
    const topUpAvailable =
      typeof this.topUpAvailable === "function"
        ? await this.topUpAvailable()
        : this.topUpAvailable;
    return this.db.transaction(async (tx) => {
      // Stable plan/quest snapshot relative to start, completion and replacement.
      await tx.query("select id from users where id=$1 for share", [user.id]);
      const plan = await currentQuestPlan(tx, user.id);
      const profile =
        (
          await tx.query<{ preferences: Questionnaire }>(
            "select preferences from relocation_profiles where user_id=$1",
            [user.id],
          )
        ).rows[0]?.preferences ?? null;
      const xp = (
        await tx.query<{ xp: number }>(
          "select coalesce(sum(points),0)::integer as xp from xp_events where user_id=$1",
          [user.id],
        )
      ).rows[0]!.xp;
      const quests = (
        await tx.query<Quest>(
          `select uq.id::text,q.slug,q.title,uq.state,q.xp_reward as "xpReward",
           jsonb_build_object('id',uq.plan_id::text,'version',uq.plan_version) as plan
           from user_quests uq join quests q on q.id=uq.quest_id
           where uq.user_id=$1 and uq.plan_id=$2 and uq.plan_version=$3 order by q.id`,
          [user.id, plan?.id ?? null, plan?.version ?? null],
        )
      ).rows;
      const thread = (
        await tx.query<Thread>(
          "select id::text,agent_key,conversation_agent_key from agent_threads where user_id=$1 and status<>'closed' and conversation_agent_key is null",
          [user.id],
        )
      ).rows[0];
      const messages = thread ? await this.history(tx, thread.id) : [];
      return {
        user,
        profile,
        xp,
        quests,
        thread: thread
          ? {
              id: thread.id,
              agentKey: thread.agent_key,
              assistantKey: null,
              closed: false,
              messages,
            }
          : null,
        provider,
        aiAccess: {
          credit: await new AiCreditLedger(
            this.db,
            this.creditCharging
              ? this.creditTariff.version === "citygo-10x-v1"
                ? "routerai_citygo_10x"
                : "routerai_at_cost"
              : "not_connected",
            topUpAvailable,
            this.creditReservationMode,
            this.includeGigaFixedFees,
          ).status(user.id, tx),
          budget: await aiUserBudget(tx, user.id),
          policy,
          granted: policy
            ? await this.hasAiConsent(tx, user.id, policy.id)
            : false,
          dailyLimit,
        },
      };
    });
  }
  async conversations(
    userId: string,
    beforeId?: string,
  ): Promise<ConversationList> {
    if (
      !conversationIdSchema.safeParse(userId).success ||
      (beforeId !== undefined &&
        !conversationIdSchema.safeParse(beforeId).success)
    )
      fail(400, "Недопустимый идентификатор диалога");
    // One bounded owner-scoped statement. The cursor is the original bigint ID,
    // not a timestamp, OFFSET or a JavaScript Number. Closed history is retained.
    const rows = (
      await this.db.query<ConversationSummary>(
        `select t.id::text,t.agent_key as "agentKey",t.conversation_agent_key as "assistantKey",
          (t.status='closed') as closed,
          to_char(t.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
          coalesce((select left(m.content,240) from messages m where m.thread_id=t.id
            and m.role in ('user','assistant') order by m.id desc limit 1),'') as preview
         from agent_threads t where t.user_id=$1 and ($2::bigint is null or t.id<$2::bigint)
         order by t.id desc limit 21`,
        [userId, beforeId ?? null],
      )
    ).rows;
    const conversations = rows.slice(0, 20).map((row) => {
      // SQL left() counts Unicode codepoints; JS/contracts count UTF-16 units.
      // Preserve whole codepoints while bounding the public preview to 240 units.
      let preview = "";
      for (const point of row.preview) {
        if (preview.length + point.length > 240) break;
        preview += point;
      }
      return { ...row, preview };
    });
    return {
      userId,
      conversations,
      nextCursor: rows.length > 20 ? conversations.at(-1)!.id : null,
    };
  }
  async conversation(userId: string, threadId: string) {
    if (
      !conversationIdSchema.safeParse(userId).success ||
      !conversationIdSchema.safeParse(threadId).success
    )
      fail(400, "Недопустимый идентификатор диалога");
    return this.db.transaction(async (tx) => {
      // Same owner -> thread order as creation/admission. A thread share lock
      // keeps the header and its bounded message history mutually consistent.
      await tx.query("select id from users where id=$1 for share", [userId]);
      const thread = (
        await tx.query<{
          id: string;
          agentKey: AgentKey;
          assistantKey: AgentKey | null;
          closed: boolean;
        }>(
          `select t.id::text,t.agent_key as "agentKey",t.conversation_agent_key as "assistantKey",
            (t.status='closed') as closed
           from agent_threads t join users u on u.id=t.user_id
           where t.id=$2 and u.id=$1 for share of t`,
          [userId, threadId],
        )
      ).rows[0];
      if (!thread) fail(404, "Чат не найден");
      return {
        userId,
        thread: { ...thread, messages: await this.history(tx, threadId) },
      };
    });
  }
  async conversationMessages(
    userId: string,
    threadId: string,
    beforeId?: string,
  ): Promise<ConversationMessagesPage> {
    if (
      !conversationHistoryIdSchema.safeParse(userId).success ||
      !conversationHistoryIdSchema.safeParse(threadId).success ||
      (beforeId !== undefined &&
        !conversationHistoryIdSchema.safeParse(beforeId).success)
    )
      fail(400, "Недопустимый идентификатор диалога");
    return this.db.transaction(async (tx) => {
      // Match conversation creation/admission's user -> thread lock order.
      // This short transaction has no model, money or other external work.
      const owner = (
        await tx.query<{ status: string; must_change_password: boolean }>(
          "select status,must_change_password from users where id=$1 for share",
          [userId],
        )
      ).rows[0];
      if (!owner) return fail(404, "Чат не найден");
      if (owner.status !== "active") fail(403, "Аккаунт недоступен");
      if (owner.must_change_password)
        fail(403, "Сначала измените временный пароль");
      const thread = (
        await tx.query(
          "select id from agent_threads where id=$2 and user_id=$1 for share",
          [userId, threadId],
        )
      ).rows[0];
      if (!thread) fail(404, "Чат не найден");
      if (
        beforeId !== undefined &&
        !(
          await tx.query(
            "select id from messages where id=$2 and thread_id=$1 and role in ('user','assistant')",
            [threadId, beforeId],
          )
        ).rows.length
      )
        fail(404, "Чат не найден");
      // Keyset by the original bigint, not timestamps, OFFSET or Number.
      // 101 is only a lookahead; never return more than 100. The existing
      // (thread_id,created_at,id) index is not an O(1) pagination guarantee.
      const rows = (
        await tx.query<Message>(
          `select m.id::text,m.role,m.content,coalesce(m.metadata->>'agentKey','housing') as "agentKey",
            coalesce(m.metadata->>'status','complete') as status, m.metadata->'generation' as generation,
            m.metadata->>'failureCode' as "failureCode",
            (m.metadata->'citygoFavorite'='true'::jsonb) is true as favorite
           from messages m where m.thread_id=$1 and m.role in ('user','assistant')
            and ($2::bigint is null or m.id<$2::bigint)
           order by m.id desc limit 101`,
          [threadId, beforeId ?? null],
        )
      ).rows;
      const messages = rows.slice(0, 100).reverse();
      return {
        userId,
        threadId,
        messages,
        nextCursor: rows.length > 100 ? messages[0]!.id : null,
      };
    });
  }
  private async hasAiConsent(tx: Sql, userId: string, policyId: string) {
    return !!(
      await tx.query(
        "select 1 from ai_consents where user_id=$1 and policy_id=$2 and granted=true",
        [userId, policyId],
      )
    ).rows.length;
  }
  async aiConsent(
    userId: string,
    grant: { policy: AiPolicy; revision: number } | null,
  ) {
    await this.db.transaction(async (tx) => {
      const policy = grant?.policy;
      if (grant) await this.guardAiRouting(tx, grant.revision, grant.policy.id);
      // Same admission lock as reserveChat: a committed revocation blocks all
      // later admissions. Already admitted requests may finish outside this lock.
      await tx.query("select id from users where id=$1 for update", [userId]);
      if (policy) {
        await tx.query(
          "insert into ai_consents(user_id,policy_id,granted) values ($1,$2,true) on conflict (user_id) do update set policy_id=$2,granted=true,updated_at=now()",
          [userId, policy.id],
        );
      } else {
        await tx.query(
          "update ai_consents set granted=false,updated_at=now() where user_id=$1",
          [userId],
        );
      }
      await tx.query(
        "insert into consent_events(user_id,consent_key,action,policy_version,details) values ($1,'ai-recipient',$2,$3,$4)",
        [
          userId,
          policy ? "granted" : "revoked",
          policy?.id ?? "all-recipients",
          JSON.stringify(policy ?? {}),
        ],
      );
    });
  }
  async history(tx: Sql, threadId: string): Promise<Message[]> {
    const rows = (
      await tx.query<Message>(
        `select m.id::text,m.role,m.content,coalesce(m.metadata->>'agentKey','housing') as "agentKey",
      coalesce(m.metadata->>'status','complete') as status, m.metadata->'generation' as generation,
      m.metadata->>'failureCode' as "failureCode",
      (m.metadata->'citygoFavorite'='true'::jsonb) is true as favorite
      from messages m where m.thread_id=$1 and m.role in ('user','assistant')
      order by m.id desc limit 100`,
        [threadId],
      )
    ).rows;
    return rows.reverse();
  }
  async questionnaire(userId: string, profile: Questionnaire) {
    return this.db.transaction(async (tx) => {
      await tx.query("select id from users where id=$1 for update", [userId]);
      const exists = (
        await tx.query("select id from relocation_profiles where user_id=$1", [
          userId,
        ])
      ).rows[0];
      if (exists) fail(409, "Анкета уже сохранена");
      await tx.query(
        "insert into relocation_profiles(user_id,origin_city,target_city,monthly_budget,move_target_date,preferences) values ($1,$2,$3,$4,$5,$6)",
        [
          userId,
          profile.originCity,
          profile.targetCity,
          profile.monthlyBudget,
          profile.moveTargetDate,
          JSON.stringify(profile),
        ],
      );
      for (const [key, value] of Object.entries(profile))
        await tx.query(
          "insert into questionnaire_answers(user_id,question_key,answer) values ($1,$2,$3)",
          [userId, key, JSON.stringify(value)],
        );
      await tx.query(
        "insert into consent_events(user_id,consent_key,action,policy_version) values ($1,'profile-processing','granted','2026-09-local-profile-v1')",
        [userId],
      );
      const plan = (
        await tx.query<QuestPlanReference>(
          "insert into relocation_plans(user_id,status,plan) values ($1,'active',$2) returning id::text,version",
          [
            userId,
            JSON.stringify({
              targetCity: profile.targetCity,
              stages: ["housing-brief", "housing-viewing"],
            }),
          ],
        )
      ).rows[0]!;
      await tx.query(
        `insert into user_quests(user_id,quest_id,state,plan_id,plan_version) select $1,id,case when slug='housing-brief' then 'available' else 'locked' end,$2,$3 from quests where slug in ('housing-brief','housing-viewing')`,
        [userId, plan.id, plan.version],
      );
      await tx.query(
        "insert into analytics_events(user_id,name) values ($1,'questionnaire_completed')",
        [userId],
      );
    });
  }
  async start(userId: string, questId: string, plan?: QuestPlanReference) {
    return this.db.transaction(async (tx) => {
      const quest = await lockQuestPlan(tx, userId, questId, plan, false);
      if (
        quest.state !== "in_progress" &&
        !canTransitionQuest(quest.state, "in_progress")
      )
        fail(409, "Квест пока недоступен");
      await tx.query(
        "update user_quests set state='in_progress',started_at=coalesce(started_at,now()),updated_at=now() where id=$1",
        [questId],
      );
      const thread = (
        await tx.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key) values ($1,'housing') on conflict (user_id) where status<>'closed' and conversation_agent_key is null do update set agent_key=case when $2 then 'housing' else agent_threads.agent_key end,updated_at=now() returning id::text",
          [userId, quest.state === "available"],
        )
      ).rows[0]!;
      return thread;
    });
  }
  async complete(userId: string, questId: string, plan?: QuestPlanReference) {
    return this.db.transaction(async (tx) => {
      const q = await lockQuestPlan(tx, userId, questId, plan, true);
      if (q.state === "completed") return { awarded: 0 };
      if (!canTransitionQuest(q.state, "completed"))
        fail(409, "Сначала начните квест");
      const advice = (
        await tx.query(
          `select m.id from messages m join agent_threads t on t.id=m.thread_id
        where t.user_id=$1 and m.role='assistant' and m.metadata->>'agentKey'='housing' and m.metadata->>'status'='complete' and m.metadata->>'source'='model'
        and m.created_at >= (select started_at from user_quests where id=$2) limit 1`,
          [userId, questId],
        )
      ).rows[0];
      if (!advice) fail(409, "Сначала обсудите критерии с Housing Navigator");
      await tx.query(
        "update user_quests set state='completed',completed_at=now(),updated_at=now() where id=$1",
        [questId],
      );
      await tx.query(
        "insert into xp_events(user_id,user_quest_id,event_key,points) values ($1,$2,$3,$4)",
        [userId, questId, "quest-complete:" + questId, q.xp_reward],
      );
      if (q.slug === "housing-brief")
        await tx.query(
          "update user_quests set state='available',updated_at=now() where user_id=$1 and plan_id=$2 and plan_version=$3 and state='locked' and quest_id=(select id from quests where slug='housing-viewing')",
          [userId, q.plan_id, q.plan_version],
        );
      if (q.slug === "housing-viewing")
        await tx.query(
          `update relocation_plans set status='completed',updated_at=now()
           where id=$2 and user_id=$1 and version=$3 and status='active'
           and not exists (select 1 from user_quests where plan_id=$2 and state<>'completed')`,
          [userId, q.plan_id, q.plan_version],
        );
      await tx.query(
        "insert into analytics_events(user_id,name) values ($1,'quest_completed')",
        [userId],
      );
      return { awarded: q.xp_reward };
    });
  }
  async reserveChat(
    userId: string,
    threadId: string,
    requestId: string,
    text: string,
    access: {
      policyId: string;
      revision: number;
      userDailyLimit: number;
      globalDailyLimit: number;
      leaseMs?: number;
      modeSnapshot?: AiRequestModeSnapshot;
    },
  ) {
    access = {
      ...access,
      ...(access.modeSnapshot === undefined
        ? {}
        : { modeSnapshot: parseAiRequestModeSnapshot(access.modeSnapshot) }),
    };
    const leaseMs = access.leaseMs ?? 90000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 90000 || leaseMs > 270000)
      fail(400, "Недопустимый срок блокировки чата.");
    return this.db.transaction(async (tx) => {
      await this.guardAiRouting(tx, access.revision, access.policyId);
      await tx.query("select id from users where id=$1 for update", [userId]);
      const thread =
        (
          await tx.query<Thread>(
            "select id::text,agent_key,conversation_agent_key,busy_until from agent_threads where id=$1 and user_id=$2 and status<>'closed' for update",
            [threadId, userId],
          )
        ).rows[0] ?? fail(404, "Чат не найден");
      if (
        thread.busy_until &&
        new Date(thread.busy_until).getTime() > Date.now()
      )
        fail(409, "Дождитесь текущего ответа");
      if (
        (
          await tx.query(
            "select request_id from chat_requests where thread_id=$1 and request_id=$2",
            [threadId, requestId],
          )
        ).rows.length
      )
        fail(409, "Этот запрос уже был принят");
      if (!(await this.hasAiConsent(tx, userId, access.policyId)))
        fail(
          403,
          "Подтвердите передачу данных выбранному AI-получателю",
          "AI_CONSENT_REQUIRED",
        );
      if (access.userDailyLimit === 0 || access.globalDailyLimit === 0)
        fail(503, "Чат временно отключён администратором.");
      // UTC day from the database, shared across processes/providers/restarts.
      const day = (
        await tx.query<{ day: string }>(
          "select (now() at time zone 'UTC')::date::text as day",
        )
      ).rows[0]!.day;
      await tx.query(
        "insert into ai_usage_daily(usage_day) values ($1) on conflict do nothing",
        [day],
      );
      const global = (
        await tx.query<{ accepted_requests: number }>(
          "select accepted_requests from ai_usage_daily where usage_day=$1 for update",
          [day],
        )
      ).rows[0]!;
      const personal =
        (
          await tx.query<{ accepted_requests: number }>(
            "select accepted_requests from ai_user_usage_daily where user_id=$1 and usage_day=$2",
            [userId, day],
          )
        ).rows[0]?.accepted_requests ?? 0;
      if (
        global.accepted_requests >= access.globalDailyLimit ||
        personal >= access.userDailyLimit
      )
        fail(
          429,
          "Суточный лимит чата исчерпан. Попробуйте после 00:00 UTC.",
          "AI_QUOTA_EXHAUSTED",
        );
      await tx.query(
        "update ai_usage_daily set accepted_requests=accepted_requests+1 where usage_day=$1",
        [day],
      );
      await tx.query(
        "insert into ai_user_usage_daily(user_id,usage_day,accepted_requests) values ($1,$2,1) on conflict (user_id,usage_day) do update set accepted_requests=ai_user_usage_daily.accepted_requests+1",
        [userId, day],
      );
      const lease = randomUUID();
      await tx.query(
        "update agent_threads set busy_until=clock_timestamp()+($3::integer * interval '1 millisecond'),lease_token=$2 where id=$1",
        [threadId, lease, leaseMs],
      );
      await tx.query(
        "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values ($1,$2,'running',$3,$4)",
        [threadId, requestId, access.policyId, access.revision],
      );
      const modeSnapshot =
        access.modeSnapshot === undefined
          ? undefined
          : await recordAiRequestMode(tx, {
              userId,
              threadId,
              requestId,
              consentPolicyId: access.policyId,
              routingRevision: access.revision,
              snapshot: access.modeSnapshot,
            });
      await tx.query(
        "insert into messages(thread_id,role,content,metadata) values ($1,'user',$2,$3)",
        [
          threadId,
          text,
          JSON.stringify({ agentKey: thread.agent_key, status: "complete" }),
        ],
      );
      const profile =
        (
          await tx.query<{ preferences: Questionnaire }>(
            "select preferences from relocation_profiles where user_id=$1",
            [userId],
          )
        ).rows[0]?.preferences ?? null;
      return {
        thread,
        lease,
        profile,
        messages: await this.history(tx, threadId),
        ...(modeSnapshot ? { modeSnapshot } : {}),
      };
    });
  }
  async handoff(
    userId: string,
    threadId: string,
    from: AgentKey,
    to: AgentKey,
    reason: string,
    human = false,
  ) {
    await this.db.transaction(async (tx) => {
      const thread =
        (
          await tx.query(
            "select id from agent_threads where id=$1 and user_id=$2 for update",
            [threadId, userId],
          )
        ).rows[0] ?? fail(404, "Чат не найден");
      void thread;
      await tx.query(
        "insert into agent_handoffs(thread_id,from_agent_key,to_agent_key,reason,requires_human) values ($1,$2,$3,$4,$5)",
        [threadId, from, to, reason, human],
      );
      if (!human)
        await tx.query(
          "update agent_threads set agent_key=$2,updated_at=now() where id=$1",
          [threadId, to],
        );
    });
  }
  async finishGigaChat(input: {
    userId: string;
    threadId: string;
    requestId: string;
    lease: string;
    agent: AgentKey;
    content: string;
    complete: boolean;
    generation?: ModelGeneration;
    holdId: string;
  }) {
    input = {
      ...input,
      requestId: input.requestId.toLowerCase(),
      ...(input.generation
        ? { generation: structuredClone(input.generation) }
        : {}),
    };
    if (
      input.complete &&
      (!input.content.trim() ||
        input.generation?.provider !== "gigachat" ||
        input.generation.requestedModel !== "GigaChat-3-Ultra" ||
        !/^GigaChat-3-Ultra(?::[A-Za-z0-9._-]{1,100})?$/.test(
          input.generation.model ?? "",
        ))
    )
      fail(400, "Завершённый ответ не подтверждён.");
    const fees = new GigaChatFixedFees(this.db);
    return this.db.transaction(async (tx) => {
      // Unlike the legacy finish path, this transaction also resolves money.
      // Lock the owner/account before the conversation, never thread -> user.
      await fees.lockAccount(tx, input.userId);
      const fee = await fees.get(input.userId, input.holdId, tx, true);
      if (
        fee.threadId !== input.threadId ||
        fee.requestId !== input.requestId ||
        fee.chatLease !== input.lease
      )
        fail(409, "Резерв не соответствует ответу.");
      if (fee.state === "succeeded") {
        const same = await tx.query(
          `select id::text from messages where id=$1 and thread_id=$2 and content=$3
 and metadata->>'agentKey'=$4 and metadata->'generation'=$5::jsonb`,
          [
            fee.responseMessageId,
            input.threadId,
            input.content,
            input.agent,
            JSON.stringify(input.generation ?? null),
          ],
        );
        if (!input.complete || !same.rows.length)
          fail(409, "Этот ответ уже завершён с другими данными.");
        return fee.responseMessageId!;
      }
      if (fee.state === "failed" || fee.state === "expired")
        fail(409, "Этот ответ уже завершён.");
      const owner = await tx.query(
        `select t.id from agent_threads t join chat_requests r on r.thread_id=t.id
 where t.id=$1 and t.user_id=$2 and t.lease_token=$3 and r.request_id=$4 and r.status='running' for update of t`,
        [input.threadId, input.userId, input.lease, input.requestId],
      );
      if (!owner.rows.length) fail(409, "Ответ устарел.");
      const message = (
        await tx.query<{ id: string }>(
          "insert into messages(thread_id,role,content,metadata) values($1,'assistant',$2,$3) returning id::text",
          [
            input.threadId,
            input.content,
            JSON.stringify({
              agentKey: input.agent,
              requestId: input.requestId,
              status: input.complete ? "complete" : "interrupted",
              source: "model",
              ...(input.generation ? { generation: input.generation } : {}),
            }),
          ],
        )
      ).rows[0]!;
      await tx.query(
        "update chat_requests set status=$3 where thread_id=$1 and request_id=$2",
        [
          input.threadId,
          input.requestId,
          input.complete ? "complete" : "interrupted",
        ],
      );
      if (input.complete)
        await fees.settleSuccess(tx, fee, {
          messageId: message.id,
          servedModel: input.generation!.model!,
        });
      else await fees.releaseFailure(tx, fee);
      await tx.query(
        "update agent_threads set busy_until=null,lease_token=null,updated_at=now() where id=$1 and lease_token=$2",
        [input.threadId, input.lease],
      );
      return message.id;
    });
  }
  async finishChat(
    threadId: string,
    requestId: string,
    lease: string,
    agent: AgentKey,
    content: string,
    complete: boolean,
    modelResponse = complete,
    generation?: ModelGeneration,
    creditHoldId?: string,
    failureCode?: Message["failureCode"],
  ) {
    if (
      failureCode != null &&
      (failureCode !== "AI_CREDIT_EXHAUSTED" ||
        complete ||
        modelResponse ||
        generation ||
        creditHoldId)
    )
      fail(400, "Причина отказа допустима только до отправки запроса ИИ");
    return this.db.transaction(async (tx) => {
      const owner = (
        await tx.query(
          "select id from agent_threads where id=$1 and lease_token=$2 for update",
          [threadId, lease],
        )
      ).rows[0];
      if (!owner) fail(409, "Ответ устарел");
      if (failureCode) {
        const attempted = (
          await tx.query<{ attempted: boolean }>(
            "select exists(select 1 from ai_model_attempts where thread_id=$1 and request_id=$2) as attempted",
            [threadId, requestId],
          )
        ).rows[0]!.attempted;
        if (attempted)
          fail(409, "Причина отказа не соответствует существующей попытке ИИ");
      }
      const message = (
        await tx.query<{ id: string }>(
          "insert into messages(thread_id,role,content,metadata) values ($1,'assistant',$2,$3) returning id::text",
          [
            threadId,
            content,
            JSON.stringify({
              agentKey: agent,
              status: complete ? "complete" : "interrupted",
              source: modelResponse ? "model" : "system",
              ...(modelResponse && generation ? { generation } : {}),
              ...(failureCode ? { failureCode } : {}),
            }),
          ],
        )
      ).rows[0]!;
      await tx.query(
        "update chat_requests set status=$3 where thread_id=$1 and request_id=$2",
        [threadId, requestId, complete ? "complete" : "interrupted"],
      );
      if (creditHoldId && complete && modelResponse) {
        const charge = await tx.query(
          "update ai_credit_charges set response_complete=true where hold_id=$1 and thread_id=$2 and request_id=$3 and dispatched returning hold_id",
          [creditHoldId, threadId, requestId],
        );
        if (!charge.rows.length) fail(409, "Резерв не соответствует ответу");
      }
      await tx.query(
        "update agent_threads set busy_until=null,lease_token=null,updated_at=now() where id=$1",
        [threadId],
      );
      return message.id;
    });
  }
}
