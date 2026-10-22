import { z } from "zod";

// Explicit operator-selected transport parameters, not a legal/tax approval.
// This profile does not map NPD to another tax regime or change the sale model.
export const YOOKASSA_RECEIPT_PROFILE =
  "citygo_service_full_payment_v1" as const;
export const yooKassaReceiptEmailSchema = z
  .email()
  .max(254)
  .refine((email) => {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return !(
      /(?:^|\.)(?:invalid|localhost|test|example)$/.test(domain) ||
      /(?:^|\.)example\.(?:com|net|org)$/.test(domain)
    );
  }, "Укажите настоящий адрес электронной почты для чека");
export const yooKassaReceiptRegistrationSchema = z.enum([
  "pending",
  "succeeded",
  "canceled",
]);
export type YooKassaReceiptRegistration = z.infer<
  typeof yooKassaReceiptRegistrationSchema
>;
const amountSchema = z.number().int().min(1).max(1_000_000_000);
const rubValueSchema = z
  .string()
  .max(11)
  .regex(/^(?:0|[1-9][0-9]{0,7})\.[0-9]{2}$/)
  .refine((value) => {
    // Zod can still run refinements after a regex/length check failed.
    if (value.length > 11 || !/^(?:0|[1-9][0-9]{0,7})\.[0-9]{2}$/.test(value))
      return false;
    const amount = BigInt(value.replace(".", ""));
    return amount > 0n && amount <= 1_000_000_000n;
  });
export const yooKassaReceiptSchema = z.strictObject({
  customer: z.strictObject({ email: yooKassaReceiptEmailSchema }),
  items: z
    .array(
      z.strictObject({
        description: z.enum([
          "Пополнение баланса CityGo",
          "Пополнение тестового баланса CityGo",
        ]),
        quantity: z.literal("1.000"),
        amount: z.strictObject({
          value: rubValueSchema,
          currency: z.literal("RUB"),
        }),
        vat_code: z.literal(1),
        payment_subject: z.literal("service"),
        payment_mode: z.literal("full_payment"),
        measure: z.literal("piece"),
      }),
    )
    .length(1),
});
export type YooKassaReceipt = z.infer<typeof yooKassaReceiptSchema>;
export class YooKassaReceiptError extends Error {
  constructor() {
    // Never attach Zod issues, caller input, email or an exception cause.
    super("Invalid YooKassa receipt input");
    this.name = "YooKassaReceiptError";
  }
}
export function parseYooKassaReceipt(input: unknown): YooKassaReceipt {
  const parsed = yooKassaReceiptSchema.safeParse(input);
  if (!parsed.success) throw new YooKassaReceiptError();
  return parsed.data; // Zod returns a detached nested snapshot.
}
export function assertYooKassaReceiptTotal(
  input: unknown,
  amountKopeks: unknown,
): YooKassaReceipt {
  const amount = amountSchema.safeParse(amountKopeks);
  if (!amount.success) throw new YooKassaReceiptError();
  const receipt = parseYooKassaReceipt(input);
  if (
    BigInt(receipt.items[0]!.amount.value.replace(".", "")) !==
    BigInt(amount.data)
  )
    throw new YooKassaReceiptError();
  return receipt;
}
const builderSchema = z.strictObject({
  email: yooKassaReceiptEmailSchema,
  amountKopeks: amountSchema,
  test: z.boolean().optional(),
});
export function buildYooKassaReceipt(input: unknown): YooKassaReceipt {
  const parsed = builderSchema.safeParse(input);
  if (!parsed.success) throw new YooKassaReceiptError();
  const { email, test, amountKopeks } = parsed.data;
  const amount = BigInt(amountKopeks);
  return assertYooKassaReceiptTotal(
    {
      customer: { email },
      items: [
        {
          description: test
            ? "Пополнение тестового баланса CityGo"
            : "Пополнение баланса CityGo",
          quantity: "1.000",
          amount: {
            value: `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`,
            currency: "RUB",
          },
          vat_code: 1,
          payment_subject: "service",
          payment_mode: "full_payment",
          measure: "piece",
        },
      ],
    },
    amountKopeks,
  );
}
