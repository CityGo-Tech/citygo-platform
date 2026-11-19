import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { DomainError } from "@citygo/db";
import {
  createdTelegramStarsOrderSchema,
  telegramStarsOrderResponseSchema,
  telegramStarsSnapshotSchema,
} from "@citygo/contracts";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  registerTelegramStarsTest,
  TELEGRAM_STARS_TEST_WEBHOOK_PATH,
} from "./http.js";
import type { RefundStarPayment } from "./store.js";

const base = "/v1/mini-apps/telegram/stars";
const secretHeader = "x-telegram-bot-api-secret-token";
const secret = "synthetic-fixture-343061";
const buyer = 12001;
const visitor = 12002;

async function fixture(t: TestContext, refundStarPayment?: RefundStarPayment) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "Invalid input" });
    return reply.send(error);
  });
  const calls: Parameters<RefundStarPayment>[0][] = [];
  let paidEvents = 0;
  registerTelegramStarsTest(app, {
    actor: async (request) => {
      switch (request.headers.authorization) {
        case "Bearer fixture-owner":
          return { userId: "1", telegramUserId: String(buyer) };
        case "Bearer fixture-visitor":
          return { userId: "2", telegramUserId: String(visitor) };
        default:
          throw new DomainError(401, "Sign in");
      }
    },
    webhookSecret: secret,
    onPaid: async () => {
      paidEvents++;
    },
    refundStarPayment: async (input) => {
      calls.push(input);
      return refundStarPayment ? refundStarPayment(input) : true;
    },
  });
  t.after(() => app.close());
  const auth = (actor: "owner" | "visitor" = "owner") => ({
    authorization: `Bearer fixture-${actor}`,
  });
  let nextUpdate = 0;
  const webhook = (
    body: object,
    headers: Record<string, string> = { [secretHeader]: secret },
  ) =>
    app.inject({
      method: "POST",
      url: TELEGRAM_STARS_TEST_WEBHOOK_PATH,
      headers,
      payload: { update_id: ++nextUpdate, ...body },
    });
  const purchase = (orderId: string, currency = "XTR", amount = 1) => ({
    invoice_payload: orderId,
    currency,
    total_amount: amount,
  });
  const approve = (
    orderId: string,
    checkoutId: string,
    options: { from?: number; currency?: string; amount?: number } = {},
  ) =>
    webhook({
      pre_checkout_query: {
        id: checkoutId,
        from: {
          id: options.from ?? buyer,
          first_name: "Fixture Telegram name",
        },
        ...purchase(orderId, options.currency, options.amount),
      },
    });
  const updatePayment = (
    key: "successful_payment" | "refunded_payment",
    orderId: string,
    chargeId: string,
    options: { from?: number; currency?: string; amount?: number } = {},
  ) => {
    const from = options.from ?? buyer;
    return webhook({
      message: {
        from: { id: from },
        chat: { id: from, type: "private" },
        [key]: {
          ...purchase(orderId, options.currency, options.amount),
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: "fixture-provider-reference",
        },
      },
    });
  };
  const create = async (
    requestId: string = randomUUID(),
    actor?: "owner" | "visitor",
  ) => {
    const response = await app.inject({
      method: "POST",
      url: base + "/orders",
      headers: auth(actor),
      payload: { requestId },
    });
    assert.equal(response.statusCode, 200);
    return createdTelegramStarsOrderSchema.parse(response.json());
  };
  const step = (
    id: string,
    action: "cancel" | "refund",
    actor?: "owner" | "visitor",
  ) =>
    app.inject({
      method: "POST",
      url: `${base}/orders/${id}/${action}`,
      headers: auth(actor),
    });
  const snapshot = async (actor?: "owner" | "visitor") => {
    const response = await app.inject({ url: base, headers: auth(actor) });
    assert.equal(response.statusCode, 200);
    return telegramStarsSnapshotSchema.parse(response.json());
  };
  return {
    app,
    calls,
    create,
    step,
    snapshot,
    paidEvents: () => paidEvents,
    webhook,
    approve,
    updatePayment,
  };
}

test("pay and replay require a scoped invoice, bound purchaser, XTR price and a prior approved checkout", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const first = await f.create(key);
  const id = first.order.id;
  assert.deepEqual(await f.create(key), first);
  assert.deepEqual(await f.create(key.toUpperCase()), first);
  assert.equal(first.invoiceUrl, `https://t.me/$citygo-test-${id}`);
  const other = await f.create(key, "visitor");
  assert.notEqual(other.order.id, id);
  assert.equal((await f.step(id, "cancel", "visitor")).statusCode, 404);
  assert.equal(
    (await f.updatePayment("successful_payment", id, "charge-1")).statusCode,
    409,
  );
  for (const invalid of [
    { from: visitor },
    { currency: "RUB" },
    { amount: 2 },
  ]) {
    const denied = await f.approve(id, "checkout-invalid", invalid);
    assert.equal(denied.statusCode, 200);
    assert.equal(denied.json().ok, false);
  }
  const approve = {
    method: "answerPreCheckoutQuery",
    pre_checkout_query_id: "checkout-approved",
    ok: true,
  };
  for (let index = 0; index < 2; index++)
    assert.deepEqual(
      (await f.approve(id, "checkout-approved")).json(),
      approve,
    );
  assert.equal(
    (
      await f.approve(other.order.id, "checkout-approved", { from: visitor })
    ).json().ok,
    false,
  );
  assert.equal((await f.approve(id, "another-checkout")).json().ok, false);
  assert.equal((await f.step(id, "cancel")).statusCode, 409);
  assert.equal((await f.snapshot()).balance, 0);
  assert.equal((await f.snapshot()).orders[0]?.status, "checkout");
  for (const invalid of [
    { from: visitor },
    { currency: "RUB" },
    { amount: 2 },
  ]) {
    const unrelated = await f.updatePayment(
      "successful_payment",
      id,
      "charge-1",
      invalid,
    );
    assert.equal(unrelated.statusCode, 409);
    assert.equal((await f.snapshot()).balance, 0);
  }
  for (let index = 0; index < 2; index++) {
    assert.equal(
      (await f.updatePayment("successful_payment", id, "charge-1")).statusCode,
      200,
    );
    const snapshot = await f.snapshot();
    assert.equal(snapshot.balance, 1);
    assert.equal(snapshot.orders[0]?.status, "paid");
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /checkout-approved|charge-1|12001|provider-reference/,
    );
  }
  assert.equal(f.paidEvents(), 1);
  assert.equal((await f.snapshot("visitor")).balance, 0);
  assert.equal(
    (await f.updatePayment("successful_payment", id, "charge-other"))
      .statusCode,
    409,
  );
  await f.approve(other.order.id, "checkout-2", { from: visitor });
  assert.equal(
    (
      await f.updatePayment("successful_payment", other.order.id, "charge-1", {
        from: visitor,
      })
    ).statusCode,
    409,
  );
});

test("cancellation is terminal before pre-checkout and cannot deliver a test unit", async (t) => {
  const f = await fixture(t);
  const { order } = await f.create();
  const cancelled = await f.step(order.id.toUpperCase(), "cancel");
  assert.equal(cancelled.statusCode, 200);
  assert.equal(
    telegramStarsOrderResponseSchema.parse(cancelled.json()).order.status,
    "cancelled",
  );
  assert.deepEqual((await f.step(order.id, "cancel")).json(), cancelled.json());
  assert.equal((await f.approve(order.id, "closed")).json().ok, false);
  assert.equal(
    (await f.updatePayment("successful_payment", order.id, "closed-charge"))
      .statusCode,
    409,
  );
  assert.equal((await f.step(order.id, "refund")).statusCode, 409);
  assert.equal((await f.snapshot()).balance, 0);
  assert.equal(f.calls.length, 0);
});

test("trusted refund before a success or during a simulated refund remains terminal", async (t) => {
  let adapterCalled!: () => void;
  const entered = new Promise<void>((resolve) => {
    adapterCalled = resolve;
  });
  let completeAdapter!: (ok: boolean) => void;
  const adapter = new Promise<boolean>((resolve) => {
    completeAdapter = resolve;
  });
  const f = await fixture(t, async () => {
    adapterCalled();
    return adapter;
  });
  const early = (await f.create()).order.id;
  await f.approve(early, "checkout-early");
  assert.equal(
    (await f.updatePayment("refunded_payment", early, "charge-early"))
      .statusCode,
    200,
  );
  assert.equal(
    (await f.updatePayment("successful_payment", early, "charge-early"))
      .statusCode,
    200,
  );
  assert.equal((await f.snapshot()).balance, 0);
  assert.equal((await f.snapshot()).orders[0]?.status, "refunded");
  const id = (await f.create()).order.id;
  await f.approve(id, "refund-checkout");
  await f.updatePayment("successful_payment", id, "paid-charge");
  assert.equal((await f.step(id, "refund", "visitor")).statusCode, 404);
  assert.equal(
    (await f.updatePayment("refunded_payment", id, "wrong-charge")).statusCode,
    409,
  );
  assert.equal(
    (
      await f.updatePayment("refunded_payment", id, "paid-charge", {
        from: visitor,
      })
    ).statusCode,
    409,
  );
  const first = f.step(id, "refund");
  const second = f.step(id, "refund");
  await entered;
  assert.deepEqual(f.calls, [
    { user_id: buyer, telegram_payment_charge_id: "paid-charge" },
  ]);
  assert.equal((await f.snapshot()).balance, 1);
  assert.equal(
    (await f.updatePayment("refunded_payment", id, "paid-charge")).statusCode,
    200,
  );
  completeAdapter(false);
  for (const result of await Promise.all([
    first,
    second,
    f.step(id, "refund"),
  ])) {
    assert.equal(result.statusCode, 200);
    assert.equal(
      telegramStarsOrderResponseSchema.parse(result.json()).order.status,
      "refunded",
    );
  }
  assert.equal(f.calls.length, 1);
  assert.equal((await f.snapshot()).balance, 0);
});

test("a successful simulated refund debits one unit and adapter failures preserve entitlement", async (t) => {
  let response = false;
  const f = await fixture(t, async () => response);
  const id = (await f.create()).order.id;
  await f.approve(id, "refund-checkout");
  await f.updatePayment("successful_payment", id, "paid-charge");
  assert.equal((await f.step(id, "refund")).statusCode, 502);
  assert.equal((await f.snapshot()).balance, 1);
  response = true;
  for (let index = 0; index < 2; index++)
    assert.equal((await f.step(id, "refund")).statusCode, 200);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.snapshot()).balance, 0);
});

test("webhook rejects browser authority and malformed updates, and paysupport returns private generic guidance", async (t) => {
  const f = await fixture(t);
  const payload = {
    message: {
      chat: { id: buyer, type: "private" },
      from: { id: buyer },
      text: "/paysupport fixture-private-text",
    },
  };
  for (const headers of [
    {},
    { [secretHeader]: "incorrect" },
    { [secretHeader]: secret, origin: "https://example.test" },
    { [secretHeader]: secret, cookie: "session=fixture-cookie" },
    { [secretHeader]: secret, authorization: "Bearer fixture-owner" },
  ] as Record<string, string>[])
    assert.equal((await f.webhook(payload, headers)).statusCode, 403);
  assert.equal((await f.app.inject({ url: base })).statusCode, 401);
  const reply = await f.webhook(payload);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().method, "sendMessage");
  assert.equal(reply.json().chat_id, buyer);
  assert.match(reply.json().text, /Помощь человека/);
  assert.doesNotMatch(reply.json().text, /fixture-private-text/);
  assert.deepEqual(
    (
      await f.webhook({
        message: { ...payload.message, chat: { id: -1, type: "group" } },
      })
    ).json(),
    { ok: true },
  );
  assert.equal((await f.webhook({ update_id: -1 })).statusCode, 400);
  assert.equal(
    (
      await f.webhook({
        ...payload,
        pre_checkout_query: { from: { id: buyer } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.webhook({ ...payload, extra: "x".repeat(17_000) })).statusCode,
    413,
  );
});
