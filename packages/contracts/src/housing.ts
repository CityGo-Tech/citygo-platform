import { z } from "zod";

// CG-010 candidate DTOs. Parsing is NOT authorization, semantic validation,
// confirmation or award. No current endpoint consumes these contracts.
export const r1HousingIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(19)
  .refine(
    (id) => id.length < 19 || id <= "9223372036854775807",
    "ID exceeds int8",
  );
export const r1HousingRevisionSchema = z.number().int().min(1).max(2147483647);
const ref = z.strictObject({
  id: r1HousingIdSchema,
  revision: r1HousingRevisionSchema,
});
const planRef = z.strictObject({
  id: r1HousingIdSchema,
  version: r1HousingRevisionSchema,
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const uuid = z.uuid().toLowerCase();
const text = z
  .string()
  // Reject before trimming: controls must not disappear into a valid value.
  // In Unicode mode Cs matches unpaired surrogates, not valid emoji pairs.
  .refine(
    (value) => !/[\p{Cc}\p{Cs}]/u.test(value),
    "Invalid Unicode or control character",
  )
  .normalize("NFC")
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.replace(/[\s\p{C}\p{M}\u2800\u3164\uFFA0\u115F\u1160]/gu, "")
        .length > 0,
    "Text must contain visible content",
  );
const strings = z
  .array(text)
  .max(20)
  .refine((items) => new Set(items).size === items.length, "Duplicate text");
const rubles = z.number().int().min(0).max(1_000_000);
const rentRange = z
  .strictObject({ min: rubles.optional(), max: rubles.positive().optional() })
  .refine(
    (v) => v.min !== undefined || v.max !== undefined,
    "At least one bound required",
  )
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    "Invalid range",
  );
const date = z.iso
  .date()
  .refine((v) => v >= "1900-01-01" && v <= "2199-12-31", "Date out of range");
const moveTiming = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("month"),
    month: z.string().regex(/^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$/),
  }),
  z.strictObject({ kind: z.literal("on"), date }),
  z.strictObject({ kind: z.literal("before"), date }),
  z.strictObject({ kind: z.literal("after"), date }),
  z
    .strictObject({ kind: z.literal("range"), from: date, to: date })
    .refine((v) => v.from <= v.to, "Invalid dates"),
]);
const preferences = z.strictObject({
  items: strings,
  completeness: z.enum(["open", "complete"]),
});

// Server-written provenance. Clients/models cannot assert it through answer APIs.
const userStated = z.strictObject({
  kind: z.literal("user_stated"),
  eventId: uuid,
});
const profileImport = z.strictObject({
  kind: z.literal("profile_import"),
  eventId: uuid,
  profile: ref,
  userConfirmed: z.literal(true),
});
const explicitProvenance = z.discriminatedUnion("kind", [
  userStated,
  profileImport,
]);
const provenance = z.discriminatedUnion("kind", [
  userStated,
  z.strictObject({
    kind: z.literal("accepted_suggestion"),
    eventId: uuid,
    suggestionId: uuid,
    suggestionRevision: r1HousingRevisionSchema,
  }),
  profileImport,
]);
function answer<T extends z.ZodType>(value: T) {
  const revision = r1HousingRevisionSchema;
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unasked"), revision }),
    z.strictObject({
      status: z.literal("undecided"),
      revision,
      provenance: explicitProvenance,
      note: text.optional(),
    }),
    z.strictObject({
      status: z.literal("declined"),
      revision,
      provenance: explicitProvenance,
      note: text.optional(),
    }),
    z.strictObject({ status: z.literal("known"), revision, value, provenance }),
  ]);
}
function optionalAnswer<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("status", [
    ...answer(value).options,
    z.strictObject({
      status: z.literal("not_applicable"),
      revision: r1HousingRevisionSchema,
      provenance: explicitProvenance,
    }),
  ]);
}
const values = {
  stage: z.enum(["exploring", "decided", "preparing", "arrived"]),
  priority: z.enum([
    "understand_costs",
    "choose_housing",
    "prepare_search",
    "prepare_viewing",
    "settle_in",
  ]),
  monthlyRentRub: rentRange,
  upfrontBudgetRub: rubles,
  moveTiming,
  household: z.enum(["solo", "couple", "family"]),
  housingType: z.enum(["room", "studio", "apartment", "flexible"]),
  preferredAreas: preferences,
  commuteDestination: text,
  commuteMaxMinutes: z.number().int().min(1).max(240),
  mustHave: preferences,
  niceToHave: preferences,
} as const;
export const r1HousingFieldSchema = z.enum([
  "stage",
  "priority",
  "monthlyRentRub",
  "upfrontBudgetRub",
  "moveTiming",
  "household",
  "housingType",
  "preferredAreas",
  "commuteDestination",
  "commuteMaxMinutes",
  "mustHave",
  "niceToHave",
]);
export const r1HousingAnswersSchema = z.strictObject({
  stage: answer(values.stage),
  priority: answer(values.priority),
  monthlyRentRub: answer(values.monthlyRentRub),
  upfrontBudgetRub: answer(values.upfrontBudgetRub),
  moveTiming: answer(values.moveTiming),
  household: answer(values.household),
  housingType: answer(values.housingType),
  preferredAreas: optionalAnswer(values.preferredAreas),
  commuteDestination: optionalAnswer(values.commuteDestination),
  commuteMaxMinutes: optionalAnswer(values.commuteMaxMinutes),
  mustHave: optionalAnswer(values.mustHave),
  niceToHave: optionalAnswer(values.niceToHave),
});
export type R1HousingAnswers = z.infer<typeof r1HousingAnswersSchema>;
export type R1HousingField = z.infer<typeof r1HousingFieldSchema>;

// CG-012 commands carry intent, never a trusted snapshot/provenance. The caller
// supplies only its expected versions; the server assigns actor, event and time.
function answerChange<K extends keyof typeof values>(
  field: K,
  optional = false,
) {
  const states = [
    z.strictObject({ status: z.literal("known"), value: values[field] }),
    z.strictObject({ status: z.literal("undecided"), note: text.optional() }),
    z.strictObject({ status: z.literal("declined"), note: text.optional() }),
  ] as const;
  return z.strictObject({
    field: z.literal(field),
    expectedFieldRevision: r1HousingRevisionSchema,
    answer: optional
      ? z.discriminatedUnion("status", [
          ...states,
          z.strictObject({ status: z.literal("not_applicable") }),
        ])
      : z.discriminatedUnion("status", states),
  });
}
export const r1HousingAnswerChangeSchema = z.discriminatedUnion("field", [
  answerChange("stage"),
  answerChange("priority"),
  answerChange("monthlyRentRub"),
  answerChange("upfrontBudgetRub"),
  answerChange("moveTiming"),
  answerChange("household"),
  answerChange("housingType"),
  answerChange("preferredAreas", true),
  answerChange("commuteDestination", true),
  answerChange("commuteMaxMinutes", true),
  answerChange("mustHave", true),
  answerChange("niceToHave", true),
]);
export const r1HousingBriefCreateCommandSchema = z.strictObject({
  commandId: uuid,
  plan: planRef,
});
export const r1HousingAnswerCommandSchema = z.strictObject({
  commandId: uuid,
  plan: planRef,
  brief: ref,
  change: r1HousingAnswerChangeSchema,
});

export function createR1HousingAnswers(): R1HousingAnswers {
  return r1HousingAnswersSchema.parse(
    Object.fromEntries(
      r1HousingFieldSchema.options.map((field) => [
        field,
        { status: "unasked", revision: 1 },
      ]),
    ),
  );
}
// Candidates, NOT a questionnaire. A consumer must choose at most the relevant
// next question. The server's delivery history also excludes unanswered prompts.
// Declined/undecided or previously asked fields reopen through explicit user action.
export function r1HousingQuestionCandidates(
  answers: R1HousingAnswers,
  alreadyAsked: readonly R1HousingField[],
): R1HousingField[] {
  const delivered = new Set(alreadyAsked);
  return r1HousingFieldSchema.options.filter(
    (field) => answers[field].status === "unasked" && !delivered.has(field),
  );
}

function proposal<K extends keyof typeof values>(field: K) {
  return z.strictObject({ field: z.literal(field), value: values[field] });
}
export const r1HousingProposedValueSchema = z.discriminatedUnion("field", [
  proposal("stage"),
  proposal("priority"),
  proposal("monthlyRentRub"),
  proposal("upfrontBudgetRub"),
  proposal("moveTiming"),
  proposal("household"),
  proposal("housingType"),
  proposal("preferredAreas"),
  proposal("commuteDestination"),
  proposal("commuteMaxMinutes"),
  proposal("mustHave"),
  proposal("niceToHave"),
]);
export const r1HousingSuggestionSchema = z.strictObject({
  id: uuid,
  revision: r1HousingRevisionSchema,
  status: z.enum(["pending", "accepted", "rejected"]),
  proposal: r1HousingProposedValueSchema,
  explanation: text,
});
const fieldRef = z.strictObject({
  field: r1HousingFieldSchema,
  revision: r1HousingRevisionSchema,
});
const dependencies = z
  .array(fieldRef)
  .max(r1HousingFieldSchema.options.length)
  .refine(
    (items) => new Set(items.map((item) => item.field)).size === items.length,
    "Duplicate field dependency",
  );
const nextStep = z.strictObject({ key, title: text, explanation: text });
const starterPlan = z.strictObject({
  summary: text,
  basedOn: dependencies.min(1),
  nextSteps: z
    .array(nextStep)
    .min(1)
    .max(5)
    .refine(
      (items) => new Set(items.map((item) => item.key)).size === items.length,
      "Duplicate next step",
    ),
});
const housingBriefShape = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("housing_brief"),
  purpose: z.literal("rental_search_preparation"),
  destination: z.strictObject({
    countryCode: z.literal("RU"),
    cityCode: z.literal("RU-MOW"),
  }),
  answers: r1HousingAnswersSchema,
  suggestions: z
    .array(r1HousingSuggestionSchema)
    // Current projection only: up to 20 pending + 12 referenced accepted items.
    // All terminal/history entries stay in CG-012's immutable event journal.
    .max(20 + r1HousingFieldSchema.options.length)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Duplicate suggestion",
    ),
  starterPlan: starterPlan.nullable(),
});

// Compare normalized typed JSON values; object property order is not meaningful.
// This is not the canonical hashing/receipt implementation.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = Object.entries(b).filter(([, value]) => value !== undefined);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        sameValue(value, (b as Record<string, unknown>)[key]),
    )
  );
}
function validateSuggestionSources(
  v: z.infer<typeof housingBriefShape>,
  ctx: z.RefinementCtx,
) {
  const referenced = new Set<string>();
  for (const field of r1HousingFieldSchema.options) {
    const answer = v.answers[field];
    if (
      answer.status !== "known" ||
      answer.provenance.kind !== "accepted_suggestion"
    )
      continue;
    const source = answer.provenance;
    referenced.add(source.suggestionId);
    const suggestion = v.suggestions.find(
      (item) => item.id === source.suggestionId,
    );
    if (
      !suggestion ||
      suggestion.status !== "accepted" ||
      suggestion.revision !== source.suggestionRevision ||
      suggestion.proposal.field !== field ||
      !sameValue(suggestion.proposal.value, answer.value)
    )
      ctx.addIssue({
        code: "custom",
        path: ["answers", field, "provenance"],
        message:
          "Accepted suggestion must match the current answer and revision",
      });
  }
  if (v.suggestions.filter((item) => item.status === "pending").length > 20)
    ctx.addIssue({
      code: "custom",
      path: ["suggestions"],
      message: "Too many pending suggestions",
    });
  for (const [index, item] of v.suggestions.entries()) {
    if (
      item.status === "rejected" ||
      (item.status === "accepted" && !referenced.has(item.id))
    )
      ctx.addIssue({
        code: "custom",
        path: ["suggestions", index],
        message:
          "Historical suggestions belong in the event journal, not the current projection",
      });
  }
}
export const r1HousingBriefDraftSchema = housingBriefShape.superRefine(
  validateSuggestionSources,
);

// A structural non-empty basis, not a semantic/usefulness verdict.
function informativeAnswer(
  answers: R1HousingAnswers,
  field: R1HousingField,
): boolean {
  const answer = answers[field];
  if (answer.status !== "known") return false;
  if (
    field === "preferredAreas" ||
    field === "mustHave" ||
    field === "niceToHave"
  ) {
    const preference = answers[field];
    return preference.status === "known" && preference.value.items.length > 0;
  }
  if (field === "monthlyRentRub" && answers.monthlyRentRub.status === "known") {
    const range = answers.monthlyRentRub.value;
    // An explicit ceiling, even the technical maximum, is still user information.
    return (
      range.max !== undefined || (range.min !== undefined && range.min > 0)
    );
  }
  return true;
}

// Structural candidate for a starter result, NOT a full-search gate or award.
// Server must also check provenance/history and actual usefulness (CG-012/014/024).
export const r1HousingBriefPreparedSchema = housingBriefShape
  .extend({ starterPlan })
  .superRefine(validateSuggestionSources)
  .superRefine((v, ctx) => {
    for (const dependency of v.starterPlan.basedOn) {
      const current = v.answers[dependency.field];
      if (current.revision !== dependency.revision)
        ctx.addIssue({
          code: "custom",
          path: ["starterPlan", "basedOn"],
          message: "Basis must reference a current answer revision",
        });
    }
    if (
      !v.starterPlan.basedOn.some((d) => informativeAnswer(v.answers, d.field))
    )
      ctx.addIssue({
        code: "custom",
        path: ["starterPlan", "basedOn"],
        message: "Use at least one stated situation or priority",
      });
  })
  .brand<"R1HousingBriefPrepared">();

export const r1ViewingSectionIds = [
  "budget_and_payments",
  "authority_and_documents",
  "condition_and_utilities",
  "terms_and_handover",
  "area_and_commute",
  "personal_requirements",
  "next_steps",
] as const;
export const r1ViewingChecklistDraftSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("viewing_checklist"),
    purpose: z.literal("viewing_preparation"),
    // Historical origin; unrelated answer changes need not invalidate every section.
    housingBrief: ref.nullable(),
    sections: z
      .array(
        z.strictObject({
          id: z.enum(r1ViewingSectionIds),
          questions: strings.max(8),
          basedOn: dependencies,
        }),
      )
      .max(r1ViewingSectionIds.length)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Duplicate section",
      ),
  })
  .superRefine((v, ctx) => {
    if (
      !v.housingBrief &&
      v.sections.some((section) => section.basedOn.length > 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["housingBrief"],
        message: "Personalized sections require a source brief",
      });
  });
export const r1ViewingChecklistPreparedSchema = r1ViewingChecklistDraftSchema
  .superRefine((v, ctx) => {
    if (
      v.sections.length !== r1ViewingSectionIds.length ||
      v.sections.some((section) => section.questions.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Every section must have preparation questions",
      });
  })
  .brand<"R1ViewingChecklistPrepared">();

export const r1HousingArtifactDraftContentSchema = z.discriminatedUnion(
  "kind",
  [r1HousingBriefDraftSchema, r1ViewingChecklistDraftSchema],
);
export const r1HousingArtifactPreparedContentSchema = z.union([
  r1HousingBriefPreparedSchema,
  r1ViewingChecklistPreparedSchema,
]);

// Caller still authorizes the graph and enforces immutable, monotonic revisions.
// Identity mismatch fails closed even if all field revision numbers happen to match.
export function r1ViewingSectionsNeedingUpdate(
  checklist: z.infer<typeof r1ViewingChecklistDraftSchema>,
  currentBrief: (z.infer<typeof ref> & { answers: R1HousingAnswers }) | null,
) {
  if (!checklist.housingBrief) return [];
  if (
    !currentBrief ||
    currentBrief.id !== checklist.housingBrief.id ||
    currentBrief.revision < checklist.housingBrief.revision
  )
    throw new Error("Housing brief reference mismatch");
  return checklist.sections
    .filter((section) =>
      section.basedOn.some(
        (dependency) =>
          currentBrief.answers[dependency.field].revision !==
          dependency.revision,
      ),
    )
    .map((section) => section.id);
}

// Fixed two-quest candidate. Prerequisites govern AWARDS, never access to help.
export const r1HousingQuestDefinitions = Object.freeze({
  "housing-brief": Object.freeze({
    status: "candidate",
    definitionVersion: 1,
    criteriaVersion: 1,
    rewardVersion: 1,
    confirmationCopyVersion: 1,
    awardScope: "r1-pilot",
    completionMode: "explicit_command",
    xpReward: 60,
    artifactKind: "housing_brief",
    awardPrerequisite: null,
    nextQuestSlug: "housing-viewing",
  } as const),
  "housing-viewing": Object.freeze({
    status: "candidate",
    definitionVersion: 1,
    criteriaVersion: 1,
    rewardVersion: 1,
    confirmationCopyVersion: 1,
    awardScope: "r1-pilot",
    completionMode: "explicit_command",
    xpReward: 60,
    artifactKind: "viewing_checklist",
    awardPrerequisite: "housing-brief",
    nextQuestSlug: null,
  } as const),
});
const intentBase = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: uuid,
  plan: planRef,
  questId: r1HousingIdSchema,
  artifact: ref,
  contentSha256: digest,
  unresolvedFieldsSha256: digest,
  acknowledgements: z.strictObject({
    reviewedResult: z.literal(true),
    preparationOnly: z.literal(true),
  }),
});
function intentFor<K extends keyof typeof r1HousingQuestDefinitions>(slug: K) {
  const definition = r1HousingQuestDefinitions[slug];
  return intentBase.extend({
    questSlug: z.literal(slug),
    definitionVersion: z.literal(definition.definitionVersion),
    criteriaVersion: z.literal(definition.criteriaVersion),
    rewardVersion: z.literal(definition.rewardVersion),
    confirmationCopyVersion: z.literal(definition.confirmationCopyVersion),
  });
}
// Hashes echo a server snapshot, NOT proof of reading. The first quest requires
// the user's explicit choice of an offered next step from that exact revision.
export const r1HousingConfirmationIntentSchema = z.discriminatedUnion(
  "questSlug",
  [
    intentFor("housing-brief").extend({ selectedNextStepKey: key }),
    intentFor("housing-viewing"),
  ],
);

export type R1HousingBriefDraft = z.infer<typeof r1HousingBriefDraftSchema>;
export type R1HousingBriefPrepared = z.infer<
  typeof r1HousingBriefPreparedSchema
>;
export type R1ViewingChecklistDraft = z.infer<
  typeof r1ViewingChecklistDraftSchema
>;
export type R1ViewingChecklistPrepared = z.infer<
  typeof r1ViewingChecklistPreparedSchema
>;
export type R1HousingConfirmationIntent = z.infer<
  typeof r1HousingConfirmationIntentSchema
>;
