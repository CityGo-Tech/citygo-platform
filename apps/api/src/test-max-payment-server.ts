// Playwright-only entrypoint. Uses a private in-memory database and injected fetch.
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import {
  YOOKASSA_RECEIPT_PROFILE,
  yooKassaReceiptRegistrationSchema,
} from "@citygo/contracts";
import { connectDatabase, DomainError, migrate } from "@citygo/db";
import { z } from "zod";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import { ApiDrain, installShutdown } from "./shutdown.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import { YooKassaClient } from "./yookassa.js";
import { YooKassaRefundClient } from "./yookassa-refunds.js";

if (process.env.NODE_ENV !== "test")
  throw new Error("MAX payment fixture requires NODE_ENV=test");

const shopId = "153001";
const secretKey = "test_PUBLIC_MAX_PAYMENT_FIXTURE";
const controlToken = "citygo-max-payment-control-fixture-v1";
const config = readConfig({
  NODE_ENV: "test",
  WEB_ORIGIN: "https://max-payments.example.test",
  TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  LLM_PROVIDER: "disabled",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  YOOKASSA_MODE: "test",
  YOOKASSA_SHOP_ID: shopId,
  YOOKASSA_SECRET_KEY: secretKey,
  YOOKASSA_FISCAL_PROFILE: YOOKASSA_RECEIPT_PROFILE,
});

type Amount = { value: string; currency: "RUB" };
type PaymentBody = {
  amount: Amount;
  metadata: { citygo_order_id: string };
  receipt?: unknown;
};
type RefundBody = {
  amount: Amount;
  metadata: { citygo_refund_id: string };
  payment_id: string;
};
type Status = "pending" | "succeeded" | "canceled";
type Payment = {
  id: string;
  input: PaymentBody;
  status: Status;
  receiptRegistration: Status;
  mismatch?: boolean;
};
type Refund = { id: string; input: RefundBody; status: Status };
const payments = new Map<string, Payment>();
const refunds = new Map<string, Refund>();
const amountKopeks = (amount: Amount) => Number(amount.value.replace(".", ""));
const amount = (kopeks: number) => ({
  currency: "RUB",
  value: (kopeks / 100).toFixed(2),
});

function paymentResponse(payment: Payment) {
  const refunded = [...refunds.values()]
    .filter(
      (refund) =>
        refund.input.payment_id === payment.id && refund.status === "succeeded",
    )
    .reduce((total, refund) => total + amountKopeks(refund.input.amount), 0);
  return Response.json({
    id: payment.id,
    amount: payment.input.amount,
    metadata: payment.mismatch
      ? { citygo_order_id: randomUUID() }
      : payment.input.metadata,
    recipient: { account_id: shopId },
    status: payment.status,
    paid: payment.status === "succeeded",
    test: true,
    refundable:
      payment.status === "succeeded" &&
      refunded < amountKopeks(payment.input.amount),
    refunded_amount: amount(refunded),
    receipt_registration: payment.receiptRegistration,
    ...(payment.status === "pending"
      ? {
          confirmation: {
            type: "redirect",
            confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${payment.id}`,
          },
        }
      : {}),
  });
}

function refundResponse(refund: Refund) {
  return Response.json({
    id: refund.id,
    payment_id: refund.input.payment_id,
    amount: refund.input.amount,
    metadata: refund.input.metadata,
    status: refund.status,
    receipt_registration: "pending",
  });
}

const fetchFixture: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.yookassa.ru")
    throw new Error("Unexpected fixture transport host");
  const id = url.pathname.split("/").at(-1)!;
  if (init?.method === "POST" && url.pathname === "/v3/payments") {
    const body = JSON.parse(String(init.body)) as PaymentBody;
    const key = new Headers(init.headers).get("Idempotence-Key");
    if (key !== body.metadata.citygo_order_id || !body.receipt)
      throw new Error("Invalid test payment payload");
    const known = [...payments.values()].find(
      (entry) => entry.input.metadata.citygo_order_id === key,
    );
    const payment =
      known ??
      ({
        id: randomUUID(),
        input: body,
        status: "pending",
        receiptRegistration: "pending",
      } satisfies Payment);
    payments.set(payment.id, payment);
    return paymentResponse(payment);
  }
  if (init?.method === "POST" && url.pathname === "/v3/refunds") {
    const body = JSON.parse(String(init.body)) as RefundBody;
    const key = new Headers(init.headers).get("Idempotence-Key");
    if (
      key !== body.metadata.citygo_refund_id ||
      !payments.has(body.payment_id)
    )
      throw new Error("Invalid test refund payload");
    const known = [...refunds.values()].find(
      (entry) => entry.input.metadata.citygo_refund_id === key,
    );
    const refund =
      known ??
      ({ id: randomUUID(), input: body, status: "pending" } satisfies Refund);
    refunds.set(refund.id, refund);
    return refundResponse(refund);
  }
  const payment = payments.get(id);
  if (
    init?.method === "GET" &&
    url.pathname.startsWith("/v3/payments/") &&
    payment
  )
    return paymentResponse(payment);
  const refund = refunds.get(id);
  if (
    init?.method === "GET" &&
    url.pathname.startsWith("/v3/refunds/") &&
    refund
  )
    return refundResponse(refund);
  throw new Error("Unexpected fixture transport operation");
};

const db = await connectDatabase("pglite://:memory:");
await migrate(db);
const drain = new ApiDrain();
const transport = {
  mode: "test" as const,
  shopId,
  secretKey,
  fetch: fetchFixture,
};
const app = await buildApp({
  db,
  config,
  drain,
  testing: true,
  syntheticMaxPayments: true,
  paymentClient: new YooKassaClient(transport),
  refundClient: new YooKassaRefundClient(transport),
});
app.addHook("onClose", () => db.close());

function checkControl(authorization: string | undefined) {
  if (authorization !== `Bearer ${controlToken}`)
    throw new DomainError(403, "Fixture control required");
}
app.post("/v1/test/max-yookassa/payment", async (request) => {
  checkControl(request.headers.authorization);
  const { paymentId, ...update } = z
    .strictObject({
      paymentId: z.uuid(),
      status: z.enum(["pending", "succeeded", "canceled"]).optional(),
      receiptRegistration: yooKassaReceiptRegistrationSchema.optional(),
      mismatch: z.boolean().optional(),
    })
    .parse(request.body);
  const payment = payments.get(paymentId);
  if (!payment) throw new DomainError(404, "Test payment not found");
  payments.set(paymentId, { ...payment, ...update });
  return { ok: true };
});
app.post("/v1/test/max-yookassa/refund", async (request) => {
  checkControl(request.headers.authorization);
  const { refundId, status } = z
    .strictObject({
      refundId: z.uuid(),
      status: z.enum(["succeeded", "canceled"]),
    })
    .parse(request.body);
  const refund = refunds.get(refundId);
  if (!refund) throw new DomainError(404, "Test refund not found");
  refund.status = status;
  return { ok: true };
});

const passwordHash = await hashPassword(randomUUID());
for (const [index, name] of [
  "desktop-0",
  "desktop-1",
  "mobile-web-0",
  "mobile-web-1",
].entries()) {
  for (const kind of ["owner", "visitor", "admin"] as const) {
    const id = await registerSyntheticConsentingUser(
      db,
      `max-payments-${name}${kind === "owner" ? "" : `-${kind}`}@example.test`,
      passwordHash,
      app,
    );
    if (kind === "admin")
      await db.query("update users set role='super_admin' where id=$1", [id]);
    else
      await db.query(
        "insert into messenger_accounts(provider,subject,user_id) values('max',$1,$2)",
        [1_440_000 + index * 2 + (kind === "visitor" ? 1 : 0), id],
      );
    for (const session of kind === "owner" ? [kind, "web"] : [kind]) {
      const token = tokenHash(`citygo-max-payment-test-v1:${name}:${session}`);
      await db.query(
        "insert into sessions(token_hash,user_id,expires_at,messenger_provider) values($1,$2,clock_timestamp()+interval '1 day',$3)",
        [
          tokenHash(token),
          id,
          session === "owner" || session === "visitor" ? "max" : null,
        ],
      );
    }
  }
}
installShutdown(app, drain);
await app.listen({ host: "127.0.0.1", port: 4000 });
