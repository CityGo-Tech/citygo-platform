import type { AiModeId } from "@citygo/contracts";

// A Web UI preference, not the legacy API default. Availability and consent
// are checked separately; choosing Maximum never implies a fallback or grant.
export const initialWebAiMode: AiModeId = "maximum";
