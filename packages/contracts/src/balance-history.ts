import { z } from "zod";
import { creditUserIdSchema } from "./ai-credit.js";
import { CITYGO_MAX_AMOUNT_MICROS } from "./citygo-tariff.js";

export const BALANCE_HISTORY_PAGE_SIZE = 20;
export const BALANCE_HISTORY_BYTE_BUDGET = 16_384;
export const balanceHistoryFilterSchema = z.enum([
  "all",
  "gift",
  "topup",
  "spend",
  "refund",
]);
export const balanceHistoryCursorSchema = z
  .string()
  .min(1)
  .max(700)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
export const balanceHistoryQuerySchema = z.strictObject({
  filter: balanceHistoryFilterSchema.optional(),
  cursor: balanceHistoryCursorSchema.optional(),
});
export const balanceHistoryEntrySchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^(credit|refund):[1-9][0-9]{0,18}$/)
      .refine(
        (value) =>
          /^(credit|refund):[1-9][0-9]{0,18}$/.test(value) &&
          BigInt(value.split(":")[1]!) <= 9223372036854775807n,
      ),
    kind: z.enum(["gift", "topup", "spend", "refund"]),
    direction: z.enum(["credit", "debit"]),
    amountMicros: z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS),
    createdAt: z.iso.datetime({ precision: 6 }),
  })
  .superRefine((entry, ctx) => {
    if (
      (entry.direction === "credit") !==
        ["gift", "topup"].includes(entry.kind) ||
      entry.id.startsWith("refund:") !== (entry.kind === "refund")
    )
      ctx.addIssue({
        code: "custom",
        message: "History direction/source must match the operation",
      });
  });
export type BalanceHistoryEntry = z.infer<typeof balanceHistoryEntrySchema>;
export type BalanceHistoryFilter = z.infer<typeof balanceHistoryFilterSchema>;
export type BalanceHistoryQuery = z.infer<typeof balanceHistoryQuerySchema>;
/** Exact ordering: PostgreSQL microseconds, lane, then bigint identity. */
export function compareBalanceHistoryEntries(
  a: BalanceHistoryEntry,
  b: BalanceHistoryEntry,
) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  const [aLane, aId] = a.id.split(":"),
    [bLane, bId] = b.id.split(":");
  if (aLane !== bLane) return aLane! > bLane! ? -1 : 1;
  return BigInt(aId!) === BigInt(bId!)
    ? 0
    : BigInt(aId!) > BigInt(bId!)
      ? -1
      : 1;
}
export const balanceHistoryPageSchema = z
  .strictObject({
    userId: creditUserIdSchema,
    filter: balanceHistoryFilterSchema,
    entries: z.array(balanceHistoryEntrySchema).max(BALANCE_HISTORY_PAGE_SIZE),
    nextCursor: balanceHistoryCursorSchema.nullable(),
  })
  .superRefine((page, ctx) => {
    if (
      page.entries.some(
        (entry) => !balanceHistoryEntrySchema.safeParse(entry).success,
      )
    )
      return;
    if (
      page.entries.some(
        (entry, index) =>
          (page.filter !== "all" && entry.kind !== page.filter) ||
          (index > 0 &&
            compareBalanceHistoryEntries(page.entries[index - 1]!, entry) >= 0),
      ) ||
      new Set(page.entries.map((entry) => entry.id)).size !==
        page.entries.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message:
          "History must be unique, descending and match the requested filter",
      });
    if (
      page.nextCursor !== null &&
      page.entries.length !== BALANCE_HISTORY_PAGE_SIZE
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Only a full history page can continue",
      });
    if (
      new TextEncoder().encode(JSON.stringify(page)).byteLength >
      BALANCE_HISTORY_BYTE_BUDGET
    )
      ctx.addIssue({
        code: "custom",
        message: "History exceeds its byte budget",
      });
  });
export type BalanceHistoryPage = z.infer<typeof balanceHistoryPageSchema>;
