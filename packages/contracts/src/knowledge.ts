import { z } from "zod";

// Offline knowledge contracts only. Parsing does not verify truth, permissions,
// the public nature of text, a live URL or a person's identity.
const key = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true }).max(40);
const text = (max: number) => z.string().trim().min(1).max(max);
export const knowledgeReferenceSchema = z.strictObject({ id: key, revision });
export const knowledgeScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("city"), cityId: key }),
  z.strictObject({
    kind: z.literal("route"),
    originCityId: key,
    destinationCityId: key,
  }),
]);

const reviewer = z.strictObject({ kind: z.literal("editorial"), id: key });
export const knowledgePublicationSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("candidate"), proposedAt: instant }),
    z.strictObject({
      status: z.literal("published"),
      reviewer,
      reviewedAt: instant,
      publishedAt: instant,
      validUntil: instant,
    }),
    z.strictObject({
      status: z.literal("withdrawn"),
      reviewer,
      reviewedAt: instant,
      publishedAt: instant,
      validUntil: instant,
      withdrawnAt: instant,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.status === "candidate") return;
    if (
      Date.parse(value.reviewedAt) > Date.parse(value.publishedAt) ||
      Date.parse(value.publishedAt) >= Date.parse(value.validUntil)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid publication chronology",
      });
    if (
      value.status === "withdrawn" &&
      Date.parse(value.withdrawnAt) < Date.parse(value.publishedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Withdrawal precedes publication",
      });
  });

export const knowledgeSourceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: key,
    revision,
    title: text(300),
    url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }, "Credentials are not source provenance"),
    scope: knowledgeScopeSchema,
    excerpt: text(16000),
    provenance: z.strictObject({
      kind: z.enum(["synthetic", "official", "primary", "secondary"]),
      publisher: text(300),
      retrievedAt: instant,
      reuseBasis: z.enum([
        "unassessed",
        "link_and_short_excerpt",
        "permission",
      ]),
    }),
    publication: knowledgePublicationSchema,
  })
  .superRefine((value, ctx) => {
    const publication = value.publication;
    const checkedAt =
      publication.status === "candidate"
        ? publication.proposedAt
        : publication.reviewedAt;
    if (Date.parse(value.provenance.retrievedAt) > Date.parse(checkedAt))
      ctx.addIssue({
        code: "custom",
        message: "Retrieval follows review/proposal",
      });
    if (
      publication.status !== "candidate" &&
      value.provenance.reuseBasis === "unassessed"
    )
      ctx.addIssue({
        code: "custom",
        message: "Published reuse basis required",
      });
  });

export const knowledgeFactSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: key,
    revision,
    // Stable editorial question key, not an arbitrary user message/search query.
    factKey: key,
    statement: text(4000),
    scope: knowledgeScopeSchema,
    provenance: z.strictObject({
      kind: z.enum(["research", "editorial"]),
      processId: key,
    }),
    evidence: z
      .array(
        z.strictObject({
          source: knowledgeReferenceSchema,
          quote: text(4000),
        }),
      )
      .min(1)
      .max(8),
    publication: knowledgePublicationSchema,
  })
  .superRefine((value, ctx) => {
    const references = value.evidence.map((item) => item.source.id);
    if (new Set(references).size !== references.length)
      ctx.addIssue({ code: "custom", message: "Duplicate evidence source" });
  });

export const knowledgeRegistrySchema = z.strictObject({
  sources: z.array(knowledgeSourceSchema).max(1000),
  facts: z.array(knowledgeFactSchema).max(1000),
});
export const knowledgeQuerySchema = z.strictObject({
  factKey: key,
  scope: knowledgeScopeSchema,
  asOf: instant,
  limit: z.number().int().min(1).max(20).default(5),
});
export const knowledgeLookupInputSchema = z.strictObject({
  query: knowledgeQuerySchema,
  registry: knowledgeRegistrySchema,
});

export const knowledgeMatchSchema = z.strictObject({
  fact: knowledgeReferenceSchema,
  factKey: key,
  statement: text(4000),
  scope: knowledgeScopeSchema,
  reviewedAt: instant,
  // Effective expiry: the earliest of the fact and every supporting source.
  validUntil: instant,
  evidence: z
    .array(
      z.strictObject({
        source: knowledgeReferenceSchema,
        title: text(300),
        url: z.url({ protocol: /^https$/ }).max(2048),
        quote: text(4000),
        reviewedAt: instant,
        validUntil: instant,
      }),
    )
    .min(1)
    .max(8),
});
export const knowledgeLookupResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("hit"),
    researchNeeded: z.literal(false),
    matches: z.array(knowledgeMatchSchema).min(1).max(20),
  }),
  z.strictObject({
    status: z.literal("miss"),
    researchNeeded: z.literal(true),
    reason: z.enum([
      "not_found",
      "unpublished",
      "withdrawn",
      "missing_source",
      "synthetic_source",
    ]),
  }),
  z.strictObject({
    status: z.literal("stale"),
    researchNeeded: z.literal(true),
    reason: z.enum(["expired", "superseded_source"]),
  }),
  z.strictObject({
    status: z.literal("conflict"),
    // Human/integrity review first, never an automatic paid research request.
    researchNeeded: z.literal(false),
    reason: z.enum([
      "invalid_input",
      "future_record",
      "version_conflict",
      "ambiguous_claims",
      "invalid_evidence",
    ]),
  }),
]);

export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;
export type KnowledgePublication = z.infer<typeof knowledgePublicationSchema>;
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeFact = z.infer<typeof knowledgeFactSchema>;
export type KnowledgeMatch = z.infer<typeof knowledgeMatchSchema>;
export type KnowledgeLookupResult = z.infer<typeof knowledgeLookupResultSchema>;
