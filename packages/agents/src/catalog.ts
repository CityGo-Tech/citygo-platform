export * from "./runtime.js";
export type AgentId =
  "support" | "housing" | "job-search" | "resume-builder" | "digital-mentor";

export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  promptVersion: "v1";
  allowedToolGroups: readonly string[];
  handoffWhen: readonly string[];
}

export const agentCatalog: readonly AgentDefinition[] = [
  {
    id: "support",
    displayName: "Support Assistant",
    promptVersion: "v1",
    allowedToolGroups: ["profile:read", "quest:read", "handoff:create"],
    handoffWhen: ["A specialized domain is identified", "A human is requested"],
  },
  {
    id: "housing",
    displayName: "Housing Navigator",
    promptVersion: "v1",
    allowedToolGroups: ["profile:read", "housing:search", "quest:update"],
    handoffWhen: [
      "Legal interpretation is required",
      "Fraud or safety risk is detected",
    ],
  },
  {
    id: "job-search",
    displayName: "Job Search Mentor",
    promptVersion: "v1",
    allowedToolGroups: ["profile:read", "jobs:search", "quest:update"],
    handoffWhen: [
      "A resume artifact is requested",
      "A human career review is requested",
    ],
  },
  {
    id: "resume-builder",
    displayName: "Resume Builder Expert",
    promptVersion: "v1",
    allowedToolGroups: ["profile:read", "artifact:create"],
    handoffWhen: ["Facts are missing", "The user requests misrepresentation"],
  },
  {
    id: "digital-mentor",
    displayName: "Digital Mentor",
    promptVersion: "v1",
    allowedToolGroups: ["profile:read", "knowledge:read", "quest:update"],
    handoffWhen: [
      "Official support is required",
      "Sensitive account access is involved",
    ],
  },
] as const;
