import test from "node:test";
import assert from "node:assert/strict";
import { createTopupSchema, topupOrderSchema } from "./payments.js";

const order = {
  orderId: "4a7ecb31-0895-4b81-965b-69f47c6ce9e7",
  amountKopeks: 10_000,
  creditMicros: 100_000_000,
  currency: "RUB",
  test: true,
  status: "pending",
  credited: false,
  confirmationUrl: "https://checkout.example.test/pay",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
} as const;

test("test checkout contracts use exact kopeks and the 1:1 CityGo payment rate", () => {
  assert.equal(topupOrderSchema.safeParse(order).success, true);
  assert.equal(
    createTopupSchema.safeParse({
      requestId: order.orderId,
      amountKopeks: 100,
    }).success,
    true,
  );
  for (const amountKopeks of [99, 100.5, 1_000_001, Infinity, NaN]) {
    assert.equal(
      createTopupSchema.safeParse({ requestId: order.orderId, amountKopeks })
        .success,
      false,
    );
  }
  assert.equal(
    topupOrderSchema.safeParse({ ...order, creditMicros: 1_000_000_000 })
      .success,
    false,
  );
});

test("test checkout accepts only safe HTTPS links and server-confirmed terminal credit", () => {
  for (const confirmationUrl of [
    "not-a-url",
    "https://[invalid",
    "",
    "javascript:alert(1)",
    "http://checkout.example.test/pay",
    "https://user:password@checkout.example.test/pay",
  ]) {
    assert.equal(
      topupOrderSchema.safeParse({ ...order, confirmationUrl }).success,
      false,
    );
  }
  assert.equal(
    topupOrderSchema.safeParse({ ...order, test: false }).success,
    false,
  );
  assert.equal(
    topupOrderSchema.safeParse({ ...order, credited: true }).success,
    false,
  );
  assert.equal(
    topupOrderSchema.safeParse({
      ...order,
      status: "succeeded",
      credited: true,
    }).success,
    true,
  );
  assert.equal(
    topupOrderSchema.safeParse({
      ...order,
      updatedAt: "2026-10-17T10:00:00.000Z",
    }).success,
    false,
  );
  assert.equal(
    topupOrderSchema.safeParse({ ...order, token: "not-a-dto" }).success,
    false,
  );
});
