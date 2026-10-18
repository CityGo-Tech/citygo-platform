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
    // Absence preserves the stored mode. Switching off CityGo money caps is
    // always an explicit administrative decision, never an old-client default.
    mode: z.enum(["fixed", "routerai_balance"]).optional(),
    dailyLimitMicros: moneySchema.nullable(),
    totalLimitMicros: moneySchema.nullable(),
    // Omitted preserves the server value; null removes the personal cap.
    // Zero explicitly blocks new reservations for every account.
    userDailyLimitMicros: moneySchema.nullable().optional(),
    rules: z
      .array(
        z.strictObject({
          key: aiPolicyIdSchema,
          attemptCeilingMicros: moneySchema.refine((value) => value > 0),
        }),
      )
      .max(3),
  })
  .refine(
    (value) =>
      value.mode === "routerai_balance"
        ? value.currency === "RUB" &&
          value.dailyLimitMicros === null &&
          value.totalLimitMicros === null
        : value.dailyLimitMicros !== null &&
          value.totalLimitMicros !== null &&
          value.dailyLimitMicros <= value.totalLimitMicros,
    {
      message:
        "Fixed budgets require finite limits; RouterAI balance mode requires RUB and explicit null limits",
    },
  )
  .refine(
    (value) =>
      new Set(value.rules.map((rule) => rule.key)).size === value.rules.length,
    {
      message: "Duplicate budget rules",
    },
  )
  .refine(
    (value) =>
      !value.enabled ||
      (value.rules.length > 0 &&
        (value.mode === "routerai_balance" ||
          (value.dailyLimitMicros !== null && value.dailyLimitMicros > 0))),
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
  mode: "fixed" | "routerai_balance";
  dailyLimitMicros: number | null;
  totalLimitMicros: number | null;
  userDailyLimitMicros: number | null;
  rules: (AiExecution & { attemptCeilingMicros: number })[];
};
export type AiUserBudgetStatus = {
  currency: "RUB" | "USD" | null;
  day: string;
  resetAt: string;
  limitMicros: number | null;
  reservedTodayMicros: number;
  remainingMicros: number | null;
};
// Immutable audit JSON predates both the personal cap and operator money mode.
// Keep absence distinct from explicit values; live settings include both fields.
export type AiBudgetAuditSnapshot = Omit<
  AiBudgetSettings,
  "userDailyLimitMicros" | "mode"
> & {
  userDailyLimitMicros?: number | null;
  mode?: AiBudgetSettings["mode"];
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
    payload: { from: AiBudgetAuditSnapshot; to: AiBudgetAuditSnapshot };
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
  return formatMoneyCounterMicros(amount);
}
// Cumulative reservation audit can exceed a single bounded money input. Keep
// that display exact without relaxing parseMoneyMicros or payment ceilings.
export function formatMoneyCounterMicros(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error("Invalid money counter");
  const micros = BigInt(amount);
  const scale = BigInt(MONEY_SCALE);
  const fraction = String(micros % scale)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return String(micros / scale) + (fraction ? "." + fraction : "");
}
