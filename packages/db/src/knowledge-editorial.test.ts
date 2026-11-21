import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  DomainError,
  KnowledgeEditorialStore,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";

const city = { kind: "city", cityId: "demo-city" } as const;
const global = { kind: "global" } as const;
const excerpt = "Условия можно проверить на официальной странице проекта.";
const factKey = "demo-service";
const statement = "Для этой услуги есть публичная справочная страница.";
const status = (n: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === n;
const validUntil = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return { db, store: new KnowledgeEditorialStore(db), ...(await actors(db)) };
}

async function actors(db: Database) {
  const repo = new Repository(db);
  const user = await repo.register("knowledge-user@example.test", "synthetic");
  const editor = await repo.register(
    "knowledge-editor@example.test",
    "synthetic",
  );
  const owner = await repo.register(
    "knowledge-owner@example.test",
    "synthetic",
  );
  await db.query("update users set role=$2 where id=$1", [editor, "admin"]);
  await db.query("update users set role=$2 where id=$1", [
    owner,
    "super_admin",
  ]);
  return { user, editor, owner };
}

function sourceDraft(scope: typeof city | typeof global = city) {
  return {
    title: "Демонстрационный справочник",
    url: "https://reference.example/demo",
    scope,
    excerpt,
    provenance: {
      kind: "official",
      publisher: "Синтетический издатель",
      retrievedAt: "2025-01-01T00:00:00.000Z",
      reuseBasis: "link_and_short_excerpt",
    },
  };
}

function factDraft(
  sourceId: string,
  revision: number,
  scope: typeof city | typeof global = city,
) {
  return {
    factKey,
    statement,
    scope,
    provenance: { kind: "editorial", processId: "first-review" },
    evidence: [{ source: { id: sourceId, revision }, quote: excerpt }],
  };
}

async function publishSource(
  store: KnowledgeEditorialStore,
  actor: string,
  id: string,
  scope: typeof city | typeof global = city,
) {
  await store.propose(actor, "source", id, {
    expectedRevision: 0,
    draft: sourceDraft(scope),
  });
  return store.publish(actor, "source", id, {
    expectedRevision: 1,
    validUntil: validUntil(),
  });
}

test("editorial roles, exact evidence and immutable fact heads exclude private fields and prevent fallback after withdrawal", async (t) => {
  const { db, store, editor, owner, user } = await fixture(t);
  await assert.rejects(
    store.propose(user, "source", "city-reference", {
      expectedRevision: 0,
      draft: sourceDraft(),
    }),
    status(403),
  );
  await assert.rejects(
    store.editorial(user, "source", "city-reference"),
    status(403),
  );
  await assert.rejects(
    store.propose(editor, "source", "invalid", {
      expectedRevision: 0,
      draft: { ...sourceDraft(), messages: ["private-synthetic"] },
    }),
    status(400),
  );
  const source = await publishSource(store, editor, "city-reference");
  assert.equal(source.document.revision, 2);
  await assert.rejects(
    store.propose(editor, "source", "city-reference", {
      expectedRevision: 2,
      draft: sourceDraft(global),
    }),
    status(409),
  );
  await assert.rejects(
    store.propose(editor, "fact", "unresolved", {
      expectedRevision: 0,
      draft: factDraft("absent", 1),
    }),
    status(422),
  );
  await assert.rejects(
    store.propose(editor, "fact", "wrong-scope", {
      expectedRevision: 0,
      draft: factDraft("city-reference", 2, global),
    }),
    status(422),
  );
  const incorrectQuote = factDraft("city-reference", 2);
  incorrectQuote.evidence[0]!.quote =
    "Этой цитаты нет в синтетическом источнике.";
  await assert.rejects(
    store.propose(editor, "fact", "wrong-quote", {
      expectedRevision: 0,
      draft: incorrectQuote,
    }),
    status(422),
  );

  const genericSource = await publishSource(
    store,
    editor,
    "global-reference",
    global,
  );
  await store.propose(editor, "fact", "global-rule", {
    expectedRevision: 0,
    draft: factDraft(
      "global-reference",
      genericSource.document.revision,
      global,
    ),
  });
  await store.publish(editor, "fact", "global-rule", {
    expectedRevision: 1,
    validUntil: validUntil(),
  });
  await store.propose(editor, "fact", "city-rule", {
    expectedRevision: 0,
    draft: factDraft("city-reference", 2),
  });
  assert.deepEqual(await store.lookup({ factKey, scope: city }), {
    status: "miss",
    researchNeeded: true,
    reason: "unpublished",
  });
  await assert.rejects(
    store.propose(editor, "fact", "same-city-key", {
      expectedRevision: 0,
      draft: factDraft("city-reference", 2),
    }),
    status(409),
  );
  await assert.rejects(
    store.publish(editor, "fact", "city-rule", {
      expectedRevision: 2,
      validUntil: validUntil(),
    }),
    status(409),
  );
  const fact = await store.publish(editor, "fact", "city-rule", {
    expectedRevision: 1,
    validUntil: validUntil(),
  });
  assert.equal(fact.document.revision, 2);
  const hit = await store.lookup({ factKey, scope: city });
  if (hit.status !== "hit")
    assert.fail("Expected a current knowledge match: " + hit.status);
  assert.deepEqual(
    hit.matches.map((m) => m.fact),
    [{ id: "city-rule", revision: 2 }],
  );
  assert.equal(hit.matches[0]?.statement, statement);
  assert.equal(
    hit.matches[0]?.evidence[0]?.url,
    "https://reference.example/demo",
  );
  assert.equal(
    hit.matches[0]?.evidence[0]?.publisher,
    "Синтетический издатель",
  );
  await assert.rejects(
    store.lookup({ factKey, scope: city, asOf: "2025-01-01T00:00:00.000Z" }),
    status(400),
  );
  await assert.rejects(
    store.withdraw(editor, "fact", "city-rule", { expectedRevision: 2 }),
    status(403),
  );
  assert.equal(
    (await store.withdraw(owner, "fact", "city-rule", { expectedRevision: 2 }))
      .document.revision,
    3,
  );
  assert.deepEqual(await store.lookup({ factKey, scope: city }), {
    status: "miss",
    researchNeeded: true,
    reason: "withdrawn",
  });
  assert.equal(
    (await store.editorial(owner, "fact", "city-rule", 2)).state,
    "published",
  );
  const { rows: audit } = await db.query<{
    actor: string;
    action: string;
    payload: unknown;
  }>(
    `select actor_user_id::text actor,action,payload from audit_log
       where entity_type='knowledge-fact' and entity_id='city-rule' order by id`,
  );
  assert.deepEqual(audit, [
    {
      actor: editor,
      action: "knowledge-candidate-proposed",
      payload: { previousRevision: 0, revision: 1, state: "candidate" },
    },
    {
      actor: editor,
      action: "knowledge-published",
      payload: { previousRevision: 1, revision: 2, state: "published" },
    },
    {
      actor: owner,
      action: "knowledge-withdrawn",
      payload: { previousRevision: 2, revision: 3, state: "withdrawn" },
    },
  ]);
});

test("time expiry and a newer source head suppress an old fact; explicit stale and withdrawal preserve the audit trail", async (t) => {
  const { db, store, editor, owner } = await fixture(t);
  await publishSource(store, editor, "city-reference");
  await store.propose(editor, "fact", "published-rule", {
    expectedRevision: 0,
    draft: factDraft("city-reference", 2),
  });
  await store.publish(editor, "fact", "published-rule", {
    expectedRevision: 1,
    validUntil: validUntil(),
  });
  await assert.rejects(
    store.markStale(editor, "fact", "published-rule", { expectedRevision: 2 }),
    status(409),
  );
  await store.propose(editor, "source", "city-reference", {
    expectedRevision: 2,
    draft: sourceDraft(),
  });
  assert.deepEqual(await store.lookup({ factKey, scope: city }), {
    status: "stale",
    researchNeeded: true,
    reason: "superseded_source",
  });

  // A historical publication fixture makes boundary verification independent of
  // the machine clock and of timer scheduling on loaded CI runners.
  const priorTime = "2020-01-01T00:00:00.000Z",
    expiry = "2020-01-02T00:00:00.000Z";
  const expired = {
    ...factDraft("city-reference", 2),
    factKey: "historical-rule",
    schemaVersion: 1,
    id: "historical",
    revision: 1,
    publication: {
      status: "published",
      reviewer: { kind: "editorial", id: editor },
      reviewedAt: priorTime,
      publishedAt: priorTime,
      validUntil: expiry,
    },
  };
  await db.query(
    `insert into knowledge_editorial_revisions(kind,id,revision,fact_key,scope,state,document,occurred_at)
    values ('fact','historical',1,'historical-rule',$1::jsonb,'published',$2::jsonb,$3::timestamptz)`,
    [JSON.stringify(city), JSON.stringify(expired), priorTime],
  );
  assert.deepEqual(
    await store.lookup({ factKey: "historical-rule", scope: city }),
    { status: "stale", researchNeeded: true, reason: "expired" },
  );
  const stale = await store.markStale(editor, "fact", "historical", {
    expectedRevision: 1,
  });
  assert.equal(stale.state, "stale");
  assert.equal(stale.document.revision, 2);
  assert.equal(
    (await store.withdraw(owner, "fact", "historical", { expectedRevision: 2 }))
      .state,
    "withdrawn",
  );
  assert.deepEqual(
    await store.lookup({ factKey: "historical-rule", scope: city }),
    { status: "miss", researchNeeded: true, reason: "withdrawn" },
  );
  const { rows } = await db.query<{ action: string }>(
    "select action from audit_log where entity_id='historical' order by id",
  );
  assert.deepEqual(
    rows.map((row) => row.action),
    ["knowledge-marked-stale", "knowledge-withdrawn"],
  );
});

test(
  "disposable PostgreSQL gives two concurrent publications one winner under API runtime grants",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly disposable local PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search + url.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_kn_" + suffix;
    const role = {
      citygo_api: "cgkn_api_" + suffix,
      citygo_worker: "cgkn_w_" + suffix,
      citygo_backup: "cgkn_b_" + suffix,
    };
    const admin = await connectDatabase(url.toString());
    let created = false,
      db: Database | undefined;
    const roles: string[] = [];
    t.after(async () => {
      try {
        if (db) {
          for (const item of roles.reverse())
            await db.exec(`drop owned by ${item};drop role ${item}`);
          await db.close();
        }
        if (created) await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    url.pathname = "/" + name;
    const backend = (db = await connectDatabase(url.toString()));
    await backend.exec(
      "alter default privileges revoke execute on functions from public",
    );
    await migrate(backend);
    for (const item of Object.values(role)) {
      await backend.exec(
        `create role ${item} nologin;grant usage on schema public to ${item}`,
      );
      roles.push(item);
    }
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
      .replace(
        /\bcitygo_(api|worker|backup)\b/g,
        (item) => role[item as keyof typeof role],
      );
    await backend.exec(grants);
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${role.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
      close: async () => {},
    };
    const store = new KnowledgeEditorialStore(runtime),
      { editor, owner } = await actors(backend);
    await publishSource(store, editor, "city-reference");
    await store.propose(editor, "fact", "city-rule", {
      expectedRevision: 0,
      draft: factDraft("city-reference", 2),
    });
    const publication = { expectedRevision: 1, validUntil: validUntil() };
    const results = await Promise.allSettled([
      store.publish(editor, "fact", "city-rule", publication),
      store.publish(owner, "fact", "city-rule", publication),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const loser = results.find((result) => result.status === "rejected");
    assert.ok(loser && status(409)(loser.reason));
    assert.equal((await store.lookup({ factKey, scope: city })).status, "hit");
    const { rows } = await backend.query<{
      versions: number;
      publications: number;
    }>(
      `select (select count(*)::int from knowledge_editorial_revisions where kind='fact' and id='city-rule') versions,
       (select count(*)::int from audit_log where entity_type='knowledge-fact' and entity_id='city-rule' and action='knowledge-published') publications`,
    );
    assert.deepEqual(rows, [{ versions: 2, publications: 1 }]);
  },
);
