import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  PersonalPlan,
  type Database,
} from "./index.js";
import { CustomerObservability } from "./customer-observability.js";
import {
  adminCustomerAccountResponseSchema,
  adminCustomerActivityResponseSchema,
  adminCustomerFunnelResponseSchema,
  adminCustomerMessagesResponseSchema,
} from "@citygo/contracts";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  async function account(email: string, role = "user", hash = "b".repeat(64)) {
    const id = (
      await db.query<{ id: string }>(
        "insert into users(auth_subject,role,created_at)values($1,$2,clock_timestamp()-interval'2 days')returning id::text",
        [randomUUID(), role],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into user_credentials(user_id,email,password_hash)values($1,$2,'not-a-real-password-hash')",
      [id, email],
    );
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at)values($1,$2,clock_timestamp()+interval'1 day')",
      [hash, id],
    );
    return { userId: id, sessionTokenHash: hash };
  }
  const admin = await account(
    "admin@example.test",
    "super_admin",
    "a".repeat(64),
  );
  const customer = await account("customer@example.test"),
    other = await account("other@example.test", "user", "c".repeat(64));
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status)values($1,'housing','closed')returning id::text",
      [customer.userId],
    )
  ).rows[0]!.id;
  const foreign = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key)values($1,'housing')returning id::text",
      [other.userId],
    )
  ).rows[0]!.id;
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const row = (
      await db.query<{ id: string }>(
        `insert into messages(thread_id,role,content,metadata,created_at)values($1,$2,$3,$4::jsonb,date_trunc('day',clock_timestamp())-interval'1 day'+$5::integer*interval'1 microsecond')returning id::text`,
        [
          thread,
          i % 2 === 0 ? "user" : "assistant",
          "PRIVATE_MESSAGE_" + i,
          JSON.stringify({
            citygoFavorite: i === 0,
            requestId: randomUUID(),
            secretToken: "DO_NOT_DISCLOSE_METADATA",
          }),
          i + 1,
        ],
      )
    ).rows[0]!;
    ids.push(row.id);
  }
  await db.query(
    "insert into messages(thread_id,role,content)values($1,'tool','INTERNAL_TOOL_SECRET'),($1,'system','INTERNAL_SYSTEM_SECRET'),($2,'user','OTHER_ACCOUNT_PRIVATE_TEXT')",
    [thread, foreign],
  );
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros,held_micros,spent_micros)values($1,100000000,5000000,3000000)",
    [customer.userId],
  );
  await db.query(
    "insert into relocation_profiles(user_id,origin_city,target_city,monthly_budget,move_target_date)values($1,'Казань','Москва',80000,'2027-01-01')",
    [customer.userId],
  );
  await new PersonalPlan(db).create(customer.userId, {
    operationId: randomUUID(),
    sourceMessageId: ids[0]!,
    title: "Найти жильё",
    details: "Личный шаг пользователя",
  });
  return {
    db,
    store: new CustomerObservability(db),
    admin,
    customer,
    other,
    thread,
    foreign,
    ids,
  };
}
const status = (code: number) => (e: unknown) =>
  (e as { statusCode?: number }).statusCode === code;
async function counts(db: Database) {
  return (
    await db.query(
      "select (select count(*)from users)::int as users,(select count(*)from messages)::int as messages,(select count(*)from ai_credit_entries)::int as entries,(select granted_micros::text||':'||held_micros::text||':'||spent_micros::text from ai_credit_accounts limit 1)as balance",
    )
  ).rows[0];
}

test("customer explorer paginates retained messages, state, bookmarks and exact activity without exposing internal records", async (t) => {
  const f = await fixture(t),
    before = await counts(f.db);
  const first = await f.store.list(f.admin, { limit: 2 });
  assert.deepEqual(
    first.accounts.map((x) => x.userId),
    [f.admin.userId, f.customer.userId],
  );
  const next = await f.store.list(f.admin, {
    afterUserId: first.nextAfterUserId,
    limit: 2,
  });
  assert.deepEqual(
    next.accounts.map((x) => x.userId),
    [f.other.userId],
  );
  assert.equal(next.nextAfterUserId, null);
  assert.deepEqual(
    (await f.store.list(f.admin, { search: "customer@" })).accounts.map(
      (x) => x.userId,
    ),
    [f.customer.userId],
  );
  assert.equal(
    (await f.store.list(f.admin, { search: "%" })).accounts.length,
    0,
    "search treats wildcard characters literally",
  );
  const detail = adminCustomerAccountResponseSchema.parse(
    await f.store.detail(f.admin, f.customer.userId),
  );
  assert.equal(detail.account.availableMicros, 92_000_000);
  assert.equal(detail.account.heldMicros, 5_000_000);
  assert.equal(detail.account.spentMicros, 3_000_000);
  assert.equal(detail.profile?.targetCity, "Москва");
  assert.equal(detail.personalPlan.items[0]?.title, "Найти жильё");
  assert.equal(detail.favoritesCount, 1);
  assert.equal(detail.activeSessions, 1);
  const threads = await f.store.conversations(f.admin, f.customer.userId, {});
  assert.equal(threads.conversations[0]?.id, f.thread);
  assert.equal(threads.conversations[0]?.status, "closed");
  let cursor: string | undefined;
  const seen: string[] = [];
  do {
    const page = adminCustomerMessagesResponseSchema.parse(
      await f.store.messages(f.admin, f.customer.userId, f.thread, {
        before: cursor,
        limit: 2,
      }),
    );
    assert(
      page.messages.every(
        (m, i) => !i || BigInt(page.messages[i - 1]!.id) < BigInt(m.id),
      ),
    );
    seen.push(...page.messages.map((m) => m.id));
    cursor = page.nextBeforeId ?? undefined;
  } while (cursor);
  assert.deepEqual(
    seen.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    f.ids,
  );
  assert.equal(new Set(seen).size, 8);
  const favorites = await f.store.favorites(f.admin, f.customer.userId, {});
  assert.equal(favorites.items[0]?.messageId, f.ids[0]);
  assert.equal(favorites.items[0]?.content, "PRIVATE_MESSAGE_0");
  await f.store.recordInteraction(f.customer, { event: "wallet_opened" });
  const full = await f.store.activity(f.admin, f.customer.userId, {
      limit: 100,
    }),
    paged: string[] = [];
  let activityBefore: string | undefined;
  do {
    const page = adminCustomerActivityResponseSchema.parse(
      await f.store.activity(f.admin, f.customer.userId, {
        before: activityBefore,
        limit: 2,
      }),
    );
    paged.push(...page.events.map((e) => e.id));
    activityBefore = page.nextCursor ?? undefined;
  } while (activityBefore);
  assert.deepEqual(
    paged,
    full.events.map((e) => e.id),
    "sub-millisecond event cursors never skip same-millisecond rows",
  );
  assert.equal(new Set(paged).size, paged.length);
  assert(full.events.some((x) => x.kind === "ui_wallet_opened"));
  assert.equal(
    full.events.filter(
      (x) => x.kind === "message_sent" || x.kind === "assistant_replied",
    ).length,
    8,
  );
  assert.deepEqual(
    await counts(f.db),
    before,
    "viewing does not modify accounts, messages or ledger",
  );
  const responseText = JSON.stringify({ detail, threads, favorites, full });
  for (const secret of [
    "password_hash",
    "token_hash",
    "auth_subject",
    "INTERNAL_TOOL_SECRET",
    "INTERNAL_SYSTEM_SECRET",
    "OTHER_ACCOUNT_PRIVATE_TEXT",
    "DO_NOT_DISCLOSE_METADATA",
  ])
    assert(!responseText.includes(secret));
  const audits = (
    await f.db.query<{
      actor_user_id: string;
      entity_id: string;
      payload: unknown;
    }>(
      "select actor_user_id::text,entity_id,payload from audit_log where action='customer-account-viewed'",
    )
  ).rows;
  assert(audits.length > 5);
  assert(audits.every((x) => x.actor_user_id === f.admin.userId));
  assert(!JSON.stringify(audits).includes("PRIVATE_MESSAGE"));
  assert(
    audits.some(
      (x) =>
        (x.payload as { conversationId?: string }).conversationId === f.thread,
    ),
  );
});

test("private account reads recheck current super-admin, live session, password state and nested ownership", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.detail(f.customer, f.customer.userId),
    status(403),
  );
  await f.db.query("update users set role='admin'where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(
    f.store.messages(f.admin, f.customer.userId, f.thread, {}),
    status(403),
  );
  await f.db.query("update users set role='super_admin'where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(
    f.store.messages(f.admin, f.customer.userId, f.foreign, {}),
    status(404),
  );
  await assert.rejects(f.store.detail(f.admin, "9999999999"), status(404));
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(f.store.funnel(f.admin, {}), status(403));
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.admin.userId,
  ]);
  await f.db.query("delete from sessions where token_hash=$1", [
    f.admin.sessionTokenHash,
  ]);
  await assert.rejects(f.store.detail(f.admin, f.customer.userId), status(401));
  await assert.rejects(
    f.store.recordInteraction(f.customer, { event: "gift_granted" }),
  );
  await assert.rejects(
    f.store.recordInteraction(f.customer, {
      event: "wallet_opened",
      userId: f.other.userId,
    }),
  );
  await assert.rejects(
    f.store.activity(f.customer, f.customer.userId, {
      before: Buffer.from(
        JSON.stringify(["2026-01-01T00:00:00Z", 3, "1", "extra"]),
      ).toString("base64url"),
    }),
  );
});

test("server cohort funnel uses stored milestones and actual credited payments, never claimed browser success", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into analytics_events(user_id,name)values($1,'gift_granted'),($1,'payment_credited'),($1,'ai_response_completed')",
    [f.customer.userId],
  );
  await f.db.query(
    "insert into messages(thread_id,role,content)values($1,'user','Второй день использования')",
    [f.thread],
  );
  const value = adminCustomerFunnelResponseSchema.parse(
    await f.store.funnel(f.admin, { days: 30 }),
  );
  const steps = Object.fromEntries(value.steps.map((x) => [x.key, x.users]));
  assert.equal(value.basis, "registered_cohort");
  assert.equal(steps.registered, 3);
  assert.equal(steps.first_request, 2);
  assert.equal(steps.first_reply, 1);
  assert.equal(steps.repeated_usage, 1);
  assert.equal(steps.gift_granted, 0);
  assert.equal(steps.paid_topup, 0);
  assert.equal(
    value.recentActivity.reduce((sum, x) => sum + x.userMessages, 0),
    6,
  );
  assert.equal(
    value.recentActivity.reduce((sum, x) => sum + x.paidMicros, 0),
    0,
  );
  assert(!JSON.stringify(value).includes("PRIVATE_MESSAGE"));
});

test("plan timeline retains creation and labels only the persisted last change after edit, reopen and delete", async (t) => {
  const f = await fixture(t),
    plans = new PersonalPlan(f.db);
  let item = (await plans.list(f.customer.userId)).items[0]!;
  const creationId = "5:" + item.id,
    mutationId = "9:" + item.id;
  const read = async () =>
    (
      await f.store.activity(f.admin, f.customer.userId, { limit: 100 })
    ).events.filter(
      (event) => event.id === creationId || event.id === mutationId,
    );
  const creation = (await read())[0]!;
  assert.equal(creation.kind, "plan_created");
  assert.equal(creation.occurredAt, item.createdAt);
  assert.equal(
    (await read()).length,
    1,
    "initial default updated_at is not a separate user edit",
  );
  const update = async (
    status: "pending" | "completed",
    title = item.title,
  ) => {
    item = (
      await plans.update(f.customer.userId, item.id, {
        expectedRevision: item.revision,
        title,
        details: item.details,
        status,
      })
    ).item;
    const events = await read();
    assert.deepEqual(
      events.find((event) => event.id === creationId),
      creation,
      "editing never moves the actual creation event",
    );
    const latest = events.find((event) => event.id === mutationId)!;
    assert.equal(latest.kind, "plan_updated");
    assert.equal(latest.occurredAt, item.updatedAt);
    assert.equal(latest.label, "Последнее изменение шага плана");
    assert(
      !events.some((event) => event.kind === "plan_completed"),
      "current state is not a fabricated completion history",
    );
  };
  await update("pending", "Уточнить поиск жилья");
  await update("completed");
  await update("pending");
  await plans.remove(f.customer.userId, item.id, item.revision);
  const afterDelete = await read();
  assert.deepEqual(
    afterDelete.find((event) => event.id === creationId),
    creation,
    "retained tombstone preserves creation history",
  );
  assert.equal(
    afterDelete.find((event) => event.id === mutationId)?.kind,
    "plan_deleted",
  );
  assert.equal(
    afterDelete.find((event) => event.id === mutationId)?.label,
    "Последнее изменение: удалил шаг плана",
  );
  assert.equal(
    (await f.store.plan(f.admin, f.customer.userId, {})).items.length,
    0,
  );
  const ids: string[] = [];
  let before: string | undefined;
  do {
    const page = await f.store.activity(f.admin, f.customer.userId, {
      before,
      limit: 1,
    });
    ids.push(...page.events.map((event) => event.id));
    before = page.nextCursor ?? undefined;
  } while (before);
  assert.equal(new Set(ids).size, ids.length);
  assert(
    ids.includes(creationId) && ids.includes(mutationId),
    "source9 cursor remains unique and fully traversable",
  );
});
