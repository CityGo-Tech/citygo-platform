import assert from "node:assert/strict";
import test from "node:test";
import { aiCreditResponseSchema, aiCreditGrantSchema } from "./ai-credit.js";
import { CITYGO_MAX_AMOUNT_MICROS } from "./citygo-tariff.js";

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

test("overdraft capabilities permit only an exact bounded signed net balance", () => {
  const credit = {
    currency: "RUB",
    bonusGranted: false,
    grantedMicros: 5_000_000,
    heldMicros: 0,
    spentMicros: 8_000_001,
    availableMicros: -3_000_001,
    reservationMode: "fixed5_overdraft",
    minimumRequestBalanceMicros: 5_000_000,
    outstandingDebtMicros: 3_000_001,
    chargingStatus: "routerai_citygo_10x",
    topUpAvailable: true,
    history: [],
  };
  assert.deepEqual(aiCreditResponseSchema.parse(credit), credit);
  assert.ok(
    aiCreditResponseSchema.safeParse({
      ...credit,
      grantedMicros: 0,
      spentMicros: CITYGO_MAX_AMOUNT_MICROS,
      availableMicros: -CITYGO_MAX_AMOUNT_MICROS,
      outstandingDebtMicros: CITYGO_MAX_AMOUNT_MICROS,
    }).success,
  );
  // A pending hold also reduces availability. Outstanding debt is a separate
  // server-owned amount, not an alias for the negative net balance.
  assert.ok(
    aiCreditResponseSchema.safeParse({
      ...credit,
      grantedMicros: 10_000_000,
      spentMicros: 13_000_001,
      heldMicros: 5_000_000,
      availableMicros: -8_000_001,
    }).success,
  );
  for (const patch of [
    { availableMicros: -3_000_002 },
    { availableMicros: -CITYGO_MAX_AMOUNT_MICROS - 1 },
    { availableMicros: -0.5 },
    { availableMicros: NaN },
    { availableMicros: -Infinity },
    { grantedMicros: -1 },
    { heldMicros: -1 },
    { spentMicros: -1 },
    { reservationMode: "unlimited" },
    { minimumRequestBalanceMicros: 0 },
    { minimumRequestBalanceMicros: -1 },
    { minimumRequestBalanceMicros: 0.5 },
    { minimumRequestBalanceMicros: CITYGO_MAX_AMOUNT_MICROS + 1 },
    { outstandingDebtMicros: -1 },
    { outstandingDebtMicros: 0.5 },
    { outstandingDebtMicros: CITYGO_MAX_AMOUNT_MICROS + 1 },
    {
      history: [
        {
          id: "1",
          kind: "settle",
          amountMicros: -1,
          createdAt: "2026-10-21T00:00:00.000Z",
        },
      ],
    },
  ])
    assert.equal(
      aiCreditResponseSchema.safeParse({ ...credit, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  const {
    reservationMode,
    minimumRequestBalanceMicros,
    outstandingDebtMicros,
    ...legacy
  } = credit;
  assert.ok(
    reservationMode && minimumRequestBalanceMicros && outstandingDebtMicros,
  );
  assert.deepEqual(aiCreditResponseSchema.parse(legacy), legacy);
  assert.ok(
    aiCreditResponseSchema.safeParse({ ...credit, reservationMode: "full" })
      .success,
  );
});
