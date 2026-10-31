import { z } from "zod";
import { agentKeySchema } from "./platform.js";
import { personalPlanIdSchema } from "./personal-plan.js";

export const resultDiscussionParamsSchema = z.strictObject({
  kind: z.enum(["plan", "favorites"]),
  id: personalPlanIdSchema,
});
export const resultDiscussionSourceSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    kind: resultDiscussionParamsSchema.shape.kind,
    id: personalPlanIdSchema,
    revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    title: z.string().min(1).max(120),
    text: z
      .string()
      .min(1)
      .max(1024 * 1024),
    assistantKey: agentKeySchema,
    interrupted: z.boolean(),
  })
  .refine((value) => (value.kind === "plan") === (value.revision !== null));
export type ResultDiscussionParams = z.infer<
  typeof resultDiscussionParamsSchema
>;
export type ResultDiscussionSource = z.infer<
  typeof resultDiscussionSourceSchema
>;
