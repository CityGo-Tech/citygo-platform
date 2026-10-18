import {
  knowledgeLookupInputSchema,
  knowledgeLookupResultSchema,
  type KnowledgeFact,
  type KnowledgeLookupResult,
  type KnowledgeMatch,
  type KnowledgePublication,
  type KnowledgeScope,
  type KnowledgeSource,
} from "@citygo/contracts";

const sameScope = (a: KnowledgeScope, b: KnowledgeScope): boolean =>
  a.kind === b.kind &&
  (a.kind === "global" ||
    (a.kind === "city" && b.kind === "city" && a.cityId === b.cityId) ||
    (a.kind === "route" &&
      b.kind === "route" &&
      a.originCityId === b.originCityId &&
      a.destinationCityId === b.destinationCityId));
const relevant = (scope: KnowledgeScope, query: KnowledgeScope) =>
  scope.kind === "global" || sameScope(scope, query);
const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function publicationTimes(publication: KnowledgePublication): string[] {
  return publication.status === "candidate"
    ? [publication.proposedAt]
    : [
        publication.reviewedAt,
        publication.publishedAt,
        ...(publication.status === "withdrawn"
          ? [publication.withdrawnAt]
          : []),
      ];
}

// Parsing gives canonical property order. Exact duplicate rows are harmless;
// Different contents for one immutable (id, revision), or an identity change
// across revisions of one id, poison the snapshot BEFORE query filtering.
function heads<T extends { id: string; revision: number }>(
  rows: T[],
  sameIdentity: (a: T, b: T) => boolean,
) {
  const byVersion = new Map<string, T>();
  const current = new Map<string, T>();
  for (const row of rows) {
    const previousHead = current.get(row.id);
    if (previousHead && !sameIdentity(previousHead, row)) return null;
    const version = JSON.stringify([row.id, row.revision]);
    const previous = byVersion.get(version);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      return null;
    byVersion.set(version, row);
    if (!current.has(row.id) || current.get(row.id)!.revision < row.revision)
      current.set(row.id, row);
  }
  return { byVersion, current };
}

const conflict = (
  reason: Extract<KnowledgeLookupResult, { status: "conflict" }>["reason"],
): KnowledgeLookupResult => ({
  status: "conflict",
  researchNeeded: false,
  reason,
});

/**
 * Deterministic offline policy, not a search engine or authorization gateway.
 * No clock, I/O, network, callbacks or provider calls; asOf is explicit.
 * A caller must enforce real publication authority before supplying this input.
 */
export function planKnowledgeLookup(input: unknown): KnowledgeLookupResult {
  const parsed = knowledgeLookupInputSchema.safeParse(input);
  if (!parsed.success) return conflict("invalid_input");
  const { query, registry } = parsed.data;
  const asOf = Date.parse(query.asOf);
  if (
    registry.sources.some((source) =>
      [
        source.provenance.retrievedAt,
        ...publicationTimes(source.publication),
      ].some((time) => Date.parse(time) > asOf),
    ) ||
    registry.facts.some((fact) =>
      publicationTimes(fact.publication).some(
        (time) => Date.parse(time) > asOf,
      ),
    )
  )
    return conflict("future_record");

  const sources = heads(registry.sources, (a, b) =>
    sameScope(a.scope, b.scope),
  );
  const facts = heads(
    registry.facts,
    (a, b) => a.factKey === b.factKey && sameScope(a.scope, b.scope),
  );
  if (!sources || !facts) return conflict("version_conflict");
  const candidates = [...facts.current.values()].filter(
    (fact) =>
      fact.factKey === query.factKey && relevant(fact.scope, query.scope),
  );
  if (!candidates.length)
    return { status: "miss", researchNeeded: true, reason: "not_found" };

  // Exact city/route takes precedence over global advice for the same factKey.
  // An unusable exact entry MUST NOT fall back to a weaker global assertion.
  const exact = candidates.filter((fact) => sameScope(fact.scope, query.scope));
  const selected = exact.length ? exact : candidates;
  selected.sort((a, b) => compareKeys(a.id, b.id));

  const failures: KnowledgeLookupResult[] = [];
  const matches: KnowledgeMatch[] = [];
  for (const fact of selected) {
    const result = matchFact(fact, sources, asOf);
    if ("status" in result) failures.push(result);
    else matches.push(result);
  }
  // Any applicable integrity/withdrawal/expiry failure blocks the entire answer;
  // do not silently select the one surviving fact and hide conflicting evidence.
  if (failures.length) {
    const priority: KnowledgeLookupResult["status"][] = [
      "conflict",
      "stale",
      "miss",
    ];
    return failures.sort(
      (a, b) => priority.indexOf(a.status) - priority.indexOf(b.status),
    )[0]!;
  }
  if (new Set(matches.map((match) => match.statement)).size !== 1)
    return conflict("ambiguous_claims");
  return knowledgeLookupResultSchema.parse({
    status: "hit",
    researchNeeded: false,
    matches: matches.slice(0, query.limit),
  });
}

function matchFact(
  fact: KnowledgeFact,
  sources: NonNullable<ReturnType<typeof heads<KnowledgeSource>>>,
  asOf: number,
): KnowledgeMatch | KnowledgeLookupResult {
  const publication = fact.publication;
  if (publication.status !== "published")
    return {
      status: "miss",
      researchNeeded: true,
      reason: publication.status === "withdrawn" ? "withdrawn" : "unpublished",
    };
  if (Date.parse(publication.validUntil) <= asOf)
    return { status: "stale", researchNeeded: true, reason: "expired" };
  const evidence: KnowledgeMatch["evidence"] = [];
  let expiresAt = Date.parse(publication.validUntil);
  for (const item of [...fact.evidence].sort((a, b) =>
    compareKeys(a.source.id, b.source.id),
  )) {
    const source = sources.byVersion.get(
      JSON.stringify([item.source.id, item.source.revision]),
    );
    if (!source)
      return { status: "miss", researchNeeded: true, reason: "missing_source" };
    if (source.provenance.kind === "synthetic")
      return {
        status: "miss",
        researchNeeded: true,
        reason: "synthetic_source",
      };
    const latest = sources.current.get(item.source.id)!;
    if (latest.publication.status === "withdrawn")
      return { status: "miss", researchNeeded: true, reason: "withdrawn" };
    if (latest.revision !== source.revision)
      return {
        status: "stale",
        researchNeeded: true,
        reason: "superseded_source",
      };
    const sourcePublication = source.publication;
    if (sourcePublication.status !== "published")
      return { status: "miss", researchNeeded: true, reason: "unpublished" };
    if (
      !sameScope(source.scope, fact.scope) ||
      !source.excerpt.includes(item.quote) ||
      Date.parse(sourcePublication.publishedAt) >
        Date.parse(publication.reviewedAt)
    )
      return conflict("invalid_evidence");
    if (Date.parse(sourcePublication.validUntil) <= asOf)
      return { status: "stale", researchNeeded: true, reason: "expired" };
    expiresAt = Math.min(expiresAt, Date.parse(sourcePublication.validUntil));
    evidence.push({
      source: item.source,
      title: source.title,
      url: source.url,
      quote: item.quote,
      reviewedAt: sourcePublication.reviewedAt,
      validUntil: sourcePublication.validUntil,
    });
  }
  return {
    fact: { id: fact.id, revision: fact.revision },
    factKey: fact.factKey,
    statement: fact.statement,
    scope: fact.scope,
    reviewedAt: publication.reviewedAt,
    validUntil: new Date(expiresAt).toISOString(),
    evidence,
  };
}
