export type PaymentAttempt = {
  requestId: string;
  amountKopeks: number;
  orderId?: string;
};

// Exact decimal entry: do not multiply a floating-point rouble price.
export function paymentAmountKopeks(value: string): number | null {
  const match = /^(\d{1,5})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return amount >= 100 && amount <= 1_000_000 ? amount : null;
}

export function parsePaymentAttempt(
  value: string | null,
): PaymentAttempt | null {
  if (value === null) return null;
  if (value.length > 1000) throw new Error("Invalid pending payment");
  const input: unknown = JSON.parse(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid pending payment");
  }
  const item = input as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["requestId", "amountKopeks", "orderId"].includes(key),
    )
  ) {
    throw new Error("Invalid pending payment");
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof item.requestId !== "string" ||
    !uuid.test(item.requestId) ||
    typeof item.amountKopeks !== "number" ||
    !Number.isInteger(item.amountKopeks) ||
    item.amountKopeks < 100 ||
    item.amountKopeks > 1_000_000
  ) {
    throw new Error("Invalid pending payment");
  }
  const attempt = {
    requestId: item.requestId,
    amountKopeks: item.amountKopeks,
  };
  if (item.orderId !== undefined) {
    if (typeof item.orderId !== "string" || !uuid.test(item.orderId))
      throw new Error("Invalid pending payment");
    return { ...attempt, orderId: item.orderId };
  }
  return attempt;
}
