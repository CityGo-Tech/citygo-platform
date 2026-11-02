import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Repository, type Database } from "./index.js";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { CITYGO_10X_TARIFF, routerAiCostMicros } from "@citygo/contracts";
import { AiCreditLedger } from "./ai-credit.js";
import { AiCreditCharges } from "./ai-credit-charges.js";

// Synthetic fixtures shared by in-memory correctness and opt-in PostgreSQL tests.
// Never read an application database URL or provider credentials here.
// Seed explicitly historical accounting BEFORE the new receipt obligation
// trigger exists. This does not disable triggers or erase receipt obligations.
export async function migrateLegacyRestartFixture(db: Database) {
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter(
      (name) => name.endsWith(".sql") && name <= "0015_yookassa_orders.sql",
    )
    .sort()) {
    const source = await readFile(new URL(name, directory), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(
        source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
      );
      await tx.query(
        "insert into citygo_migrations(name,checksum) values ($1,$2)",
        [
          name,
          createHash("sha256")
            .update(source.replaceAll("\r\n", "\n"))
            .digest("hex"),
        ],
      );
    });
  }
}

export async function seedRestartFixture(db: Database) {
  const repo = new Repository(db);
  const ids = [
    await repo.register("restart-owner@example.test", "PRIVATE-OLD-HASH"),
    await repo.register("restart-other@example.test", "PRIVATE-OTHER-HASH"),
  ];
  const user = ids[0]!;
  await db.query("update users set username='admin',role='admin' where id=$1", [
    user,
  ]);
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values ('PRIVATE-OLD-SESSION',$1,now()+interval '1 day')",
    [user],
  );
  await db.query(
    "insert into relocation_profiles(user_id,origin_city,target_city,preferences) values ($1,'PRIVATE-ORIGIN','Москва','{\"private\":\"PRIVATE-PROFILE\"}')",
    [user],
  );
  await db.query(
    "insert into questionnaire_answers(user_id,question_key,answer) values ($1,'private','\"PRIVATE-ANSWER\"')",
    [user],
  );
  const plan = (
    await db.query<{ id: string }>(
      'insert into relocation_plans(user_id,status,plan) values ($1,\'active\',\'{"stages":["housing-brief"],"private":"PRIVATE-PLAN"}\') returning id::text',
      [user],
    )
  ).rows[0]!.id;
  const quest = (
    await db.query<{ id: string }>(
      "insert into user_quests(user_id,quest_id,plan_id,plan_version,state) select $1,id,$2,1,'available' from quests where slug='housing-brief' returning id::text",
      [user, plan],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into xp_events(user_id,user_quest_id,event_key,points,metadata) values ($1,$2,'synthetic-private',1,'{\"private\":\"PRIVATE-XP\"}')",
    [user, quest],
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,context) values ($1,'housing','{\"private\":\"PRIVATE-CONTEXT\"}') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content,metadata) values ($1,'user','PRIVATE-CHAT','{\"private\":\"PRIVATE-METADATA\"}')",
    [thread],
  );
  await db.query(
    "insert into agent_handoffs(thread_id,from_agent_key,to_agent_key,reason,context) values ($1,'housing','support','PRIVATE-HANDOFF','{\"private\":\"PRIVATE-HANDOFF-CONTEXT\"}')",
    [thread],
  );
  await db.query(
    "insert into consent_events(user_id,consent_key,action,policy_version,details) values ($1,'synthetic','granted','synthetic','{\"private\":\"PRIVATE-CONSENT\"}')",
    [user],
  );
  await db.query(
    "insert into ai_consents(user_id,policy_id,granted) values ($1,$2,true)",
    [user, "a".repeat(64)],
  );
  await db.query(
    "insert into analytics_events(user_id,name) values ($1,'PRIVATE-ANALYTICS')",
    [user],
  );
  const brief = (
    await db.query<{ id: string }>(
      "insert into r1_housing_briefs(user_id,plan_id,plan_version) values ($1,$2,1) returning id::text",
      [user, plan],
    )
  ).rows[0]!.id;
  await db.transaction(async (tx) => {
    const event = randomUUID();
    await tx.query(
      "insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision) values ($1,$2,$3,'create_brief','user','explicit_command','{\"private\":\"PRIVATE-BRIEF-REQUEST\"}',$4,1)",
      [user, randomUUID(), event, brief],
    );
    await tx.query(
      'insert into r1_housing_brief_revisions(brief_id,revision,event_id,content) values ($1,1,$2,\'{"private":"PRIVATE-BRIEF-CONTENT"}\')',
      [brief, event],
    );
  });
  const request = randomUUID();
  await db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values ($1,$2,'complete',$3,1)",
    [thread, request, "a".repeat(64)],
  );
  await db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values ($1,$2,1,$3,'routerai','synthetic-model',$4,1,'RUB',1000000,1,$4)",
    [thread, request, user, "a".repeat(64)],
  );
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros,spent_micros) values ($1,500000000,120000)",
    [user],
  );
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values ($1,$2,'bonus',500000000,$3)",
    [user, randomUUID(), ids[1]],
  );
  const hold = randomUUID();
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'hold',1000000)",
    [user, hold],
  );
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values ($1,$2,'settle',120000,$3)",
    [user, randomUUID(), hold],
  );
  // The same fixture is also seeded before 0017. Keep the current-schema raw
  // synthetic posting consistent without changing historical migration seeds.
  if (
    (
      await db.query<{ present: boolean }>(
        "select to_regclass('public.credit_source_lots') is not null as present",
      )
    ).rows[0]!.present
  ) {
    await db.query(
      "update credit_source_lots set held_micros=1000000 where user_id=$1 and kind='gift'",
      [user],
    );
    await db.query(
      "insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros) select $1,id,0,1000000 from credit_source_lots where user_id=$2 and kind='gift'",
      [hold, user],
    );
    await db.query(
      "update credit_hold_allocations set state='settled',spent_micros=120000 where hold_id=$1",
      [hold],
    );
    await db.query(
      "update credit_source_lots set held_micros=0,spent_micros=120000 where user_id=$1 and kind='gift'",
      [user],
    );
  }
  const receipt = {
    generationId: "synthetic-generation",
    reference: hold,
    model: "synthetic-model",
    upstream: "synthetic",
    currency: "RUB",
    costRub: "0.120000",
    amountMicros: 120000,
  };
  await db.query(
    "insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,dispatched,generation_id,response_complete,receipt) values ($1,$2,$3,$4,1,'synthetic-model','synthetic',true,'synthetic-generation',true,$5)",
    [hold, user, thread, request, JSON.stringify(receipt)],
  );
  await db.query(
    "update ai_budget set currency='RUB',total_limit_micros=900000000,total_reserved_micros=1000000 where id=1",
  );
  await db.query(
    "insert into ai_budget_daily(usage_day,reserved_micros) values (current_date,1000000)",
  );
  await db.query(
    "insert into ai_usage_daily(usage_day,accepted_requests) values (current_date,1)",
  );
  await db.query(
    "insert into ai_user_usage_daily(user_id,usage_day,accepted_requests) values ($1,current_date,1)",
    [user],
  );
  await db.query(
    "insert into ai_model_attempt_daily(usage_day,reserved_attempts,user_limit,global_limit) values (current_date,1,100,1000)",
  );
  await db.query(
    "insert into ai_user_model_attempt_daily(user_id,usage_day,reserved_attempts) values ($1,current_date,1)",
    [user],
  );
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values (1,'routerai',$1,1)",
    ["a".repeat(64)],
  );
  for (const [action, type, entity, payload] of [
    ["ai-routing-initialized", "ai-routing", "1", { provider: "routerai" }],
    ["ai-budget-changed", "ai-budget", "1", { revision: 1 }],
    [
      "ai-credit-welcome-granted",
      "ai-credit",
      user,
      { amountMicros: 500000000 },
    ],
  ] as const)
    await db.query(
      "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,$2,$3,$4,$5)",
      [user, action, type, entity, JSON.stringify(payload)],
    );
  return { ids, user, thread, request, hold, receipt };
}

// A NEW live-shaped credit in a synthetic DB after migration 0016. Unlike the
// pre-migration legacy fixture this must create an NPD obligation, so destructive
// maintenance must not treat it as permission to erase that obligation.
export async function seedRestartNpdObligation(
  db: Database,
  userId: string,
  withHistory = false,
) {
  const operationId = randomUUID(),
    paymentId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'topup',100000000)",
      [userId, operationId],
    );
    await tx.query(
      "update ai_credit_accounts set granted_micros=granted_micros+100000000 where user_id=$1",
      [userId],
    );
    await tx.query(
      "insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,credited_micros,merchant_id,test,verified_at,verification_receipt) values ($1,$2,$3,10000,100000000,'123456',false,now(),'{\"synthetic\":true}')",
      [paymentId, operationId, userId],
    );
    if (withHistory) {
      const claimId = randomUUID(),
        evidenceId = randomUUID(),
        receiptId = "synthetic-" + evidenceId,
        receiptUrl = `https://lknpd.nalog.ru/api/v1/receipt/${receiptId}/print`;
      await tx.query(
        "insert into npd_receipt_commands(request_id,task_id,actor_user_id,action,payload,result_revision) values ($1,$2,$3,'claim',$4,2)",
        [
          claimId,
          operationId,
          userId,
          JSON.stringify({
            action: "claim",
            requestId: claimId,
            expectedRevision: 1,
          }),
        ],
      );
      await tx.query(
        "update npd_receipt_tasks set claimed_by_user_id=$2,revision=2 where id=$1",
        [operationId, userId],
      );
      await tx.query(
        "insert into npd_receipt_commands(request_id,task_id,actor_user_id,action,payload,result_revision) values ($1,$2,$3,'register',$4,3)",
        [
          evidenceId,
          operationId,
          userId,
          JSON.stringify({
            action: "register",
            requestId: evidenceId,
            expectedRevision: 2,
            receiptId,
            receiptUrl,
            amountKopeks: 10000,
            operatorReported: true,
          }),
        ],
      );
      await tx.query(
        "insert into npd_receipt_evidence(id,task_id,kind,receipt_id,receipt_url,amount_kopeks,evidence_url,refund_snapshot_kopeks) values ($1,$2,'register',$3,$4,10000,$4,0)",
        [evidenceId, operationId, receiptId, receiptUrl],
      );
      await tx.query(
        "update npd_receipt_tasks set active_evidence_id=$2,registration_status='operator_reported',revision=3 where id=$1",
        [operationId, evidenceId],
      );
      await tx.query(
        "insert into npd_refund_observations(id,provider_refund_id,task_id,amount_kopeks,observed_at,result_revision) values ($1,$2,$3,100,now(),4)",
        [randomUUID(), randomUUID(), operationId],
      );
    }
  });
  return { operationId, paymentId };
}

export const retainedFinancialTables = [
  "ai_postpay_attempts",
  "credit_postpay_liabilities",
  "credit_postpay_repayments",
  "credit_charge_debts",
  "credit_debt_repayments",
  "credit_hold_allocations",
  "credit_refund_allocations",
  "credit_source_lots",
  "payment_refunds",
  "payment_refund_events",
  "payment_notification_inbox",
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_receipt_tasks",
  "npd_refund_observations",
  "ai_model_attempts",
  "chat_requests",
  "ai_credit_accounts",
  "ai_credit_entries",
  "ai_credit_charges",
  "ai_budget",
  "ai_budget_daily",
  "ai_usage_daily",
  "ai_model_attempt_daily",
  "ai_routing",
  "citygo_migrations",
  "quests",
] as const;

// A real-shaped fixed5 liability in a synthetic current-schema database. No
// trigger is bypassed: exact receipts create debt, and a verified test-fixture
// posting repays it through the normal source trigger when requested.
export async function seedRestartCreditDebt(
  db: Database,
  userId: string,
  { repaid = false } = {},
) {
  const ledger = new AiCreditLedger(db, "routerai_citygo_10x");
  await ledger.grantWelcome(userId, userId);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'housing') returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  let debtHold = "";
  for (const [mode, ceiling, costRub] of [
    ["full", 49_500_000, "49.5"],
    ["fixed5_overdraft", 6_000_000, "0.6"],
  ] as const) {
    const charges = new AiCreditCharges(db, CITYGO_10X_TARIFF, mode);
    const request = randomUUID();
    const hold = await db.transaction(async (tx) => {
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      await tx.query(
        "insert into chat_requests(thread_id,request_id,status) values($1,$2,'complete')",
        [thread, request],
      );
      await tx.query(
        "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision) values($1,$2,1,$3,'routerai','synthetic-debt-model',$4,1)",
        [thread, request, userId, "a".repeat(64)],
      );
      return charges.reserve(
        tx,
        {
          userId,
          threadId: thread,
          requestId: request,
          model: "synthetic-debt-model",
          upstream: "synthetic",
        },
        ceiling,
      );
    });
    const generationId = "synthetic-debt-" + hold;
    await charges.dispatch(userId, hold);
    await charges.identify(userId, hold, generationId);
    await db.query(
      "update ai_credit_charges set response_complete=true where hold_id=$1",
      [hold],
    );
    await charges.settle(userId, hold, {
      reference: hold,
      generationId,
      model: "synthetic-debt-model",
      upstream: "synthetic",
      currency: "RUB",
      costRub,
      amountMicros: routerAiCostMicros(costRub),
    });
    if (mode === "fixed5_overdraft") debtHold = hold;
  }
  if (repaid)
    await ledger.topUpConfirmed(userId, randomUUID(), {
      providerPaymentId: randomUUID(),
      merchantId: "synthetic-debt-shop",
      test: false,
      paidKopeks: 100,
      verifiedAt: "2026-10-21T00:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
  return { debtHold };
}

// Independently unknown full-prepaid attempt. Do not null/rewrite a settled
// historical receipt merely to obtain an unresolved-maintenance fixture.
export async function seedRestartUnreconciledCharge(
  db: Database,
  userId: string,
  threadId: string,
) {
  const charges = new AiCreditCharges(db, CITYGO_10X_TARIFF, "full");
  const requestId = randomUUID();
  const hold = await db.transaction(async (tx) => {
    await tx.query(
      "select id from account_security_state where id=1 for update",
    );
    await tx.query(
      "insert into chat_requests(thread_id,request_id,status) values($1,$2,'interrupted')",
      [threadId, requestId],
    );
    await tx.query(
      "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision) values($1,$2,1,$3,'routerai','synthetic-pending-model',$4,1)",
      [threadId, requestId, userId, "a".repeat(64)],
    );
    return charges.reserve(
      tx,
      {
        userId,
        threadId,
        requestId,
        model: "synthetic-pending-model",
        upstream: "synthetic",
      },
      100_000,
    );
  });
  const generationId = "synthetic-pending-" + hold;
  await charges.dispatch(userId, hold);
  await charges.identify(userId, hold, generationId);
  return { charges, hold, generationId };
}

// A source-pinned monetary refund history, not a request to any provider. The
// optional canceled terminal result releases the reservation so closed restart
// can demonstrate exact retention even after the money is no longer held.
export async function seedRestartRefundHistory(
  db: Database,
  userId: string,
  { journal = true, canceled = false } = {},
) {
  const source = await seedRestartNpdObligation(db, userId);
  const refundId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      "update credit_source_lots set refund_reserved_micros=1000000 where id=$1",
      [source.operationId],
    );
    await tx.query(
      "update ai_credit_accounts set held_micros=held_micros+1000000 where user_id=$1",
      [userId],
    );
    await tx.query(
      "insert into credit_refund_allocations(refund_id,user_id,source_lot_id,amount_micros,refunded_before_kopeks) values ($1,$2,$3,1000000,0)",
      [refundId, userId, source.operationId],
    );
    if (journal) {
      await tx.query(
        "insert into payment_refunds(id,request_id,created_by_user_id,user_id,payment_operation_id,provider_payment_id,merchant_id,test,amount_kopeks,payment_amount_kopeks,refunded_before_kopeks,create_key,create_payload) values ($1,$2,$3,$3,$4,$5,'123456',false,100,10000,0,$1,$6)",
        [
          refundId,
          randomUUID(),
          userId,
          source.operationId,
          source.paymentId,
          JSON.stringify({
            payment_id: source.paymentId,
            amount: { value: "1.00", currency: "RUB" },
            description: "Возврат средств CityGo",
            metadata: { citygo_refund_id: refundId },
          }),
        ],
      );
      await tx.query(
        "insert into payment_refund_events(refund_id,action,actor_user_id,revision,payload) values ($1,'reserved',$2,1,$3)",
        [refundId, userId, JSON.stringify({ amountKopeks: 100 })],
      );
    }
    if (canceled) {
      await tx.query(
        "update credit_refund_allocations set state='released' where refund_id=$1",
        [refundId],
      );
      await tx.query(
        "update credit_source_lots set refund_reserved_micros=0 where id=$1",
        [source.operationId],
      );
      await tx.query(
        "update ai_credit_accounts set held_micros=held_micros-1000000 where user_id=$1",
        [userId],
      );
      if (journal) {
        const providerRefundId = randomUUID();
        await tx.query(
          "update payment_refunds set status='canceled',provider_refund_id=$2,revision=2,updated_at=clock_timestamp() where id=$1",
          [refundId, providerRefundId],
        );
        await tx.query(
          "insert into payment_refund_events(refund_id,action,actor_user_id,revision,payload) values ($1,'provider_observed',$2,2,$3)",
          [
            refundId,
            null,
            JSON.stringify({
              providerRefundId,
              providerStatus: "canceled",
              observation: "server_get",
            }),
          ],
        );
      }
    }
  });
  return { ...source, refundId };
}

// Bounded hints only: this fixture does not fetch a provider, infer settlement,
// post a balance or bypass the inbox's bound-source and lease guards.
export async function seedRestartPaymentNotification(
  db: Database,
  userId: string,
  {
    processed = false,
    refundId,
  }: { processed?: boolean; refundId?: string } = {},
) {
  const id = randomUUID();
  let orderId: string | null = null;
  let objectId: string;
  let event: "payment.succeeded" | "refund.succeeded";
  if (refundId) {
    const refund = (
      await db.query<{
        provider_refund_id: string | null;
        merchant_id: string;
        test: boolean;
      }>(
        "select provider_refund_id,merchant_id,test from payment_refunds where id=$1",
        [refundId],
      )
    ).rows[0];
    if (
      !refund?.provider_refund_id ||
      refund.merchant_id !== "123456" ||
      refund.test
    )
      throw new Error(
        "Synthetic notification needs the bound live-shaped refund",
      );
    objectId = refund.provider_refund_id;
    event = "refund.succeeded";
  } else {
    const orders = new PaymentTopupOrders(db);
    const order = await orders.create(
      userId,
      randomUUID(),
      10_000,
      "123456",
      false,
      "https://citygo.example.test/",
    );
    orderId = order.id;
    objectId = randomUUID();
    await orders.recordProvider(userId, order.id, {
      providerPaymentId: objectId,
      status: "pending",
    });
    event = "payment.succeeded";
  }
  await db.query(
    `insert into payment_notification_inbox(id,event,object_id,payment_order_id,refund_id,merchant_id,test)
     values ($1,$2,$3,$4,$5,'123456',false)`,
    [id, event, objectId, orderId, refundId ?? null],
  );
  if (processed) {
    await db.query(
      "update payment_notification_inbox set status='processing',attempt_count=1,lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' where id=$1",
      [id, randomUUID()],
    );
    await db.query(
      "update payment_notification_inbox set status='processed',lease_token=null,lease_until=null,processed_at=clock_timestamp() where id=$1",
      [id],
    );
  }
  return { id, orderId };
}

export async function captureRestartRows(
  db: Database,
  names?: readonly string[],
) {
  const tables =
    names ??
    (
      await db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname='public' order by tablename",
      )
    ).rows.map((row) => row.tablename);
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table))
      throw new Error("Unexpected synthetic table name");
    result[table] = (
      await db.query(
        `select row_to_json(x) as value from ${table} x order by row_to_json(x)::text`,
      )
    ).rows;
  }
  return result;
}
