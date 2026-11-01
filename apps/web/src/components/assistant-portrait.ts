import type { AgentKey } from "@citygo/contracts";

/** Original portrait assets from the same Figma prototype, without recropping. */
export function assistantPortrait(agent: AgentKey): string {
  return `/figma/${agent}-assistant.png`;
}
