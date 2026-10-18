import { z } from "zod";

// Offline contracts only. Passing validation records explicit operator choices;
// it is neither a tax/legal opinion nor permission to enable live payments.
// This is a future 54-FZ/non-NPD preview branch, not the NPD operator's receipt
// workflow. NPD must not be mapped to tax_system_code 1..6 or a guessed tax.
// Sources checked 2026-10-18:
// https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/parameters-values
// https://yookassa.ru/developers/payment-acceptance/receipts/54fz/other-services/parameters-values
// https://yookassa.ru/docs/support/merchant/payments/implement/docs
const hasNoControlCharacters = (value: string) =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
const reference = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(hasNoControlCharacters);
const itemDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(hasNoControlCharacters);
const safeEvidenceUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });

// Provider codes are not tax advice: in particular, this does not decide which
// of the provider's codes is legally applicable to this operator in 2026.
export const paymentFiscalVatCodeSchema = z.number().int().min(1).max(12);
export const paymentFiscalTaxSystemCodeSchema = z.number().int().min(1).max(6);
export const paymentFiscalKopeksSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const paymentFiscalProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    fiscalFramework: z.literal("54fz_non_npd"),
    approved: z.literal(true),
    approvalReference: reference,
    approvalEvidenceUrl: safeEvidenceUrl.optional(),
    cashSolution: z.enum(["yookassa", "external"]),
    scenario: z.enum([
      "payment_and_receipt",
      "receipt_then_payment",
      "payment_then_receipt",
    ]),
    businessModel: z.enum(["wallet_advance", "defined_service_prepayment"]),
    itemDescription: itemDescriptionSchema,
    paymentSubject: z.enum(["payment", "service"]),
    paymentMode: z.enum(["advance", "full_prepayment"]),
    vatCode: paymentFiscalVatCodeSchema,
    taxSystemCode: paymentFiscalTaxSystemCodeSchema,
    closingReceipts: z.strictObject({
      strategy: z.enum(["on_each_service", "operator_managed"]),
      workflowReference: reference,
    }),
  })
  .superRefine((profile, context) => {
    if (
      profile.cashSolution === "yookassa" &&
      profile.scenario !== "payment_and_receipt"
    ) {
      context.addIssue({ code: "custom", message: "Fiscal scenario mismatch" });
    }
    if (
      profile.businessModel === "wallet_advance" &&
      (profile.cashSolution !== "external" ||
        profile.paymentMode !== "advance" ||
        profile.paymentSubject !== "payment")
    ) {
      context.addIssue({ code: "custom", message: "Fiscal model mismatch" });
    }
    if (
      profile.businessModel === "defined_service_prepayment" &&
      (profile.paymentMode !== "full_prepayment" ||
        profile.paymentSubject !== "service")
    ) {
      context.addIssue({ code: "custom", message: "Fiscal model mismatch" });
    }
  });
export type PaymentFiscalProfile = z.infer<typeof paymentFiscalProfileSchema>;

export const paymentFiscalCustomerSchema = z.strictObject({
  email: z.email().max(254),
});
export type PaymentFiscalCustomer = z.infer<typeof paymentFiscalCustomerSchema>;

const rubValueSchema = z
  .string()
  .max(17)
  .regex(/^(?:0|[1-9]\d*)\.\d{2}$/u)
  .refine((value) => {
    try {
      const kopeks = BigInt(value.replace(".", ""));
      return kopeks > 0n && kopeks <= BigInt(Number.MAX_SAFE_INTEGER);
    } catch {
      return false;
    }
  });

// This deliberately limited preview supports one non-agent, unmarked item and
// quantity 1 only. It does not pretend to implement every provider receipt.
export const paymentFiscalReceiptSchema = z.strictObject({
  customer: paymentFiscalCustomerSchema,
  items: z
    .array(
      z.strictObject({
        description: itemDescriptionSchema,
        quantity: z.literal("1.000"),
        amount: z.strictObject({
          value: rubValueSchema,
          currency: z.literal("RUB"),
        }),
        vat_code: paymentFiscalVatCodeSchema,
        payment_mode: z.enum(["advance", "full_prepayment"]),
        payment_subject: z.enum(["payment", "service"]),
        measure: z.literal("piece"),
      }),
    )
    .length(1),
  tax_system_code: paymentFiscalTaxSystemCodeSchema.optional(),
});
export type PaymentFiscalReceipt = z.infer<typeof paymentFiscalReceiptSchema>;

export type PaymentFiscalErrorCode =
  "profile" | "customer" | "amount" | "receipt";
export class PaymentFiscalError extends Error {
  constructor(readonly code: PaymentFiscalErrorCode) {
    // No cause, Zod issues, invalid field names, email, URL or raw value.
    super("Invalid fiscal preview input");
    this.name = "PaymentFiscalError";
  }
}

// Schema validation errors are developer data and must not be logged or sent to
// clients. Use these parsing/building helpers when input could contain PII.
export function parsePaymentFiscalProfile(
  input: unknown,
): PaymentFiscalProfile {
  const result = paymentFiscalProfileSchema.safeParse(input);
  if (!result.success) throw new PaymentFiscalError("profile");
  return result.data;
}

export function parsePaymentFiscalCustomer(
  input: unknown,
): PaymentFiscalCustomer {
  const result = paymentFiscalCustomerSchema.safeParse(input);
  if (!result.success) throw new PaymentFiscalError("customer");
  return result.data;
}

export function formatFiscalRub(amountKopeks: unknown): string {
  const result = paymentFiscalKopeksSchema.safeParse(amountKopeks);
  if (!result.success) throw new PaymentFiscalError("amount");
  const amount = BigInt(result.data);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}

export function assertFiscalReceiptTotal(
  receipt: unknown,
  expectedAmountKopeks: unknown,
): PaymentFiscalReceipt {
  const expected = paymentFiscalKopeksSchema.safeParse(expectedAmountKopeks);
  const parsed = paymentFiscalReceiptSchema.safeParse(receipt);
  if (!expected.success) throw new PaymentFiscalError("amount");
  if (!parsed.success) throw new PaymentFiscalError("receipt");
  const total = parsed.data.items.reduce(
    (sum, item) => sum + BigInt(item.amount.value.replace(".", "")),
    0n,
  );
  if (total !== BigInt(expected.data)) throw new PaymentFiscalError("receipt");
  return parsed.data;
}

export type PaymentFiscalReceiptPlan = {
  purpose: "offline_preview_only";
  profile: PaymentFiscalProfile;
  receipt: PaymentFiscalReceipt;
};

const receiptPreviewInputSchema = z.strictObject({
  profile: z.unknown(),
  customer: z.unknown(),
  amountKopeks: z.unknown(),
});

export function buildPaymentReceipt(input: unknown): PaymentFiscalReceiptPlan {
  const parsed = receiptPreviewInputSchema.safeParse(input);
  if (!parsed.success) throw new PaymentFiscalError("receipt");
  const profile = parsePaymentFiscalProfile(parsed.data.profile);
  const customer = parsePaymentFiscalCustomer(parsed.data.customer);
  const value = formatFiscalRub(parsed.data.amountKopeks);
  const receipt = assertFiscalReceiptTotal(
    {
      customer,
      items: [
        {
          description: profile.itemDescription,
          quantity: "1.000",
          amount: { value, currency: "RUB" },
          vat_code: profile.vatCode,
          payment_mode: profile.paymentMode,
          payment_subject: profile.paymentSubject,
          measure: "piece",
        },
      ],
      // Built-in YooKassa receipts do not accept tax_system_code here; the
      // explicit operator choice remains in the immutable preview profile.
      ...(profile.cashSolution === "external"
        ? { tax_system_code: profile.taxSystemCode }
        : {}),
    },
    parsed.data.amountKopeks,
  );
  return { purpose: "offline_preview_only", profile, receipt };
}
