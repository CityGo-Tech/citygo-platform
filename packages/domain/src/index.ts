export const questStates = [
  "locked",
  "available",
  "in_progress",
  "completed",
] as const;

export type QuestState = (typeof questStates)[number];

const transitions: Record<QuestState, readonly QuestState[]> = {
  available: ["in_progress"],
  completed: [],
  in_progress: ["completed"],
  locked: ["available"],
};

export function canTransitionQuest(from: QuestState, to: QuestState): boolean {
  return transitions[from].includes(to);
}

export function transitionQuest(from: QuestState, to: QuestState): QuestState {
  if (!canTransitionQuest(from, to)) {
    throw new Error(`Invalid quest transition: ${from} -> ${to}`);
  }

  return to;
}
