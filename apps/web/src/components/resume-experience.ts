import { assistantHandoffDraft } from "./assistant-handoff-state";

export type ResumeExperience = {
  goal: string;
  employer: string;
  role: string;
  experience: string;
  skills: string;
};

export const emptyResumeExperience: ResumeExperience = {
  goal: "",
  employer: "",
  role: "",
  experience: "",
  skills: "",
};

const fields = [
  ["goal", "Цель"],
  ["employer", "Работодатель"],
  ["role", "Должность"],
  ["experience", "Опыт"],
  ["skills", "Навыки"],
] as const;

export function reviewedResumeText(input: ResumeExperience): string | null {
  if (
    ![input.employer, input.role, input.experience, input.skills].some(
      (value) => value.trim(),
    )
  )
    return null;

  const sections = fields.flatMap(([key, title]) => {
    const value = input[key].trim();
    return value ? [title + ": " + value] : [];
  });
  const text = sections.join("\n\n");
  // The result is saved in the existing personal plan. Exceeding its bound
  // asks for a shorter draft instead of silently changing confirmed facts.
  if (text.length > 4000) return null;
  try {
    return assistantHandoffDraft(text);
  } catch {
    return null;
  }
}
