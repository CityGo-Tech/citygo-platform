import assert from "node:assert/strict";
import test from "node:test";
import {
  adminCustomerMessagesResponseSchema,
  adminCustomerAccountsQuerySchema,
  adminCustomerPageQuerySchema,
  adminCustomerActivityQuerySchema,
  adminCustomerFunnelQuerySchema,
  customerInteractionInputSchema,
  customerAnalyticsIdentityResponseSchema,
  adminCustomerAccountResponseSchema,
} from "./admin-customer-observability.js";

test("customer observability boundaries reject unbounded queries, malformed IDs and raw telemetry parameters", () => {
  for (const bad of [
    { limit: 0 },
    { limit: 51 },
    { search: "a".repeat(101) },
    { afterUserId: "1\n" },
    { afterUserId: "1 OR 1=1" },
    { userId: "2" },
  ])
    assert.equal(
      adminCustomerAccountsQuerySchema.safeParse(bad).success,
      false,
    );
  assert.equal(adminCustomerAccountsQuerySchema.parse({}).limit, 25);
  assert.equal(
    adminCustomerPageQuerySchema.safeParse({ limit: 101 }).success,
    false,
  );
  assert.equal(
    adminCustomerActivityQuerySchema.safeParse({ before: "not/a/cursor" })
      .success,
    false,
  );
  assert.equal(
    adminCustomerFunnelQuerySchema.safeParse({ days: 91 }).success,
    false,
  );
  assert.equal(
    customerInteractionInputSchema.safeParse({ event: "gift_granted" }).success,
    false,
  );
  assert.equal(
    customerInteractionInputSchema.safeParse({
      event: "wallet_opened",
      email: "private@example.test",
    }).success,
    false,
  );
  assert.equal(
    customerAnalyticsIdentityResponseSchema.safeParse({
      analyticsUserId: "123",
    }).success,
    false,
  );
  assert.equal(
    customerAnalyticsIdentityResponseSchema.safeParse({
      analyticsUserId: "cga_" + "a".repeat(64),
    }).success,
    true,
  );
});
test("message pages preserve bigint identity and ascending order and never tolerate internal fields", () => {
  const row = (id: string) => ({
    id,
    role: "user",
    content: "Вопрос",
    createdAt: "2026-10-28T00:00:00.000001Z",
  });
  const valid = {
    userId: "1",
    conversationId: "2",
    messages: [row("9007199254740992"), row("9007199254740993")],
    nextBeforeId: "9007199254740992",
  };
  assert.equal(
    adminCustomerMessagesResponseSchema.safeParse(valid).success,
    true,
  );
  assert.equal(
    adminCustomerMessagesResponseSchema.safeParse({
      ...valid,
      messages: [...valid.messages].reverse(),
    }).success,
    false,
  );
  assert.equal(
    adminCustomerMessagesResponseSchema.safeParse({
      ...valid,
      messages: [row("1"), row("1")],
    }).success,
    false,
  );
  assert.equal(
    adminCustomerMessagesResponseSchema.safeParse({
      ...valid,
      nextBeforeId: "9007199254740993",
    }).success,
    false,
  );
  assert.equal(
    adminCustomerMessagesResponseSchema.safeParse({
      ...valid,
      messages: [{ ...row("1"), metadata: { token: "secret" } }],
    }).success,
    false,
  );
  assert.doesNotThrow(() =>
    adminCustomerMessagesResponseSchema.safeParse({
      ...valid,
      messages: [row("invalid")],
    }),
  );
  assert.equal(
    adminCustomerAccountResponseSchema.safeParse({
      account: { password_hash: "secret" },
    }).success,
    false,
  );
});
