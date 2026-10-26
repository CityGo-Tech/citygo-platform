import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { CONTRACT_VERSION_HEADER, type Dashboard } from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import type { StreamingProvider, ModelMessage } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import { seedTestBudget } from "./test-budget.js";

async function fixture(t: TestContext) {
  // Entirely synthetic embedded PG and in-process model. No runtime env,
  // provider/email/SMS credentials, external traffic or payments are involved.
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const calls: { instructions: string; messages: ModelMessage[] }[] = [];
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/confirmed-memory",
    async *stream(instructions, messages) {
      calls.push({ instructions, messages: structuredClone(messages) });
      yield { type: "delta", text: "Синтетический ответ без внешнего вызова" };
      yield { type: "complete", model: this.model };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: "http://localhost:3000",
    YOOKASSA_MODE: "disabled",
    EMAIL_REGISTRATION_MODE: "disabled",
    PHONE_VERIFICATION_MODE: "disabled",
  });
  await seedTestBudget(db, config, { openai: provider });
  const app = await buildApp({ db, provider, testing: true, config });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await db.close();
    }
  });
  const repo = new Repository(db);
  const owner = await registerSyntheticConsentingUser(
    db,
    "memory-owner@example.test",
    "synthetic-hash",
  );
  const other = await registerSyntheticConsentingUser(
    db,
    "memory-other@example.test",
    "synthetic-hash",
  );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const token = randomUUID(),
    otherToken = randomUUID();
  await repo.createSession(owner, tokenHash(token));
  await repo.createSession(other, tokenHash(otherToken));
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    session: string = token,
    origin = "http://localhost:3000",
  ) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin,
        ...(session ? { cookie: "citygo=" + session } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const source = async (userId = owner, role = "user", status = "complete") => {
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status) values($1,'support','closed') returning id::text",
        [userId],
      )
    ).rows[0]!.id;
    return (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata) values($1,$2,'Synthetic source',$3::jsonb) returning id::text",
        [thread, role, JSON.stringify({ status })],
      )
    ).rows[0]!.id;
  };
  const messageId = await source();
  const command = (
    sourceMessageId = messageId,
    value = "Переезжаю с партнёром",
  ) => ({
    operationId: randomUUID(),
    sourceMessageId,
    label: "Состав переезда",
    value,
    confirmed: true as const,
  });
  const snapshot = async () => {
    const names = (
      await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name<>'personal_memory_items' order by table_name",
      )
    ).rows;
    const tables: Record<string, string[]> = {};
    for (const { table_name } of names) {
      assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
      tables[table_name] = (
        await db.query<{ row: string }>(
          'select to_jsonb(t)::text as row from "' + table_name + '" t',
        )
      ).rows
        .map((x) => x.row)
        .sort();
    }
    return {
      tables,
      sequences: (
        await db.query(
          "select sequencename,last_value::text as last_value from pg_sequences where schemaname='public' and sequencename not like 'personal_memory_items_%' order by sequencename",
        )
      ).rows,
    };
  };
  const board = async () =>
    (await call("GET", "/v1/dashboard")).json<Dashboard>();
  const chat = async (
    agentKey: "support" | "housing" | "job-search",
    text: string,
  ) => {
    const started = await call("POST", "/v1/conversations/start", { agentKey });
    assert.equal(started.statusCode, 200, started.body);
    const policyId = (await board()).aiAccess.policy!.id;
    return call("POST", `/v1/threads/${started.json().id}/messages`, {
      text,
      requestId: randomUUID(),
      policyId,
    });
  };
  return {
    db,
    repo,
    app,
    owner,
    other,
    token,
    otherToken,
    call,
    source,
    command,
    snapshot,
    calls,
    board,
    chat,
  };
}

test("memory HTTP CRUD is explicit, private, replay-safe and leaves every other table, balance and consent unchanged", async (t) => {
  const f = await fixture(t);
  const before = await f.snapshot();
  assert.equal(
    (
      await f.call("POST", "/v1/personal-memory", {
        ...f.command(),
        confirmed: false,
      })
    ).statusCode,
    400,
  );
  const command = f.command();
  const created = await f.call("POST", "/v1/personal-memory", command);
  assert.equal(created.statusCode, 200, created.body);
  const item = created.json().item;
  assert.equal(item.revision, 1);
  assert.equal(item.source.role, "user");
  const path = "/v1/personal-memory/" + item.id;
  const updated = await f.call("PATCH", path, {
    expectedRevision: 1,
    label: "Кто переезжает",
    value: "Переезжаю один",
    confirmed: true,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().item.revision, 2);
  const replay = await f.call("POST", "/v1/personal-memory", command);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().item.value, "Переезжаю один");
  assert.equal(
    (
      await f.call("POST", "/v1/personal-memory", {
        ...command,
        value: "Other payload",
      })
    ).statusCode,
    409,
  );
  const conflict = await f.call("PATCH", path, {
    expectedRevision: 1,
    label: "Старое",
    value: "Старое",
    confirmed: true,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "REVISION_CONFLICT");
  assert.equal(conflict.json().currentVersion, 2);
  const list = await f.call("GET", "/v1/personal-memory");
  assert.equal(list.headers["cache-control"], "no-store");
  assert.equal(list.json().userId, f.owner);
  assert.equal(list.json().items[0].value, "Переезжаю один");
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 1 })).statusCode,
    409,
  );
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 2 })).statusCode,
    200,
  );
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 2 })).statusCode,
    200,
  );
  assert.equal(
    (await f.call("POST", "/v1/personal-memory", command)).statusCode,
    409,
  );
  assert.deepEqual((await f.call("GET", "/v1/personal-memory")).json(), {
    userId: f.owner,
    items: [],
  });
  const tombstone = (
    await f.db.query(
      "select label,value,deleted_at is not null as deleted from personal_memory_items where id=$1",
      [item.id],
    )
  ).rows[0];
  assert.deepEqual(tombstone, { label: "", value: "", deleted: true });
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.calls.length, 0);
});

test("memory HTTP forbids foreign accounts including super admins, unconfirmed/incomplete sources, injection and cross-origin writes", async (t) => {
  const f = await fixture(t);
  const foreign = await f.source(f.other);
  const system = await f.source(f.owner, "system");
  const interrupted = await f.source(f.owner, "assistant", "interrupted");
  const running = await f.source(f.owner, "assistant", "running");
  const completeAssistant = await f.source(f.owner, "assistant");
  assert.equal(
    (await f.call("GET", "/v1/personal-memory", undefined, "")).statusCode,
    401,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/personal-memory", {
        ...f.command(),
        userId: f.other,
      })
    ).statusCode,
    400,
  );
  for (const id of [
    foreign,
    system,
    interrupted,
    running,
    "9223372036854775807",
  ])
    assert.equal(
      (await f.call("POST", "/v1/personal-memory", f.command(id))).statusCode,
      404,
    );
  assert.equal(
    (await f.call("POST", "/v1/personal-memory", f.command(), f.otherToken))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/personal-memory",
        f.command(),
        f.token,
        "https://foreign.example.test",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-memory?userId=" + f.other)).statusCode,
    400,
  );
  const saved = await f.call(
    "POST",
    "/v1/personal-memory",
    f.command(completeAssistant),
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const path = "/v1/personal-memory/" + saved.json().item.id;
  assert.deepEqual(
    (await f.call("GET", "/v1/personal-memory", undefined, f.otherToken)).json()
      .items,
    [],
  );
  assert.equal(
    (
      await f.call(
        "PATCH",
        path,
        {
          expectedRevision: 1,
          label: "Чужое",
          value: "Чужое",
          confirmed: true,
        },
        f.otherToken,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 1 }, f.otherToken))
      .statusCode,
    404,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner,
  ]);
  assert.equal((await f.call("GET", "/v1/personal-memory")).statusCode, 403);
  assert.equal(f.calls.length, 0);
});

test("only explicitly saved current memory reaches another assistant after fresh AI consent, with the latest question last", async (t) => {
  const f = await fixture(t);
  const foreignSource = await f.source(f.other);
  await f.call(
    "POST",
    "/v1/personal-memory",
    f.command(foreignSource, "FOREIGN_PRIVATE_MEMORY"),
    f.otherToken,
  );
  const created = await f.call("POST", "/v1/personal-memory", f.command());
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(
    f.calls.length,
    0,
    "saving is free and never dispatches to a provider",
  );
  const policy = (await f.board()).aiAccess.policy!;
  assert.equal(policy.version, "ai-recipient-v3-confirmed-memory");
  assert.match(policy.data, /явно сохранённых вами в памяти разговора/);
  const rejected = await f.chat("housing", "С чего начать поиск района?");
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", {
        action: "granted",
        policyId: policy.id,
      })
    ).statusCode,
    200,
  );
  const reply = await f.chat("housing", "Последний вопрос: как выбрать район?");
  assert.match(reply.body, /"type":"done"/, reply.body);
  const first = f.calls[0]!;
  const context = JSON.parse(
    first.messages[0]!.content.slice(first.messages[0]!.content.indexOf("{")),
  );
  assert.deepEqual(context.confirmedMemory, [
    { label: "Состав переезда", value: "Переезжаю с партнёром" },
  ]);
  assert.equal(context.monthlyBudget, "unknown");
  assert.deepEqual(first.messages.at(-1), {
    role: "user",
    content: "Последний вопрос: как выбрать район?",
  });
  assert.ok(!JSON.stringify(first).includes("FOREIGN_PRIVATE_MEMORY"));
  assert.ok(!JSON.stringify(context).includes("sourceMessageId"));
  const path = "/v1/personal-memory/" + created.json().item.id;
  assert.equal(
    (
      await f.call("PATCH", path, {
        expectedRevision: 1,
        label: "Кто переезжает",
        value: "UPDATED_PRIVATE_MEMORY",
        confirmed: true,
      })
    ).statusCode,
    200,
  );
  const second = await f.chat("job-search", "С чего начать поиск работы?");
  assert.match(second.body, /"type":"done"/, second.body);
  assert.match(f.calls[1]!.messages[0]!.content, /UPDATED_PRIVATE_MEMORY/);
  assert.doesNotMatch(
    f.calls[1]!.messages[0]!.content,
    /Переезжаю с партнёром|FOREIGN_PRIVATE_MEMORY/,
  );
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 2 })).statusCode,
    200,
  );
  const third = await f.chat("support", "Последний вопрос после удаления");
  assert.match(third.body, /"type":"done"/, third.body);
  assert.doesNotMatch(
    f.calls[2]!.messages[0]!.content,
    /confirmedMemory|UPDATED_PRIVATE_MEMORY|FOREIGN_PRIVATE_MEMORY/,
  );
  const after = await f.board();
  assert.equal(after.profile, null);
  assert.equal(after.xp, 0);
  assert.deepEqual(after.quests, []);
});
