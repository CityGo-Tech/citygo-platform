import { z } from "zod";

// Public, untrusted campaign labels. Never an identity, permission, URL or
// proof of a conversion. Slugs intentionally cannot contain query/contact text.
const landingCampaignSlugSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/);

export const landingAttributionSchema = z.strictObject({
  landingVersion: z.enum(["v1", "v8"]),
  source: landingCampaignSlugSchema.optional(),
  medium: landingCampaignSlugSchema.optional(),
  campaignId: landingCampaignSlugSchema.optional(),
  content: landingCampaignSlugSchema.optional(),
});

export type LandingAttribution = z.infer<typeof landingAttributionSchema>;
