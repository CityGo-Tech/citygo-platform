import { z } from "zod";

export const aiProviderIds = ["openai", "routerai", "gigachat"] as const;
export const aiProviderIdSchema = z.enum(aiProviderIds);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

export type ModelUsage = { inputTokens: number; outputTokens: number };
export type ModelGeneration = {
  provider: AiProviderId;
  requestedModel: string;
  // Only populated when the provider reports the actual model.
  model?: string;
  usage?: ModelUsage;
};
