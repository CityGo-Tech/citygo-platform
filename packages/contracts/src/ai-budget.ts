import { z } from "zod";
import { aiPolicyIdSchema, type AiPolicy } from "./ai-access.js";

// Integer millionths of the selected currency, not provider billing data.
export const MONEY_SCALE = 1_000_000;
export const MAX_MONEY_MICROS = 1_000_000_000_000;
const moneySchema = z.number().int().min(0).max(MAX_MONEY_MICROS);
export const aiBudgetInputSchema = z
  .strictObject({
    expectedRevision: z.number().int().min(1).max(2147483646),
    enabled: z.boolean(),
    currency: z.enum(["RUB", "USD"]),
    dailyLimitMicros: moneySchema,
    totalLimitMicros: moneySchema,
    rules: z
      .array(
        z.strictObject({
          key: aiPolicyIdSchema,
          attemptCeilingMicros: moneySchema.refine((value) => value > 0),
        }),
      )
      .max(3),
  })
  .refine((value) => value.dailyLimitMicros <= value.totalLimitMicros, {
    message: "Daily budget cannot exceed total budget",
  })
  .refine(
    (value) =>
      new Set(value.rules.map((rule) => rule.key)).size === value.rules.length,
    {
      message: "Duplicate budget rules",
    },
  )
  .refine(
    (value) =>
      !value.enabled || (value.dailyLimitMicros > 0 && value.rules.length > 0),
    {
      message:
        "Enabled budget requires positive limits and an approved execution rule",
    },
  );
export type AiBudgetInput = z.infer<typeof aiBudgetInputSchema>;
export type AiExecution = {
  key: string;
  policy: AiPolicy;
  maxInputBytes: number;
  maxOutputTokens: number;
};
export type AiBudgetSettings = {
  revision: number;
  enabled: boolean;
  currency: "RUB" | "USD" | null;
  dailyLimitMicros: number;
  totalLimitMicros: number;
  rules: (AiExecution & { attemptCeilingMicros: number })[];
};
export type AiBudgetStatus = {
  settings: AiBudgetSettings;
  totalReservedMicros: number;
  day: string;
  reservedTodayMicros: number;
  availableExecutions: AiExecution[];
  audit: {
    id: string;
    actorUserId: string;
    createdAt: string;
    payload: { from: AiBudgetSettings; to: AiBudgetSettings };
  }[];
};
export type AiMoneyReservation = {
  currency: "RUB" | "USD";
  amountMicros: number;
  revision: number;
  ruleKey: string;
};

// Parse decimal text without floating-point multiplication or silent rounding.
export function parseMoneyMicros(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * MONEY_SCALE + Number(fraction.padEnd(6, "0"));
  return amount <= MAX_MONEY_MICROS ? amount : null;
}
export function formatMoneyMicros(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_MONEY_MICROS)
    throw new Error("Invalid money amount");
  const fraction = String(amount % MONEY_SCALE)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return (
    String(Math.floor(amount / MONEY_SCALE)) + (fraction ? "." + fraction : "")
  );
}
