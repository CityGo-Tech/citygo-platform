import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  knowledgeLookupResultSchema,
} from "@citygo/contracts";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

const lookupPath = "/v1/knowledge/lookup";
const sourceId = "editorial-source-test";
const factId = "editorial-fact-test";
const sourcePath = "/v1/admin/knowledge/source/" + sourceId;
const factPath = "/v1/admin/knowledge/fact/" + factId;
const scope = { kind: "city", cityId: "example-city" } as const;
const publisher = "Synthetic Publisher";
const url = "https://knowledge.example.test/synthetic";
const excerpt = "Synthetic public information about a fictional place.";
const statement = "A fictional city has synthetic public information.";
const forecastStatement = "A second fictional statement for stale review.";

type EditorialResponse = {
  state: "candidate" | "published" | "stale" | "withdrawn";
  document: { revision: number };
};

test("editorial HTTP commands enforce role, exact state and content-free audit", async (t) => {
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
      model: "synthetic/knowledge-editorial",
      async *stream() {
        modelCalls++;
        yield { type: "delta", text: "Unexpected" };
      },
    },
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
    }),
  });
  resources.app = server;
  const repository = new Repository(db);
  async function account(role: "user" | "admin" | "super_admin") {
    const id = await registerSyntheticConsentingUser(
      db,
      role + "-editorial@example.test",
      "synthetic",
      server,
    );
    await db.query("update users set role=$1 where id=$2", [role, id]);
    const token = randomUUID();
    await repository.createSession(id, tokenHash(token));
    return { id, token };
  }

  const user = await account("user");
  const admin = await account("admin");
  const supervisor = await account("super_admin");
  const headers = {
    [CONTRACT_VERSION_HEADER]: "1",
    "x-citygo-client": "native",
  };
  const call = (
    method: "GET" | "POST",
    url: string,
    token?: string,
    payload?: Record<string, unknown>,
  ) =>
    server.inject({
      method,
      url,
      headers: {
        ...headers,
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const fetchKnowledge = async (factKey: string) => {
    const response = await call("POST", lookupPath, user.token, {
      factKey,
      scope,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    return knowledgeLookupResultSchema.parse(response.json());
  };
  const edit = async (
    path: string,
    token: string,
    body: Record<string, unknown>,
    statusCode = 200,
  ) => {
    const response = await call("POST", path, token, body);
    assert.equal(response.statusCode, statusCode, response.body);
    return response.json<EditorialResponse>();
  };
  const baselineAudit = (
    await db.query<{ id: string }>(
      "select coalesce(max(id),0)::text as id from audit_log",
    )
  ).rows[0]!.id;
  const audits = async () =>
    (
      await db.query<{ actor: string; action: string; payload: unknown }>(
        "select actor_user_id::text as actor,action,payload from audit_log where id>$1 order by id",
        [baselineAudit],
      )
    ).rows;

  const lookup = { factKey: "sample-information", scope };
  assert.equal(
    (await call("POST", lookupPath, undefined, lookup)).statusCode,
    401,
  );
  assert.equal(
    (
      await call("POST", lookupPath, user.token, {
        ...lookup,
        asOf: "2000-01-01T00:00:00Z",
      })
    ).statusCode,
    400,
  );
  assert.equal((await call("GET", sourcePath, user.token)).statusCode, 403);

  const sourceInput = {
    expectedRevision: 0,
    draft: {
      title: "Synthetic public source for editorial tests",
      url,
      scope,
      excerpt,
      provenance: {
        kind: "primary",
        publisher,
        retrievedAt: "2000-01-01T00:00:00Z",
        reuseBasis: "link_and_short_excerpt",
      },
    },
  };
  assert.equal(
    (await call("POST", sourcePath + "/candidate", user.token, sourceInput))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", sourcePath + "/candidate", admin.token, {
        ...sourceInput,
        actorId: supervisor.id,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        sourcePath + "/candidate?unused=1",
        admin.token,
        sourceInput,
      )
    ).statusCode,
    400,
  );

  assert.equal(
    (
      await call("POST", sourcePath + "/candidate", admin.token, {
        ...sourceInput,
        draft: {
          ...sourceInput.draft,
          userId: user.id,
          dialogue: "Synthetic private field",
        },
      })
    ).statusCode,
    400,
  );
  const crossOrigin = await server.inject({
    method: "POST",
    url: sourcePath + "/candidate",
    headers: {
      origin: "https://other.example.test",
      cookie: "citygo=" + admin.token,
    },
    payload: sourceInput,
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal((await audits()).length, 0);

  const sourceDraft = await edit(
    sourcePath + "/candidate",
    admin.token,
    sourceInput,
    201,
  );
  assert.equal(sourceDraft.state, "candidate");
  const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sourcePublish = {
    expectedRevision: sourceDraft.document.revision,
    validUntil,
  };
  assert.equal(
    (await call("POST", sourcePath + "/publish", user.token, sourcePublish))
      .statusCode,
    403,
  );
  const source = await edit(
    sourcePath + "/publish",
    admin.token,
    sourcePublish,
  );
  assert.equal(source.state, "published");

  const sourceHistory = await call(
    "GET",
    sourcePath + "?revision=" + sourceDraft.document.revision,
    admin.token,
  );
  assert.equal(sourceHistory.statusCode, 200, sourceHistory.body);
  assert.deepEqual(sourceHistory.json(), sourceDraft);
  assert.equal(
    (await call("GET", sourcePath + "?revision=01", admin.token)).statusCode,
    400,
  );
  assert.equal((await call("GET", sourcePath, user.token)).statusCode, 403);

  const factInput = {
    expectedRevision: 0,
    draft: {
      ...lookup,
      statement,
      provenance: { kind: "editorial", processId: "editorial-test-process" },
      evidence: [
        {
          source: { id: sourceId, revision: source.document.revision },
          quote: excerpt,
        },
      ],
    },
  };
  const factDraft = await edit(
    factPath + "/candidate",
    admin.token,
    factInput,
    201,
  );
  assert.equal(factDraft.state, "candidate");
  assert.equal((await fetchKnowledge(lookup.factKey)).status, "miss");

  const fact = await edit(factPath + "/publish", admin.token, {
    expectedRevision: factDraft.document.revision,
    validUntil,
  });
  assert.equal(fact.state, "published");
  const published = await fetchKnowledge(lookup.factKey);
  assert.equal(published.status, "hit");
  assert.equal(published.matches[0]?.statement, statement);
  assert.equal(published.matches[0]?.evidence[0]?.publisher, publisher);
  assert.equal(published.matches[0]?.evidence[0]?.url, url);

  const withdraw = { expectedRevision: fact.document.revision };
  assert.equal(
    (await call("POST", factPath + "/stale", admin.token, withdraw)).statusCode,
    409,
  );
  assert.equal((await fetchKnowledge(lookup.factKey)).status, "hit");

  assert.equal(
    (await call("POST", factPath + "/withdraw", admin.token, withdraw))
      .statusCode,
    403,
  );
  const withdrawn = await edit(
    factPath + "/withdraw",
    supervisor.token,
    withdraw,
  );
  assert.equal(withdrawn.state, "withdrawn");
  const revoked = await fetchKnowledge(lookup.factKey);
  assert.equal(revoked.status, "miss");
  assert.equal(revoked.reason, "withdrawn");
  assert.ok(!JSON.stringify(revoked).includes(statement));

  const forecastKey = "future-sample-information";
  const forecastId = "editorial-expiry-test";
  const archiveSourceId = "editorial-expiry-source";
  const forecastPath = "/v1/admin/knowledge/fact/" + forecastId;
  // Seed already expired historical versions. Tests do not wait for a wall
  // clock, and the reader cannot make the material current by choosing asOf.
  const historicalPublication = {
    status: "published",
    reviewer: { kind: "editorial", id: admin.id },
    reviewedAt: "2000-01-02T00:00:00Z",
    publishedAt: "2000-01-02T00:00:00Z",
    validUntil: "2000-02-01T00:00:00Z",
  };
  const historicalSource = {
    ...sourceInput.draft,
    id: archiveSourceId,
    schemaVersion: 1,
    revision: 1,
    publication: historicalPublication,
  };
  const historicalFact = {
    ...factInput.draft,
    id: forecastId,
    schemaVersion: 1,
    revision: 1,
    factKey: forecastKey,
    statement: forecastStatement,
    evidence: [
      { source: { id: archiveSourceId, revision: 1 }, quote: excerpt },
    ],
    publication: {
      ...historicalPublication,
      reviewedAt: "2000-01-03T00:00:00Z",
      publishedAt: "2000-01-03T00:00:00Z",
      validUntil: "2000-01-20T00:00:00Z",
    },
  };
  for (const [kind, document, factKey] of [
    ["source", historicalSource, null],
    ["fact", historicalFact, forecastKey],
  ] as const)
    await db.query(
      `insert into knowledge_editorial_revisions(kind,id,revision,fact_key,scope,state,document,occurred_at)
       values ($1,$2,1,$3,$4::jsonb,'published',$5::jsonb,$6::timestamptz)`,
      [
        kind,
        document.id,
        factKey,
        JSON.stringify(scope),
        JSON.stringify(document),
        document.publication.publishedAt,
      ],
    );
  const expired = await fetchKnowledge(forecastKey);
  assert.equal(expired.status, "stale");
  assert.ok(!JSON.stringify(expired).includes(forecastStatement));
  const stale = await edit(forecastPath + "/stale", admin.token, {
    expectedRevision: 1,
  });
  assert.equal(stale.state, "stale");
  assert.equal((await fetchKnowledge(forecastKey)).status, "stale");

  const journal = await audits();
  assert.deepEqual(
    journal.map(({ action }) => action),
    [
      "knowledge-candidate-proposed",
      "knowledge-published",
      "knowledge-candidate-proposed",
      "knowledge-published",
      "knowledge-withdrawn",
      "knowledge-marked-stale",
    ],
  );
  assert.ok(
    journal.every(({ actor }) => actor === admin.id || actor === supervisor.id),
  );
  assert.equal(
    journal.filter(({ actor }) => actor === supervisor.id).length,
    1,
  );
  for (const protectedValue of [
    publisher,
    url,
    excerpt,
    statement,
    forecastStatement,
  ])
    assert.ok(!JSON.stringify(journal).includes(protectedValue));
  assert.equal(
    (
      await call("POST", forecastPath + "/publish", admin.token, {
        expectedRevision: 1,
        validUntil,
      })
    ).statusCode,
    409,
  );
  assert.equal((await audits()).length, journal.length);
  assert.equal(modelCalls, 0);
  assert.equal(network.mock.callCount(), 0);
});
