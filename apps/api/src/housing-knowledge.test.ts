import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  knowledgeLookupResultSchema,
  type KnowledgeFact,
  type KnowledgeSource,
} from "@citygo/contracts";
import {
  AiCreditLedger,
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "@citygo/db";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

const webOrigin = "http://localhost:3000";
const lookup = {
  factKey: "housing.rent.first_payment",
  scope: { kind: "global" },
  limit: 1,
} as const;
const sourceId = "housing-first-payment-fixture-source";
const factId = "housing-first-payment-fixture-fact";
const publisher = "Учебный издатель";
const url = "https://example.com/housing-first-payment-fixture";
const excerpt = "В учебном примере дополнительный платёж не предусмотрен.";
const checkedAt = "2000-01-02T00:00:00Z";
const factCheckedAt = "2000-01-03T00:00:00Z";

async function billingSnapshot(db: Database) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "ai_budget",
    "ai_budget_daily",
    "ai_model_attempts",
    "ai_model_attempt_daily",
    "ai_user_model_attempt_daily",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_credit_charges",
    "ai_postpay_attempts",
    "credit_postpay_liabilities",
    "gigachat_request_fees",
    "chat_requests",
  ]) {
    result[table] = (
      await db.query(
        `select row_to_json(entry) as value from ${table} entry order by row_to_json(entry)::text`,
      )
    ).rows;
  }
  return result;
}

async function seedPublished(
  db: Database,
  document: KnowledgeSource | KnowledgeFact,
) {
  assert.equal(document.publication.status, "published");
  const factKey = "factKey" in document ? document.factKey : null;
  await db.query(
    `insert into knowledge_editorial_revisions(kind,id,revision,fact_key,scope,state,document,occurred_at)
     values ($1,$2,$3,$4,$5::jsonb,'published',$6::jsonb,$7::timestamptz)`,
    [
      factKey === null ? "source" : "fact",
      document.id,
      document.revision,
      factKey,
      JSON.stringify(document.scope),
      JSON.stringify(document),
      document.publication.publishedAt,
    ],
  );
}

test("housing preview lookup uses only fresh reviewed evidence without a model or billing attempt", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  const resources: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    try {
      await resources.app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  let modelCalls = 0;
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected external request");
  });
  const server = await buildApp({
    db,
    testing: true,
    provider: {
      name: "openai",
      model: "synthetic/housing-preview",
      async *stream() {
        modelCalls++;
        yield { type: "delta", text: "Unexpected model output" };
      },
    },
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: webOrigin,
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
    }),
  });
  resources.app = server;
  const accountId = await registerSyntheticConsentingUser(
    db,
    "housing-preview@example.test",
    "synthetic",
    server,
  );
  const token = randomUUID();
  await new Repository(db).createSession(accountId, tokenHash(token));
  await new AiCreditLedger(db).grantWelcome(accountId, accountId);
  const billingBefore = await billingSnapshot(db);

  const call = async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/knowledge/lookup",
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin: webOrigin,
        cookie: "citygo=" + token,
      },
      payload: lookup,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    return knowledgeLookupResultSchema.parse(response.json());
  };

  assert.deepEqual(await call(), {
    status: "miss",
    reason: "not_found",
    researchNeeded: true,
  });

  const now = (await db.query<{ now: Date }>("select current_timestamp as now"))
    .rows[0]!.now;
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();
  const dayAfter = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const sourceFixture = (
    revision: number,
    validUntil: string,
  ): KnowledgeSource => ({
    id: sourceId,
    revision,
    schemaVersion: 1,
    title: "Проверка первого платежа, учебный источник",
    scope: lookup.scope,
    url,
    excerpt,
    provenance: {
      kind: "primary",
      publisher,
      retrievedAt: "2000-01-01T00:00:00Z",
      reuseBasis: "link_and_short_excerpt",
    },
    publication: {
      status: "published",
      reviewer: { kind: "editorial", id: "housing-fixture-review" },
      reviewedAt: checkedAt,
      publishedAt: checkedAt,
      validUntil,
    },
  });
  const supported = "Учебный пример не предусматривает дополнительный платёж.";
  const factFixture = (
    revision: number,
    evidenceRevision: number,
    quote = excerpt,
    statement = supported,
  ): KnowledgeFact => ({
    id: factId,
    revision,
    schemaVersion: 1,
    factKey: lookup.factKey,
    scope: lookup.scope,
    statement,
    provenance: { kind: "editorial", processId: "housing-preview-fixture" },
    evidence: [{ source: { id: sourceId, revision: evidenceRevision }, quote }],
    publication: {
      status: "published",
      reviewer: { kind: "editorial", id: "housing-fixture-review" },
      reviewedAt: factCheckedAt,
      publishedAt: factCheckedAt,
      validUntil: dayAfter,
    },
  });

  // The fact itself is still valid. An expired cited revision overrides it.
  await seedPublished(db, sourceFixture(1, "2000-02-01T00:00:00Z"));
  await seedPublished(db, factFixture(1, 1));
  assert.deepEqual(await call(), {
    status: "stale",
    reason: "expired",
    researchNeeded: true,
  });

  await seedPublished(db, sourceFixture(2, tomorrow));
  await seedPublished(db, factFixture(2, 2));
  assert.deepEqual(await call(), {
    status: "hit",
    researchNeeded: false,
    matches: [
      {
        fact: { id: factId, revision: 2 },
        factKey: lookup.factKey,
        scope: lookup.scope,
        statement: supported,
        reviewedAt: factCheckedAt,
        validUntil: tomorrow,
        evidence: [
          {
            source: { id: sourceId, revision: 2 },
            title: "Проверка первого платежа, учебный источник",
            publisher,
            url,
            quote: excerpt,
            reviewedAt: checkedAt,
            validUntil: tomorrow,
          },
        ],
      },
    ],
  });

  // An inconsistent historical import is seeded directly because the normal
  // editorial endpoint already refuses to publish an unsupported quotation.
  await seedPublished(
    db,
    factFixture(
      3,
      2,
      "В учебном примере дополнительный платёж обязателен.",
      "В учебном примере нужно заплатить дополнительно.",
    ),
  );
  assert.deepEqual(await call(), {
    status: "conflict",
    reason: "invalid_evidence",
    researchNeeded: false,
  });

  assert.equal(modelCalls, 0);
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(await billingSnapshot(db), billingBefore);
});
