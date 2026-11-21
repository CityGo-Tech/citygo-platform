import type { AgentKey } from "@citygo/contracts";

export const landingTaskAgents = {
  coordinator: "support",
  housing: "housing",
} as const satisfies Record<string, AgentKey>;

export type LandingTask = keyof typeof landingTaskAgents;
export const landingTaskMaxAgeMs = 30 * 60 * 1000;

export function landingTaskFromValue(
  value: string | null,
): LandingTask | undefined {
  if (value === "coordinator" || value === "housing") return value;
  return undefined;
}

const landingTaskFragment = "#citygo-start-";
export const housingPreviewHash = "#citygo-housing-preview";

export function landingTaskHash(task: LandingTask): string {
  return landingTaskFragment + task;
}

/** The bridge sends a fixed fragment to this tab only. Never persist a task
 * alongside analytics or across auth lifetimes. */
export function consumeLandingTask():
  { task: LandingTask; preview?: true } | undefined {
  const { hash, pathname, search } = window.location;
  if (pathname !== "/") return;
  if (hash === housingPreviewHash) {
    window.history.replaceState(null, "", pathname + search);
    return { task: "housing", preview: true };
  }
  if (!hash.startsWith(landingTaskFragment)) return;
  window.history.replaceState(null, "", pathname + search);
  const task = landingTaskFromValue(hash.slice(landingTaskFragment.length));
  return task ? { task } : undefined;
}
