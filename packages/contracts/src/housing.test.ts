import assert from "node:assert/strict";
import test from "node:test";
import {
  createR1HousingAnswers,
  r1HousingAnswersSchema,
  r1HousingFieldSchema,
  r1HousingBriefDraftSchema,
  r1HousingBriefPreparedSchema,
  r1HousingArtifactDraftContentSchema,
  r1HousingArtifactPreparedContentSchema,
  r1ViewingChecklistDraftSchema,
  r1ViewingChecklistPreparedSchema,
  r1ViewingSectionIds,
  r1HousingConfirmationIntentSchema,
  r1HousingQuestDefinitions,
  r1HousingIdSchema,
  r1HousingRevisionSchema,
  r1HousingQuestionCandidates,
  r1ViewingSectionsNeedingUpdate,
  r1HousingSuggestionSchema,
  type R1HousingField,
} from "./housing.js";
import { completionSchema } from "./platform.js";

// Synthetic schema fixtures, not recommendations or proof of runtime checks.
const uuid = "7c31f2e0-76ef-4e1c-876a-fd546cf2d6f4";
const userProvenance = { kind: "user_stated", eventId: uuid } as const;
function known(value: unknown, revision = 1) {
  return {
    status: "known",
    revision,
    value,
    provenance: userProvenance,
  };
}
function blankBrief() {
  return r1HousingBriefDraftSchema.parse({
    schemaVersion: 1,
    kind: "housing_brief",
    purpose: "rental_search_preparation",
    destination: { countryCode: "RU", cityCode: "RU-MOW" },
    answers: createR1HousingAnswers(),
    suggestions: [],
    starterPlan: null,
  });
}
function starterBrief() {
  const brief = blankBrief();
  brief.answers.stage = {
    status: "known",
    revision: 1,
    value: "exploring",
    provenance: userProvenance,
  };
  brief.starterPlan = {
    summary: "Сначала разберём неизвестные расходы и способы поиска жилья.",
    basedOn: [{ field: "stage", revision: 1 }],
    nextSteps: [
      {
        key: "understand-costs",
        title: "Разобраться в расходах",
        explanation: "Составить список статей бюджета без выдуманных цен.",
      },
    ],
  };
  return brief;
}
function checklist() {
  return r1ViewingChecklistDraftSchema.parse({
    schemaVersion: 1,
    kind: "viewing_checklist",
    purpose: "viewing_preparation",
    housingBrief: null,
    sections: r1ViewingSectionIds.map((id) => ({
      id,
      questions: ["Что ещё нужно уточнить перед просмотром?"],
      basedOn: [],
    })),
  });
}
function intent(
  slug: keyof typeof r1HousingQuestDefinitions = "housing-brief",
) {
  const definition = r1HousingQuestDefinitions[slug];
  return {
    schemaVersion: 1,
    requestId: uuid,
    plan: { id: "42", version: 3 },
    questId: "12",
    artifact: { id: "51", revision: 2 },
    questSlug: slug,
    definitionVersion: definition.definitionVersion,
    criteriaVersion: definition.criteriaVersion,
    rewardVersion: definition.rewardVersion,
    confirmationCopyVersion: definition.confirmationCopyVersion,
    contentSha256: "a".repeat(64),
    unresolvedFieldsSha256: "b".repeat(64),
    acknowledgements: { reviewedResult: true, preparationOnly: true },
    ...(slug === "housing-brief"
      ? { selectedNextStepKey: "understand-costs" }
      : {}),
  };
}
function acceptsAnswer(field: R1HousingField, value: unknown) {
  return r1HousingAnswersSchema.safeParse({
    ...createR1HousingAnswers(),
    [field]: value,
  }).success;
}

test("empty stored draft uses unasked, without invented reasons or a result", () => {
  const brief = blankBrief();
  assert.equal(
    Object.keys(brief.answers).length,
    r1HousingFieldSchema.options.length,
  );
  assert.ok(Object.values(brief.answers).every((a) => a.status === "unasked"));
  assert.equal(
    r1HousingArtifactDraftContentSchema.safeParse(brief).success,
    true,
  );
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, false);
  assert.equal(
    r1HousingArtifactPreparedContentSchema.safeParse(brief).success,
    false,
  );
});

for (const status of ["unasked", "undecided", "declined"] as const) {
  test("useful starter allows budget, date and housing type " + status, () => {
    const brief = starterBrief();
    for (const field of [
      "monthlyRentRub",
      "moveTiming",
      "housingType",
      "household",
    ] as const)
      brief.answers[field] =
        status === "unasked"
          ? { status, revision: 1 }
          : { status, revision: 1, provenance: userProvenance };
    assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, true);
  });
}

test("a stated priority or housing situation works without mandatory stage questions", () => {
  for (const [field, value] of [
    ["priority", "understand_costs"],
    ["household", "family"],
    ["monthlyRentRub", { max: 50_000 }],
  ] as const) {
    const brief = starterBrief();
    brief.answers = r1HousingAnswersSchema.parse({
      ...createR1HousingAnswers(),
      [field]: known(value),
    });
    brief.starterPlan!.basedOn = [{ field, revision: 1 }];
    assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, true);
  }
});

test("states are distinct; undecided and declined need no explanation", () => {
  for (const status of ["unasked", "undecided", "declined"]) {
    assert.equal(
      acceptsAnswer(
        "monthlyRentRub",
        status === "unasked"
          ? { status, revision: 1 }
          : { status, revision: 1, provenance: userProvenance },
      ),
      true,
    );
    assert.equal(
      acceptsAnswer("monthlyRentRub", {
        status,
        revision: 1,
        value: { max: 50_000 },
      }),
      false,
    );
  }
  assert.equal(
    acceptsAnswer("monthlyRentRub", {
      status: "undecided",
      revision: 1,
      provenance: userProvenance,
      note: "Нужна помощь с оценкой",
    }),
    true,
  );
  for (const invalid of [
    undefined,
    null,
    {},
    { status: "unknown" },
    {
      status: "undecided",
      revision: 1,
      provenance: userProvenance,
      nextQuestion: "Обязательный вопрос",
    },
  ])
    assert.equal(acceptsAnswer("monthlyRentRub", invalid), false);
  assert.equal(
    acceptsAnswer("monthlyRentRub", {
      status: "not_applicable",
      revision: 1,
      provenance: userProvenance,
    }),
    false,
  );
  assert.equal(
    acceptsAnswer("commuteDestination", {
      status: "not_applicable",
      revision: 1,
      provenance: userProvenance,
    }),
    true,
  );
});

test("candidate helper excludes declined or undecided answer states", () => {
  const answers = createR1HousingAnswers();
  answers.monthlyRentRub = {
    status: "undecided",
    revision: 2,
    provenance: userProvenance,
  };
  answers.moveTiming = {
    status: "declined",
    revision: 2,
    provenance: userProvenance,
  };
  answers.preferredAreas = {
    status: "not_applicable",
    revision: 2,
    provenance: userProvenance,
  };
  answers.stage = starterBrief().answers.stage;
  assert.deepEqual(
    r1HousingQuestionCandidates(answers, []),
    r1HousingFieldSchema.options.filter(
      (field) =>
        !["monthlyRentRub", "moveTiming", "preferredAreas", "stage"].includes(
          field,
        ),
    ),
  );
});

test("one-sided rent constraints are preserved, not filled with fictional bounds", () => {
  for (const value of [
    { max: 50_000 },
    { min: 40_000 },
    { min: 0, max: 1_000_000 },
  ]) {
    const answers = r1HousingAnswersSchema.parse({
      ...createR1HousingAnswers(),
      monthlyRentRub: known(value),
    });
    assert.deepEqual(answers.monthlyRentRub, known(value));
  }
});

test("budget rejects empty, inverted, fractional, coerced and unbounded input", () => {
  for (const value of [
    {},
    { min: 60_000, max: 50_000 },
    { min: -1 },
    { max: 0 },
    { max: 1_000_001 },
    { max: 10.5 },
    { max: "50000" },
    { max: Infinity },
    { max: NaN },
    { max: 50_000, assumedMin: 0 },
  ])
    assert.equal(acceptsAnswer("monthlyRentRub", known(value)), false);
  for (const value of [-1, 1_000_001, 0.1, "50000", Infinity])
    assert.equal(acceptsAnswer("upfrontBudgetRub", known(value)), false);
  assert.equal(acceptsAnswer("upfrontBudgetRub", known(0)), true);
  assert.equal(acceptsAnswer("upfrontBudgetRub", known(1_000_000)), true);
  assert.equal(
    acceptsAnswer("upfrontBudgetRub", { ...known(0), confirmed: true }),
    false,
  );
});

test("timing supports month and one-sided dates; past snapshots remain readable", () => {
  for (const value of [
    { kind: "month", month: "2026-11" },
    { kind: "on", date: "2000-01-01" },
    { kind: "before", date: "2026-11-01" },
    { kind: "after", date: "2026-11-01" },
    { kind: "range", from: "2026-11-01", to: "2026-11-01" },
  ])
    assert.equal(acceptsAnswer("moveTiming", known(value)), true);
  for (const value of [
    { kind: "month", month: "2026-13" },
    { kind: "on", date: "2026-02-30" },
    { kind: "on", date: "1899-12-31" },
    { kind: "on", date: "2200-01-01" },
    { kind: "range", from: "2026-12-01", to: "2026-11-01" },
    { kind: "soon" },
  ])
    assert.equal(acceptsAnswer("moveTiming", known(value)), false);
});

test("destination and commute duration are independent partial answers", () => {
  const answers = r1HousingAnswersSchema.parse({
    ...createR1HousingAnswers(),
    commuteDestination: known("Синтетическая точка работы"),
  });
  assert.equal(answers.commuteMaxMinutes.status, "unasked");
  for (const value of [0, 241, -1, 1.5, "30"])
    assert.equal(acceptsAnswer("commuteMaxMinutes", known(value)), false);
  assert.equal(acceptsAnswer("commuteMaxMinutes", known(30)), true);
});

test("open preference lists are distinct from completed empty lists", () => {
  for (const completeness of ["open", "complete"])
    assert.equal(
      acceptsAnswer("mustHave", known({ items: [], completeness })),
      true,
    );
  assert.equal(
    acceptsAnswer("mustHave", known({ items: ["Лифт"], completeness: "open" })),
    true,
  );
  for (const items of [
    ["Лифт", " Лифт "],
    ["é", "e\u0301"],
    Array.from({ length: 21 }, (_, i) => String(i)),
  ])
    assert.equal(
      acceptsAnswer("mustHave", known({ items, completeness: "open" })),
      false,
    );
});

test("text is NFC-normalized, trimmed and rejects invisible-only content", () => {
  const answers = r1HousingAnswersSchema.parse({
    ...createR1HousingAnswers(),
    commuteDestination: known(" e\u0301 "),
  });
  assert.equal(answers.commuteDestination.status, "known");
  if (answers.commuteDestination.status === "known")
    assert.equal(answers.commuteDestination.value, "é");
  for (const value of [
    " ",
    "\u200b",
    "\u0301",
    "\u2800",
    "\u3164",
    "\uFEFF",
    "x".repeat(501),
  ])
    assert.equal(acceptsAnswer("commuteDestination", known(value)), false);
  assert.equal(acceptsAnswer("commuteDestination", known("🚇")), true);
});

test("suggestions remain separate and typed; a proposal alone is not a user answer", () => {
  const brief = blankBrief();
  brief.suggestions = [
    r1HousingSuggestionSchema.parse({
      id: uuid,
      revision: 1,
      status: "pending",
      proposal: { field: "monthlyRentRub", value: { max: 50_000 } },
      explanation: "Обсудить только после уточнения.",
    }),
  ];
  assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, true);
  assert.equal(brief.answers.monthlyRentRub.status, "unasked");
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, false);
  for (const status of ["pending", "accepted", "rejected"])
    assert.equal(
      r1HousingSuggestionSchema.safeParse({ ...brief.suggestions[0], status })
        .success,
      true,
    );
  assert.equal(
    r1HousingSuggestionSchema.safeParse({
      ...brief.suggestions[0],
      proposal: { field: "monthlyRentRub", value: "solo" },
    }).success,
    false,
  );
  assert.equal(
    r1HousingBriefDraftSchema.safeParse({
      ...brief,
      suggestions: [...brief.suggestions, ...brief.suggestions],
    }).success,
    false,
  );
});

test("provenance records accepted suggestions or confirmed imports, not system facts", () => {
  for (const provenance of [
    userProvenance,
    {
      kind: "accepted_suggestion",
      eventId: uuid,
      suggestionId: uuid,
      suggestionRevision: 2,
    },
    {
      kind: "profile_import",
      eventId: uuid,
      profile: { id: "12", revision: 2 },
      userConfirmed: true,
    },
  ])
    assert.equal(
      acceptsAnswer("stage", { ...known("exploring"), provenance }),
      true,
    );
  for (const provenance of [
    { kind: "system_assumption" },
    { kind: "accepted_suggestion", eventId: uuid, suggestionId: uuid },
    {
      kind: "profile_import",
      eventId: uuid,
      profile: { id: "12", revision: 2 },
      userConfirmed: false,
    },
  ])
    assert.equal(
      acceptsAnswer("stage", { ...known("exploring"), provenance }),
      false,
    );
  // Shapes do not establish provenance truth. History checks belong to CG-012.
});

test("prepared starter requires current known basis, content and offered next action", () => {
  const brief = starterBrief();
  const plan = brief.starterPlan!;
  for (const starterPlan of [
    null,
    { ...plan, summary: " " },
    { ...plan, basedOn: [] },
    { ...plan, basedOn: [{ field: "stage", revision: 2 }] },
    { ...plan, basedOn: [{ field: "monthlyRentRub", revision: 1 }] },
    { ...plan, basedOn: [...plan.basedOn, ...plan.basedOn] },
    { ...plan, nextSteps: [] },
    { ...plan, nextSteps: [...plan.nextSteps, ...plan.nextSteps] },
    { ...plan, nextSteps: [{ ...plan.nextSteps[0], key: "../action" }] },
  ])
    assert.equal(
      r1HousingBriefPreparedSchema.safeParse({ ...brief, starterPlan }).success,
      false,
    );
  const stale = starterBrief();
  stale.answers.stage = {
    status: "undecided",
    revision: 2,
    provenance: userProvenance,
  };
  assert.equal(r1HousingBriefDraftSchema.safeParse(stale).success, true);
  assert.equal(r1HousingBriefPreparedSchema.safeParse(stale).success, false);
});

test("starter dependencies can include uncertainty alongside a stated situation", () => {
  const brief = starterBrief();
  brief.answers.monthlyRentRub = {
    status: "undecided",
    revision: 2,
    provenance: userProvenance,
  };
  brief.starterPlan!.basedOn.push({ field: "monthlyRentRub", revision: 2 });
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, true);
  brief.answers.monthlyRentRub = {
    status: "declined",
    revision: 3,
    provenance: userProvenance,
  };
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, false);
});

test("draft and prepared unions are deliberately different", () => {
  assert.equal(
    r1HousingArtifactDraftContentSchema.safeParse(blankBrief()).success,
    true,
  );
  assert.equal(
    r1HousingArtifactPreparedContentSchema.safeParse(blankBrief()).success,
    false,
  );
  for (const content of [starterBrief(), checklist()])
    assert.equal(
      r1HousingArtifactPreparedContentSchema.safeParse(content).success,
      true,
    );
  assert.equal(
    r1HousingArtifactDraftContentSchema.safeParse({
      ...checklist(),
      kind: "housing_brief",
    }).success,
    false,
  );
});

test("schema accepts draft and prepared checklists without an award flag", () => {
  const list = checklist();
  for (const sections of [
    [],
    list.sections.slice(0, 1),
    [{ ...list.sections[0], questions: [] }],
  ]) {
    assert.equal(
      r1ViewingChecklistDraftSchema.safeParse({ ...list, sections }).success,
      true,
    );
    assert.equal(
      r1ViewingChecklistPreparedSchema.safeParse({ ...list, sections }).success,
      false,
    );
  }
  assert.equal(r1ViewingChecklistPreparedSchema.safeParse(list).success, true);
  assert.equal(
    r1HousingQuestDefinitions["housing-viewing"].awardPrerequisite,
    "housing-brief",
  );
});

test("checklist requires each of seven sections once, with bounded questions for preparation", () => {
  const list = checklist();
  for (const sections of [
    [...list.sections, list.sections[0]],
    list.sections.map(() => list.sections[0]),
    list.sections.map((s) => ({ ...s, id: "unknown" })),
    list.sections.map((s) => ({
      ...s,
      questions: Array.from({ length: 9 }, (_, i) => String(i)),
    })),
    list.sections.map((s) => ({ ...s, questions: ["Вопрос", " Вопрос "] })),
    list.sections.map((s) => ({ ...s, passed: true })),
  ])
    assert.equal(
      r1ViewingChecklistDraftSchema.safeParse({ ...list, sections }).success,
      false,
    );
});

test("personalized sections require origin; stale detection uses field dependencies", () => {
  const list = checklist();
  list.sections[0]!.basedOn = [{ field: "monthlyRentRub", revision: 1 }];
  assert.equal(r1ViewingChecklistDraftSchema.safeParse(list).success, false);
  list.housingBrief = { id: "51", revision: 2 };
  assert.equal(r1ViewingChecklistPreparedSchema.safeParse(list).success, true);
  const answers = createR1HousingAnswers();
  assert.deepEqual(
    r1ViewingSectionsNeedingUpdate(list, { id: "51", revision: 2, answers }),
    [],
  );
  answers.niceToHave = {
    status: "not_applicable",
    revision: 2,
    provenance: userProvenance,
  };
  assert.deepEqual(
    r1ViewingSectionsNeedingUpdate(list, { id: "51", revision: 2, answers }),
    [],
  );
  answers.monthlyRentRub = {
    status: "undecided",
    revision: 2,
    provenance: userProvenance,
  };
  assert.deepEqual(
    r1ViewingSectionsNeedingUpdate(list, { id: "51", revision: 2, answers }),
    ["budget_and_payments"],
  );
  // Same-owner graph, server-maintained revisions/dependencies and immutable
  // awards are integration obligations, not simulated by this pure helper.
});

test("nested objects reject authority fields and unsupported purposes", () => {
  const brief = starterBrief();
  for (const patch of [
    { ownerId: "99" },
    { xpReward: 600 },
    { confirmed: true },
    { schemaVersion: 2 },
    { purpose: "lease_signed" },
    { destination: { countryCode: "RU", cityCode: "RU-MOS" } },
    { destination: { countryCode: "RU", cityCode: "RU-MOW", approved: true } },
    { answers: { ...brief.answers, verified: true } },
    { starterPlan: { ...brief.starterPlan, foundApartment: true } },
  ])
    assert.equal(
      r1HousingBriefDraftSchema.safeParse({ ...brief, ...patch }).success,
      false,
    );
  for (const patch of [
    { viewed: true },
    { legallyVerified: true },
    { purpose: "viewing_completed" },
    { housingBrief: { id: "51", revision: 2, ownerId: "99" } },
  ])
    assert.equal(
      r1ViewingChecklistDraftSchema.safeParse({ ...checklist(), ...patch })
        .success,
      false,
    );
});

test("IDs use canonical positive int8, never opaque or alternate numeric spellings", () => {
  for (const id of ["1", "9223372036854775807"])
    assert.equal(r1HousingIdSchema.safeParse(id).success, true);
  for (const id of [
    "0",
    "01",
    "-1",
    "+1",
    "0x1f",
    "1e2",
    "1.0",
    "latest",
    "../12",
    " 12",
    "12 ",
    "9223372036854775808",
    "9999999999999999999",
    12,
  ])
    assert.equal(r1HousingIdSchema.safeParse(id).success, false);
});

test("versions match positive PostgreSQL int4 and are never coerced", () => {
  for (const version of [1, 2147483647])
    assert.equal(r1HousingRevisionSchema.safeParse(version).success, true);
  for (const version of [
    0,
    -1,
    1.5,
    2147483648,
    Number.MAX_SAFE_INTEGER,
    Infinity,
    "1",
  ])
    assert.equal(r1HousingRevisionSchema.safeParse(version).success, false);
});

test("confirmation variants pin snapshots, copy and next-step choice", () => {
  for (const slug of ["housing-brief", "housing-viewing"] as const) {
    const value = intent(slug);
    assert.deepEqual(r1HousingConfirmationIntentSchema.parse(value), value);
    for (const field of Object.keys(value)) {
      const copy: Record<string, unknown> = { ...value };
      delete copy[field];
      assert.equal(
        r1HousingConfirmationIntentSchema.safeParse(copy).success,
        false,
        slug + ":" + field,
      );
    }
  }
  assert.equal(
    r1HousingConfirmationIntentSchema.safeParse({
      ...intent("housing-viewing"),
      selectedNextStepKey: "auto",
    }).success,
    false,
  );
});

test("confirmation rejects extra, inconsistent versions, malformed hashes and false acknowledgements", () => {
  for (const patch of [
    { questSlug: "other" },
    { definitionVersion: 2 },
    { criteriaVersion: 2 },
    { rewardVersion: 2 },
    { confirmationCopyVersion: 2 },
    { selectedNextStepKey: " " },
    { requestId: "not-uuid" },
    { contentSha256: "a".repeat(63) },
    { unresolvedFieldsSha256: "" },
    { ownerId: "99" },
    { confirmedAt: "2026-10-04T00:00:00Z" },
    { xpReward: 60 },
    { questId: "012" },
    { plan: { id: "9223372036854775808", version: 1 } },
    { plan: { id: "42", version: 2147483648 } },
    { plan: { id: "42", version: 1, approved: true } },
    { artifact: { id: "latest", revision: 1 } },
    { artifact: { id: "51", revision: 0 } },
    { artifact: { id: "51", revision: 1, kind: "housing_brief" } },
    { acknowledgements: { reviewedResult: false, preparationOnly: true } },
    { acknowledgements: { reviewedResult: true, preparationOnly: false } },
    {
      acknowledgements: {
        reviewedResult: true,
        preparationOnly: true,
        aiConsent: true,
      },
    },
  ])
    assert.equal(
      r1HousingConfirmationIntentSchema.safeParse({ ...intent(), ...patch })
        .success,
      false,
    );
});

test("definition constants preserve 60+60; legacy completion schema remains unchanged", () => {
  for (const slug of ["housing-brief", "housing-viewing"] as const) {
    const definition = r1HousingQuestDefinitions[slug];
    assert.equal(definition.xpReward, 60);
    assert.equal(definition.status, "candidate");
    assert.equal(Object.isFrozen(definition), true);
    for (const field of [
      "definitionVersion",
      "criteriaVersion",
      "rewardVersion",
      "confirmationCopyVersion",
    ] as const) {
      assert.equal(intent(slug)[field], definition[field]);
      assert.equal(
        r1HousingConfirmationIntentSchema.safeParse({
          ...intent(slug),
          [field]: definition[field] + 1,
        }).success,
        false,
      );
    }
  }
  assert.equal(
    r1HousingQuestDefinitions["housing-brief"].awardPrerequisite,
    null,
  );
  assert.equal(
    r1HousingQuestDefinitions["housing-brief"].nextQuestSlug,
    "housing-viewing",
  );
  assert.equal(
    r1HousingQuestDefinitions["housing-viewing"].nextQuestSlug,
    null,
  );
  assert.equal(completionSchema.safeParse({ confirmed: true }).success, true);
  assert.equal(
    r1HousingConfirmationIntentSchema.safeParse({ confirmed: true }).success,
    false,
  );
  // A valid numeric ID could be somebody else's. Zod is NOT the owner check.
  assert.equal(
    r1HousingConfirmationIntentSchema.safeParse({ ...intent(), questId: "999" })
      .success,
    true,
  );
});

test("Prepared rejects empty-only basis but preserves explicit wide budgets", () => {
  for (const [field, value, prepared] of [
    ["niceToHave", { items: [], completeness: "open" }, false],
    ["mustHave", { items: [], completeness: "complete" }, false],
    ["monthlyRentRub", { min: 0 }, false],
    ["monthlyRentRub", { min: 1 }, true],
    ["monthlyRentRub", { min: 0, max: 1_000_000 }, true],
    ["upfrontBudgetRub", 0, true],
  ] as const) {
    const brief = starterBrief();
    brief.answers = r1HousingAnswersSchema.parse({
      ...createR1HousingAnswers(),
      [field]: known(value),
    });
    brief.starterPlan!.basedOn = [{ field, revision: 1 }];
    assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, true);
    assert.equal(
      r1HousingBriefPreparedSchema.safeParse(brief).success,
      prepared,
    );
  }
});

function suggestedBrief() {
  const brief = starterBrief();
  brief.answers.stage = {
    status: "known",
    revision: 1,
    value: "exploring",
    provenance: {
      kind: "accepted_suggestion",
      eventId: uuid,
      suggestionId: uuid,
      suggestionRevision: 2,
    },
  };
  brief.suggestions = [
    {
      id: uuid,
      revision: 2,
      status: "accepted",
      proposal: { field: "stage", value: "exploring" },
      explanation: "Synthetic proposal",
    },
  ];
  return brief;
}

test("Draft and Prepared cross-check the current accepted suggestion source", () => {
  assert.equal(
    r1HousingBriefPreparedSchema.safeParse(suggestedBrief()).success,
    true,
  );
  const source = suggestedBrief().suggestions[0]!;
  const variants = [
    [],
    [{ ...source, id: "00000000-0000-4000-8000-000000000001" }],
    [{ ...source, status: "pending" }],
    [{ ...source, status: "rejected" }],
    [{ ...source, revision: 1 }],
    [{ ...source, proposal: { field: "priority", value: "understand_costs" } }],
    [{ ...source, proposal: { field: "stage", value: "arrived" } }],
  ];
  for (const suggestions of variants) {
    const brief = { ...suggestedBrief(), suggestions };
    for (const schema of [
      r1HousingBriefDraftSchema,
      r1HousingBriefPreparedSchema,
      r1HousingArtifactDraftContentSchema,
      r1HousingArtifactPreparedContentSchema,
    ])
      assert.equal(schema.safeParse(brief).success, false);
  }
});

test("suggestion equality ignores object key order after normalization, not changed values", () => {
  const brief = suggestedBrief();
  const provenance =
    brief.answers.stage.status === "known"
      ? brief.answers.stage.provenance
      : userProvenance;
  brief.answers = r1HousingAnswersSchema.parse({
    ...createR1HousingAnswers(),
    monthlyRentRub: { ...known({ min: 20_000, max: 60_000 }), provenance },
  });
  brief.starterPlan!.basedOn = [{ field: "monthlyRentRub", revision: 1 }];
  brief.suggestions[0]!.proposal = {
    field: "monthlyRentRub",
    value: { max: 60_000, min: 20_000 },
  };
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, true);
  brief.suggestions[0]!.proposal = {
    field: "monthlyRentRub",
    value: { max: 70_000, min: 20_000 },
  };
  assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, false);
});

test("suggestion UUIDs normalize consistently and reject case-variant duplicates", () => {
  const brief = suggestedBrief();
  brief.suggestions[0]!.id = uuid.toUpperCase();
  assert.equal(r1HousingBriefPreparedSchema.safeParse(brief).success, true);
  brief.suggestions.push({ ...brief.suggestions[0]!, id: uuid });
  assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, false);
});

test("current projection caps pending suggestions separately from current accepted sources", () => {
  const brief = suggestedBrief();
  const pending = Array.from({ length: 21 }, (_, i) =>
    r1HousingSuggestionSchema.parse({
      id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      revision: 1,
      status: "pending",
      proposal: { field: "stage", value: "exploring" },
      explanation: "Synthetic",
    }),
  );
  brief.suggestions.push(...pending.slice(0, 20));
  assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, true); // 20 + 1
  brief.suggestions.push(pending[20]!);
  assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, false);
});

test("terminal history belongs outside the projection and does not constrain a corrected answer", () => {
  const original = suggestedBrief();
  const oldSource = original.suggestions[0]!;
  const corrected = starterBrief();
  corrected.answers.stage = {
    status: "known",
    value: "arrived",
    revision: 2,
    provenance: userProvenance,
  };
  corrected.starterPlan!.basedOn = [{ field: "stage", revision: 2 }];
  assert.equal(r1HousingBriefPreparedSchema.safeParse(corrected).success, true);
  for (const status of ["accepted", "rejected"] as const) {
    const historical = { ...oldSource, status };
    assert.equal(r1HousingSuggestionSchema.safeParse(historical).success, true);
    assert.equal(
      r1HousingBriefDraftSchema.safeParse({
        ...corrected,
        suggestions: [historical],
      }).success,
      false,
    );
  }
  // This checks projection shapes, NOT persistence/retention in CG-012's journal.
});

test("every non-unasked status requires explicit event provenance", () => {
  for (const status of ["undecided", "declined", "not_applicable"]) {
    assert.equal(acceptsAnswer("niceToHave", { status, revision: 1 }), false);
    assert.equal(
      acceptsAnswer("niceToHave", {
        status,
        revision: 1,
        provenance: userProvenance,
      }),
      true,
    );
    for (const provenance of [
      { kind: "user_stated" },
      { kind: "user_stated", eventId: "invalid" },
      { kind: "system_assumption", eventId: uuid },
      {
        kind: "accepted_suggestion",
        eventId: uuid,
        suggestionId: uuid,
        suggestionRevision: 1,
      },
    ])
      assert.equal(
        acceptsAnswer("niceToHave", { status, revision: 1, provenance }),
        false,
      );
  }
  assert.equal(
    acceptsAnswer("stage", {
      ...known("exploring"),
      provenance: { kind: "user_stated" },
    }),
    false,
  );
  assert.equal(
    acceptsAnswer("niceToHave", {
      status: "unasked",
      revision: 1,
      provenance: userProvenance,
    }),
    false,
  );
});

test("question candidate helper filters previously delivered but unanswered prompts", () => {
  const answers = createR1HousingAnswers();
  assert.equal(answers.housingType.status, "unasked");
  assert.equal(
    r1HousingQuestionCandidates(answers, ["housingType"]).includes(
      "housingType",
    ),
    false,
  );
  assert.equal(
    r1HousingQuestionCandidates(answers, []).includes("housingType"),
    true,
  );
  // The server maintains delivered-question history; this is not a UI loop test.
});

test("dependency helper rejects another, missing or older brief even with identical field revisions", () => {
  const list = checklist();
  list.housingBrief = { id: "51", revision: 2 };
  list.sections[0]!.basedOn = [{ field: "monthlyRentRub", revision: 1 }];
  const answers = createR1HousingAnswers();
  for (const current of [
    null,
    { id: "52", revision: 2, answers },
    { id: "51", revision: 1, answers },
  ])
    assert.throws(
      () => r1ViewingSectionsNeedingUpdate(list, current),
      /reference mismatch/,
    );
  assert.deepEqual(
    r1ViewingSectionsNeedingUpdate(list, { id: "51", revision: 3, answers }),
    [],
  );
  assert.deepEqual(r1ViewingSectionsNeedingUpdate(checklist(), null), []);
});

test("text rejects controls and malformed Unicode before trimming; bound is 500 code points", () => {
  for (const value of [
    "a\u0000b",
    "a\ud800b",
    "a\udc00b",
    "a\nb",
    "a\rb",
    "\tvalid",
    "valid\n",
    "a\u007fb",
  ]) {
    assert.equal(acceptsAnswer("commuteDestination", known(value)), false);
    const brief = starterBrief();
    brief.starterPlan!.summary = value;
    assert.equal(r1HousingBriefDraftSchema.safeParse(brief).success, false);
  }
  assert.equal(
    acceptsAnswer("commuteDestination", known("🚇".repeat(500))),
    true,
  );
  assert.equal(
    acceptsAnswer("commuteDestination", known("🚇".repeat(501))),
    false,
  );
});

test("candidate reward metadata pins pilot scope and explicit completion, not database enforcement", () => {
  for (const definition of Object.values(r1HousingQuestDefinitions)) {
    assert.equal(definition.awardScope, "r1-pilot");
    assert.equal(definition.completionMode, "explicit_command");
  }
});
