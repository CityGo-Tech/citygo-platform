export const MAX_VACANCY_REQUIREMENTS = 6;

function uniqueLines(text: string) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function vacancyRequirements(text: string) {
  return uniqueLines(text);
}

export function resumeEvidence(text: string) {
  return [
    ...new Set(
      uniqueLines(text)
        .filter((line) => !/^Цель:/i.test(line))
        .map((line) => line.replace(/^Опыт:\s*/i, ""))
        .filter(Boolean),
    ),
  ];
}

export function applicationComparison(
  requirements: readonly string[],
  evidence: readonly string[],
  choices: ReadonlyMap<string, string>,
) {
  const knownEvidence = new Set(evidence);
  const supported: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const fact = choices.get(requirement);
    if (fact && knownEvidence.has(fact)) supported.push(fact);
    else missing.push(requirement);
  }
  return { supported: [...new Set(supported)], missing };
}

export function applicationDraft(
  vacancy: string,
  supported: readonly string[],
) {
  const title = vacancy.trim();
  if (!title || !supported.length) return null;
  return [
    "Здравствуйте! Хочу откликнуться на вакансию «" + title + "».",
    supported.join("\n"),
    "Буду рад(а) обсудить, как мой опыт пригодится в этой роли.",
  ].join("\n\n");
}
