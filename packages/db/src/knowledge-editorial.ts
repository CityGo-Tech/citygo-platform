import {
  knowledgeEditorialVersionSchema,
  knowledgeEntityIdSchema,
  knowledgeEntityKindSchema,
  knowledgeFactCandidateRequestSchema,
  knowledgeLookupRequestSchema,
  knowledgePublishRequestSchema,
  knowledgeRevisionRequestSchema,
  knowledgeSourceCandidateRequestSchema,
  knowledgeSourceSchema,
  type KnowledgeEditorialVersion,
  type KnowledgeEntityKind,
  type KnowledgeFact,
  type KnowledgeLookupResult,
  type KnowledgeScope,
} from "@citygo/contracts";
import { planKnowledgeLookup } from "@citygo/content";
import { DomainError } from "./errors.js";
import type { Database, Sql } from "./index.js";

type StoredDocument = { state: string; document: unknown };
type Snapshot = {
  now: string;
  facts: StoredDocument[];
  sources: StoredDocument[];
};
type Reference = KnowledgeFact["evidence"][number]["source"];
type Parser<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

const utcNow = `to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const clock = (sql: Sql) =>
  sql
    .query<{ now: string }>(`select ${utcNow} as now`)
    .then((value) => value.rows[0]!.now);

function input<T>(schema: Parser<T>, raw: unknown) {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new DomainError(400, "Проверьте параметры записи базы знаний.");
  return result.data;
}

function stored(raw: unknown) {
  const result = knowledgeEditorialVersionSchema.safeParse(raw);
  if (!result.success)
    throw new DomainError(
      500,
      "Не удалось прочитать сохранённую версию знания.",
    );
  return result.data;
}

function compareRevision(expected: number, actual: number) {
  if (expected !== actual)
    throw new DomainError(
      409,
      "Версия знания изменилась. Обновите данные.",
      "REVISION_CONFLICT",
      actual,
    );
}

async function requireEditor(sql: Sql, actorId: string, withdraw = false) {
  const {
    rows: [actor],
  } = await sql.query<{
    role: string;
    status: string;
    must_change_password: boolean;
  }>(
    "select role, status, must_change_password from users where id=$1 for share",
    [actorId],
  );
  if (
    !actor ||
    actor.status !== "active" ||
    actor.must_change_password ||
    (actor.role !== "super_admin" && (withdraw || actor.role !== "admin"))
  )
    throw new DomainError(403, "Недостаточно прав для редакционного действия.");
}

async function version(
  sql: Sql,
  kind: KnowledgeEntityKind,
  id: string,
  revision?: number,
) {
  const row = (
    await sql.query<unknown>(
      `select kind,state,document from knowledge_editorial_revisions
       where kind=$1 and id=$2 and ($3::bigint is null or revision=$3)
       order by revision desc limit 1`,
      [kind, id, revision ?? null],
    )
  ).rows[0];
  return row ? stored(row) : null;
}

async function readSnapshot(
  sql: Sql,
  factKey: string,
  scope: KnowledgeScope,
  extra: Reference[] = [],
) {
  // Preserve the exact and global heads, including unusable heads that suppress
  // fallback. Both the cited source revision and its latest head are needed.
  const {
    rows: [result],
  } = await sql.query<Snapshot>(
    `with fact_heads as (
       select distinct on (id) id,state,document from knowledge_editorial_revisions
       where kind='fact' and fact_key=$1 and (scope=$2::jsonb or scope='{"kind":"global"}'::jsonb)
       order by id,revision desc limit 1001
     ), refs as (
       select item->'source'->>'id' as id, (item->'source'->>'revision')::bigint as revision
       from fact_heads cross join lateral jsonb_array_elements(document->'evidence') item
       union select id,revision from jsonb_to_recordset($3::jsonb) as extra(id text,revision bigint)
     ), cited as (
       select s.id,s.revision,s.state,s.document from refs join knowledge_editorial_revisions s
         on s.kind='source' and s.id=refs.id and s.revision=refs.revision
     ), source_heads as (
       select distinct on (s.id) s.id,s.revision,s.state,s.document
       from (select distinct id from refs) r join knowledge_editorial_revisions s on s.kind='source' and s.id=r.id
       order by s.id,s.revision desc
     ), sources as (
       (select * from cited union select * from source_heads) limit 1001
     )
     select ${utcNow} as now,
       coalesce((select jsonb_agg(jsonb_build_object('state',state,'document',document)) from fact_heads),'[]'::jsonb) facts,
       coalesce((select jsonb_agg(jsonb_build_object('state',state,'document',document)) from sources),'[]'::jsonb) sources`,
    [factKey, JSON.stringify(scope), JSON.stringify(extra)],
  );
  return result!;
}

function plan(
  snapshot: Snapshot,
  factKey: string,
  scope: KnowledgeScope,
  limit: number,
  proposed?: KnowledgeFact,
): KnowledgeLookupResult {
  const facts = proposed
    ? [
        ...snapshot.facts.filter(
          ({ document }) => (document as KnowledgeFact).id !== proposed.id,
        ),
        { state: "published", document: proposed },
      ]
    : snapshot.facts;
  const staleFact = new Set(
    facts
      .filter((row) => row.state === "stale")
      .map(({ document }) => (document as KnowledgeFact).id),
  );
  const staleSource = new Set(
    snapshot.sources
      .filter((row) => row.state === "stale")
      .map(({ document }) => {
        const source = document as Reference;
        return `${source.id}:${source.revision}`;
      }),
  );
  const result = planKnowledgeLookup({
    query: { factKey, scope, limit, asOf: snapshot.now },
    registry: {
      facts: facts.map((row) => row.document),
      sources: snapshot.sources.map((row) => row.document),
    },
  });
  // A persisted editorial stale state cannot be undone by a clock correction.
  if (
    result.status === "hit" &&
    result.matches.some(
      (match) =>
        staleFact.has(match.fact.id) ||
        match.evidence.some((item) =>
          staleSource.has(`${item.source.id}:${item.source.revision}`),
        ),
    )
  )
    return { status: "stale", researchNeeded: true, reason: "expired" };
  return result;
}

async function validateCandidateEvidence(sql: Sql, fact: KnowledgeFact) {
  const { rows } = await sql.query<{ document: unknown }>(
    `select s.document from jsonb_to_recordset($1::jsonb) r(id text,revision bigint)
       join knowledge_editorial_revisions s on s.kind='source' and s.id=r.id and s.revision=r.revision`,
    [JSON.stringify(fact.evidence.map((item) => item.source))],
  );
  const sources = new Map(
    rows.map(({ document }) => {
      const source = knowledgeSourceSchema.parse(document);
      return [source.id, source] as const;
    }),
  );
  if (
    !fact.evidence.every(({ source: reference, quote }) => {
      const source = sources.get(reference.id);
      return (
        source &&
        source.revision === reference.revision &&
        JSON.stringify(source.scope) === JSON.stringify(fact.scope) &&
        source.excerpt.includes(quote)
      );
    })
  )
    throw new DomainError(
      422,
      "Проверьте ссылку, цитату и применимость источника.",
    );
}

async function append(
  sql: Sql,
  actorId: string,
  value: KnowledgeEditorialVersion,
  previousRevision: number,
  now: string,
) {
  const { kind, state, document } = value;
  const { rows } = await sql.query(
    `insert into knowledge_editorial_revisions(kind,id,revision,fact_key,scope,state,document,occurred_at)
     values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::timestamptz)
     on conflict do nothing returning revision`,
    [
      kind,
      document.id,
      document.revision,
      kind === "fact" ? value.document.factKey : null,
      JSON.stringify(document.scope),
      state,
      JSON.stringify(document),
      now,
    ],
  );
  if (!rows.length)
    throw new DomainError(
      409,
      "Версия знания изменилась или ключ уже используется.",
    );
  const action = {
    candidate: "knowledge-candidate-proposed",
    published: "knowledge-published",
    stale: "knowledge-marked-stale",
    withdrawn: "knowledge-withdrawn",
  }[state];
  await sql.query(
    `insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)
       values($1,$2,$3,$4,$5::jsonb)`,
    [
      actorId,
      action,
      `knowledge-${kind}`,
      document.id,
      JSON.stringify({ previousRevision, revision: document.revision, state }),
    ],
  );
  return value;
}

/** Public, source-backed knowledge, independent of private account content. */
export class KnowledgeEditorialStore {
  constructor(private readonly db: Database) {}

  async editorial(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    revision?: number,
  ) {
    input(knowledgeEntityKindSchema, kind);
    input(knowledgeEntityIdSchema, id);
    return this.db.transaction(async (tx) => {
      await requireEditor(tx, actorId);
      const value = await version(tx, kind, id, revision);
      if (!value) throw new DomainError(404, "Версия знания не найдена.");
      return value;
    });
  }

  async lookup(raw: unknown) {
    const { factKey, scope, limit } = input(knowledgeLookupRequestSchema, raw);
    return plan(
      await readSnapshot(this.db, factKey, scope),
      factKey,
      scope,
      limit,
    );
  }

  async propose(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    raw: unknown,
  ) {
    input(knowledgeEntityKindSchema, kind);
    input(knowledgeEntityIdSchema, id);
    const proposal =
      kind === "source"
        ? input(knowledgeSourceCandidateRequestSchema, raw)
        : input(knowledgeFactCandidateRequestSchema, raw);
    return this.db.transaction(async (tx) => {
      await requireEditor(tx, actorId);
      const previous = await version(tx, kind, id);
      compareRevision(
        proposal.expectedRevision,
        previous?.document.revision ?? 0,
      );
      const now = await clock(tx);
      const value = input(knowledgeEditorialVersionSchema, {
        kind,
        state: "candidate",
        document: {
          ...proposal.draft,
          schemaVersion: 1,
          id,
          revision: proposal.expectedRevision + 1,
          publication: { status: "candidate", proposedAt: now },
        },
      });
      if (
        previous &&
        (JSON.stringify(previous.document.scope) !==
          JSON.stringify(value.document.scope) ||
          (previous.kind === "fact" &&
            value.kind === "fact" &&
            previous.document.factKey !== value.document.factKey))
      )
        throw new DomainError(
          409,
          "Для другого вопроса или области создайте новую запись.",
        );
      if (value.kind === "fact")
        await validateCandidateEvidence(tx, value.document);
      return append(tx, actorId, value, proposal.expectedRevision, now);
    });
  }

  async publish(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    raw: unknown,
  ) {
    const request = input(knowledgePublishRequestSchema, raw);
    return this.withCurrent(
      actorId,
      kind,
      id,
      request.expectedRevision,
      false,
      async (tx, current, now) => {
        if (current.state !== "candidate")
          throw new DomainError(409, "К публикации доступен только кандидат.");
        if (
          current.kind === "source" &&
          (current.document.provenance.kind === "synthetic" ||
            current.document.provenance.reuseBasis === "unassessed")
        )
          throw new DomainError(
            422,
            "Для публикации нужен проверенный источник с основанием использования.",
          );
        const value = input(knowledgeEditorialVersionSchema, {
          kind,
          state: "published",
          document: {
            ...current.document,
            revision: request.expectedRevision + 1,
            publication: {
              status: "published",
              reviewer: { kind: "editorial", id: actorId },
              reviewedAt: now,
              publishedAt: now,
              validUntil: request.validUntil,
            },
          },
        });
        if (value.kind === "fact") {
          const fact = value.document;
          const snapshot = await readSnapshot(
            tx,
            fact.factKey,
            fact.scope,
            fact.evidence.map((item) => item.source),
          );
          if (
            plan(snapshot, fact.factKey, fact.scope, 1, fact).status !== "hit"
          )
            throw new DomainError(
              422,
              "Для публикации нужны актуальные источники для всех цитат и области.",
            );
        }
        return append(tx, actorId, value, request.expectedRevision, now);
      },
    );
  }

  async markStale(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    raw: unknown,
  ) {
    const { expectedRevision } = input(knowledgeRevisionRequestSchema, raw);
    return this.withCurrent(
      actorId,
      kind,
      id,
      expectedRevision,
      false,
      (tx, current, now) => {
        const publication = current.document.publication;
        if (
          current.state !== "published" ||
          publication.status !== "published" ||
          Date.parse(publication.validUntil) > Date.parse(now)
        )
          throw new DomainError(
            409,
            "Устаревшей можно отметить публикацию с истёкшим сроком.",
          );
        const value = stored({
          kind,
          state: "stale",
          document: { ...current.document, revision: expectedRevision + 1 },
        });
        return append(tx, actorId, value, expectedRevision, now);
      },
    );
  }

  async withdraw(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    raw: unknown,
  ) {
    const { expectedRevision } = input(knowledgeRevisionRequestSchema, raw);
    return this.withCurrent(
      actorId,
      kind,
      id,
      expectedRevision,
      true,
      (tx, current, now) => {
        const publication = current.document.publication;
        if (publication.status !== "published")
          throw new DomainError(409, "Отозвать можно опубликованную версию.");
        const value = input(knowledgeEditorialVersionSchema, {
          kind,
          state: "withdrawn",
          document: {
            ...current.document,
            revision: expectedRevision + 1,
            publication: {
              ...publication,
              status: "withdrawn",
              withdrawnAt: now,
            },
          },
        });
        return append(tx, actorId, value, expectedRevision, now);
      },
    );
  }

  private withCurrent<T>(
    actorId: string,
    kind: KnowledgeEntityKind,
    id: string,
    expected: number,
    withdraw: boolean,
    apply: (
      sql: Sql,
      current: KnowledgeEditorialVersion,
      now: string,
    ) => Promise<T>,
  ) {
    input(knowledgeEntityKindSchema, kind);
    input(knowledgeEntityIdSchema, id);
    return this.db.transaction(async (tx) => {
      await requireEditor(tx, actorId, withdraw);
      const current = await version(tx, kind, id);
      if (!current) throw new DomainError(404, "Версия знания не найдена.");
      compareRevision(expected, current.document.revision);
      return apply(tx, current, await clock(tx));
    });
  }
}
