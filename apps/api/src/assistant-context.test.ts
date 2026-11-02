import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  assistantContextPreviewSchema,
  CONTRACT_VERSION_HEADER,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

async function previewDatabase(t: TestContext, postgres: boolean) {
  if (!postgres) {
    const db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
    return db;
  }
  const target = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.ok(
    ((target.port || "5432") === "5432" &&
      target.pathname === "/citygo_test") ||
      (target.port === "55438" && target.pathname === "/citygo_synthetic"),
  );
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  const admin = await connectDatabase(target.toString());
  const name = "context_preview_test_" + randomUUID().replaceAll("-", "");
  let created = false;
  const owned: { db?: Database } = {};
  t.after(async () => {
    try {
      await owned.db?.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  target.pathname = "/" + name;
  const db = await connectDatabase(target.toString());
  owned.db = db;
  return db;
}

async function financialState(db: Database) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "messages",
    "chat_requests",
    "ai_credit_entries",
    "ai_credit_charges",
    "ai_usage_daily",
    "ai_user_usage_daily",
    "consent_events",
    "relocation_profiles",
  ])
    result[table] = (
      await db.query(
        `select to_jsonb(t)::text as row from ${table} t order by 1`,
      )
    ).rows;
  return result;
}
for (const postgres of [false, true])
  test(
    `context is a private read-only snapshot without AI/quota/money changes (${postgres ? "PostgreSQL" : "PGlite"})`,
    { skip: postgres && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const db = await previewDatabase(t, postgres);
      await migrate(db);
      let providerCalls = 0;
      const app = await buildApp({
        db,
        testing: true,
        config: readConfig({
          NODE_ENV: "test",
          DATABASE_URL: "pglite://:memory:",
          WEB_ORIGIN: "http://localhost:3000",
          LLM_PROVIDER: "disabled",
          YOOKASSA_MODE: "disabled",
          EMAIL_REGISTRATION_MODE: "disabled",
          PHONE_VERIFICATION_MODE: "disabled",
        }),
        provider: {
          name: "routerai",
          model: "synthetic/context",
          async *stream() {
            providerCalls++;
            yield { type: "delta", text: "Unexpected" };
          },
        },
      });
      t.after(async () => {
        await app.close();
      });
      const repo = new Repository(db);
      const owner = await registerSyntheticConsentingUser(
        db,
        "context-owner@example.test",
        "synthetic",
        app,
      );
      const other = await registerSyntheticConsentingUser(
        db,
        "context-other@example.test",
        "synthetic",
        app,
      );
      await db.query("update users set role='super_admin' where id=$1", [
        other,
      ]);
      const token = randomUUID(),
        otherToken = randomUUID();
      await repo.createSession(owner, tokenHash(token));
      await repo.createSession(other, tokenHash(otherToken));
      const thread = (
        await db.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key,conversation_agent_key,status) values($1,'support','support','open') returning id::text",
          [owner],
        )
      ).rows[0]!.id;
      const add = async (role: string, content: string, status = "complete") =>
        db.query(
          "insert into messages(thread_id,role,content,metadata) values($1,$2,$3,$4::jsonb)",
          [
            thread,
            role,
            content,
            JSON.stringify({ agentKey: "support", status }),
          ],
        );
      await add("user", "PRIVATE_QUESTION");
      await add("assistant", "PRIVATE_ANSWER");
      await add("user", "ORPHANED_PRIVATE");
      await add("assistant", "PARTIAL_PRIVATE", "interrupted");
      const call = (
        threadId: string | null,
        draft = "UNSENT_PRIVATE_DRAFT",
        credential = token,
        cookie = false,
      ) =>
        app.inject({
          method: "POST",
          url: "/v1/ai/context-preview",
          headers: {
            [CONTRACT_VERSION_HEADER]: "1",
            ...(cookie
              ? {
                  cookie: "citygo=" + credential,
                  origin: "http://localhost:3000",
                }
              : {
                  "x-citygo-client": "native",
                  authorization: "Bearer " + credential,
                }),
          },
          payload: { threadId, draft },
        });
      const before = await financialState(db);
      for (const cookie of [false, true]) {
        const response = await call(
          thread,
          "UNSENT_PRIVATE_DRAFT",
          token,
          cookie,
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "no-store");
        const context = assistantContextPreviewSchema.parse(response.json());
        assert.equal(context.userId, owner);
        assert.equal(context.threadId, thread);
        assert.deepEqual(context.profile, {
          targetCity: null,
          monthlyBudget: null,
          household: null,
          moveTargetDate: null,
        });
        assert.deepEqual(context.messages, [
          { role: "user", content: "PRIVATE_QUESTION" },
          { role: "assistant", content: "PRIVATE_ANSWER" },
        ]);
        assert.equal(context.draftIncluded, true);
        assert.equal(response.body.includes("UNSENT_PRIVATE_DRAFT"), false);
      }
      const empty = await call(null, "");
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.json().draftIncluded, false);
      assert.deepEqual(empty.json().messages, []);
      assert.equal(
        (await call(thread, "", otherToken)).statusCode,
        404,
        "Even super admins cannot read this route as another owner",
      );
      assert.equal((await call("9223372036854775807")).statusCode, 404);
      assert.equal((await call(thread, "x".repeat(4001))).statusCode, 400);
      assert.equal(providerCalls, 0);
      assert.deepEqual(await financialState(db), before);
      const storedProfile = {
        originCity: "PRIVATE_ORIGIN_NOT_FORWARDED",
        targetCity: "Казань",
        monthlyBudget: 62000,
        moveTargetDate: "2000-01-01",
        household: "family",
        aiConsent: true,
      };
      await db.query(
        "insert into relocation_profiles(user_id,target_city,preferences) values($1,$2,$3::jsonb)",
        [owner, storedProfile.targetCity, JSON.stringify(storedProfile)],
      );
      await db.query("update agent_threads set status='closed' where id=$1", [
        thread,
      ]);
      const savedBefore = await financialState(db);
      const savedResponse = await call(thread);
      assert.equal(savedResponse.statusCode, 200, savedResponse.body);
      const saved = assistantContextPreviewSchema.parse(savedResponse.json());
      assert.equal(saved.closed, true);
      assert.deepEqual(saved.profile, {
        targetCity: "Казань",
        monthlyBudget: 62000,
        moveTargetDate: "2000-01-01",
        household: "family",
      });
      assert.equal(
        savedResponse.body.includes("PRIVATE_ORIGIN_NOT_FORWARDED"),
        false,
      );
      assert.deepEqual(await financialState(db), savedBefore);
      assert.equal(providerCalls, 0);
      await db.query("delete from sessions where token_hash=$1", [
        tokenHash(token),
      ]);
      assert.equal((await call(thread)).statusCode, 401);
    },
  );
