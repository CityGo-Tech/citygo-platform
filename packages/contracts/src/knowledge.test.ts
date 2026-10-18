import assert from "node:assert/strict";
import test from "node:test";
import {
  knowledgeFactSchema,
  knowledgeLookupInputSchema,
  knowledgeLookupResultSchema,
  knowledgePublicationSchema,
  knowledgeQuerySchema,
  knowledgeRegistrySchema,
  knowledgeScopeSchema,
  knowledgeSourceSchema,
} from "./knowledge.js";

const published = () => ({
  status: "published" as const,
  reviewer: { kind: "editorial" as const, id: "synthetic-editor" },
  reviewedAt: "2026-10-17T08:10:00Z",
  publishedAt: "2026-10-17T08:20:00Z",
  validUntil: "2026-10-25T00:00:00Z",
});
const source = () => ({
  schemaVersion: 1 as const,
  id: "synthetic-source",
  revision: 1,
  title: "Синтетический источник, не городская рекомендация",
  url: "https://source.example/guide",
  scope: { kind: "city" as const, cityId: "ru-moscow" },
  excerpt: "Синтетический пример проверяемой цитаты.",
  provenance: {
    kind: "synthetic" as const,
    publisher: "Тестовая редакция",
    retrievedAt: "2026-10-17T08:00:00Z",
    reuseBasis: "link_and_short_excerpt" as const,
  },
  publication: published(),
});
const fact = () => ({
  schemaVersion: 1 as const,
  id: "synthetic-fact",
  revision: 1,
  factKey: "transport.payment",
  statement: "Тестовое утверждение, не реальный совет.",
  scope: { kind: "city" as const, cityId: "ru-moscow" },
  provenance: { kind: "research" as const, processId: "synthetic-run" },
  evidence: [
    {
      source: { id: "synthetic-source", revision: 1 },
      quote: "Синтетический пример проверяемой цитаты.",
    },
  ],
  publication: published(),
});

test("knowledge contracts distinguish city, global and directional route scopes", () => {
  for (const scope of [
    { kind: "global" },
    { kind: "city", cityId: "ru-moscow" },
    { kind: "route", originCityId: "ru-perm", destinationCityId: "ru-moscow" },
  ])
    assert.equal(knowledgeScopeSchema.safeParse(scope).success, true);
  for (const scope of [
    { kind: "city" },
    { kind: "route", destinationCityId: "ru-moscow" },
    { kind: "global", cityId: "ru-moscow" },
    { kind: "city", cityId: "RU Moscow" },
  ])
    assert.equal(knowledgeScopeSchema.safeParse(scope).success, false);
});

test("candidate never needs fictitious review metadata; published/withdrawn require chronology", () => {
  assert.equal(
    knowledgePublicationSchema.safeParse({
      status: "candidate",
      proposedAt: "2026-10-17T08:00:00Z",
    }).success,
    true,
  );
  assert.equal(knowledgePublicationSchema.safeParse(published()).success, true);
  assert.equal(
    knowledgePublicationSchema.safeParse({
      ...published(),
      status: "withdrawn",
      withdrawnAt: "2026-10-18T00:00:00Z",
    }).success,
    true,
  );
  for (const publication of [
    { status: "published" },
    { ...published(), reviewedAt: "2026-10-17T09:00:00Z" },
    { ...published(), validUntil: "2026-10-17T08:20:00Z" },
    {
      ...published(),
      status: "withdrawn",
      withdrawnAt: "2026-10-16T00:00:00Z",
    },
    { ...published(), reviewer: { kind: "model", id: "model" } },
    { status: "candidate", proposedAt: "not-a-date" },
  ])
    assert.equal(
      knowledgePublicationSchema.safeParse(publication).success,
      false,
    );
});

test("sources require bounded provenance, public URL shape and assessed published reuse", () => {
  assert.equal(knowledgeSourceSchema.safeParse(source()).success, true);
  const original = source();
  for (const input of [
    { ...original, url: "http://source.example/guide" },
    { ...original, url: "https://user:password@source.example/" },
    { ...original, url: "file:///tmp/example" },
    { ...original, excerpt: "" },
    { ...original, excerpt: "a".repeat(16001) },
    {
      ...original,
      publication: { ...published(), reviewedAt: "2026-10-17T07:00:00Z" },
    },
    {
      ...original,
      provenance: { ...original.provenance, reuseBasis: "unassessed" },
    },
    { ...original, provenance: { ...original.provenance, accountId: "123" } },
  ])
    assert.equal(knowledgeSourceSchema.safeParse(input).success, false);
  assert.equal(
    knowledgeSourceSchema.safeParse({
      ...original,
      provenance: { ...original.provenance, reuseBasis: "unassessed" },
      publication: { status: "candidate", proposedAt: "2026-10-17T08:00:00Z" },
    }).success,
    true,
  );
});

test("facts reject private-shaped fields, missing/duplicate evidence and unsafe revisions", () => {
  assert.equal(knowledgeFactSchema.safeParse(fact()).success, true);
  for (const input of [
    { ...fact(), userId: "123" },
    { ...fact(), messages: [] },
    { ...fact(), statement: " " },
    { ...fact(), revision: 0 },
    { ...fact(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...fact(), evidence: [] },
    { ...fact(), evidence: [...fact().evidence, ...fact().evidence] },
    { ...fact(), evidence: [{ ...fact().evidence[0], source: { id: "x" } }] },
  ])
    assert.equal(knowledgeFactSchema.safeParse(input).success, false);
  // No PII detector: text can contain personal data despite valid shape.
  assert.equal(
    knowledgeFactSchema.safeParse({ ...fact(), statement: "name@example.com" })
      .success,
    true,
  );
});

test("lookup has explicit time, bounded catalog/query and no arbitrary URL instruction", () => {
  const query = {
    factKey: "transport.payment",
    scope: { kind: "city", cityId: "ru-moscow" },
    asOf: "2026-10-18T00:00:00Z",
  };
  assert.equal(knowledgeQuerySchema.parse(query).limit, 5);
  assert.equal(
    knowledgeLookupInputSchema.safeParse({
      query,
      registry: { sources: [], facts: [] },
    }).success,
    true,
  );
  for (const input of [
    { ...query, asOf: undefined },
    { ...query, limit: 21 },
    { ...query, queryUrl: "https://source.example" },
  ])
    assert.equal(knowledgeQuerySchema.safeParse(input).success, false);
  assert.equal(
    knowledgeRegistrySchema.safeParse({
      sources: Array(1001).fill(source()),
      facts: [],
    }).success,
    false,
  );
});

test("lookup results cannot promise research on conflict or expose matches on a miss", () => {
  for (const result of [
    { status: "miss", reason: "not_found", researchNeeded: true },
    { status: "stale", reason: "expired", researchNeeded: true },
    { status: "conflict", reason: "version_conflict", researchNeeded: false },
  ])
    assert.equal(knowledgeLookupResultSchema.safeParse(result).success, true);
  for (const result of [
    { status: "miss", reason: "not_found", researchNeeded: true, matches: [] },
    { status: "hit", researchNeeded: false, matches: [] },
    { status: "conflict", reason: "version_conflict", researchNeeded: true },
  ])
    assert.equal(knowledgeLookupResultSchema.safeParse(result).success, false);
});
