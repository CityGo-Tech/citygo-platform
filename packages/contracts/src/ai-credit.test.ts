import assert from "node:assert/strict";
import test from "node:test";
import { aiCreditResponseSchema, aiCreditGrantSchema } from "./ai-credit.js";

test("credit contract keeps exact bounded balances and server payment capabilities", () => {
  const valid = {
    currency: "RUB",
    bonusGranted: true,
    grantedMicros: 500000000,
    heldMicros: 100000000,
    spentMicros: 250000000,
    availableMicros: 150000000,
    chargingStatus: "not_connected",
    topUpAvailable: false,
    history: [],
  };
  assert.ok(aiCreditResponseSchema.safeParse(valid).success);
  for (const patch of [
    { currency: "USD" },
    { grantedMicros: 600000000 },
    { availableMicros: 150000001 },
    { heldMicros: -1 },
    { spentMicros: 0.5 },
    { chargingStatus: "active" },
  ])
    assert.equal(
      aiCreditResponseSchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
  assert.ok(
    aiCreditResponseSchema.safeParse({
      ...valid,
      bonusGranted: false,
      topUpAvailable: true,
      chargingStatus: "routerai_citygo_10x",
    }).success,
  );
  assert.ok(
    aiCreditResponseSchema.safeParse({
      ...valid,
      grantedMicros: 600000000,
      availableMicros: 250000000,
      history: [
        {
          id: "1",
          kind: "topup",
          amountMicros: 100000000,
          createdAt: "2026-10-18T00:00:00.000Z",
        },
      ],
    }).success,
  );
  assert.equal(
    aiCreditGrantSchema.safeParse({ userId: "1", confirmOneTime500Rub: true })
      .success,
    true,
  );
  for (const body of [
    { userId: "1" },
    { userId: "1", confirmOneTime500Rub: false },
    { userId: "01", confirmOneTime500Rub: true },
    { userId: "1", confirmOneTime500Rub: true, amount: 500 },
  ])
    assert.equal(aiCreditGrantSchema.safeParse(body).success, false);
});
