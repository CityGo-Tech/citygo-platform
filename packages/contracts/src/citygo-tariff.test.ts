import assert from "node:assert/strict";
import test from "node:test";
import { routerAiChargeSchema, routerAiCostMicros } from "./ai-credit.js";
import {
  CITYGO_10X_TARIFF,
  CITYGO_MAX_AMOUNT_MICROS,
  CITYGO_WELCOME_CREDIT_MICROS,
  LEGACY_AT_COST_TARIFF,
  REAL_MAX_COST_MICROS,
  citygoDebitFromRealCostRub,
  citygoTariffSnapshotSchema,
  citygoTopUpMicrosFromPaidKopeks,
  reserveCitygoMicros,
  type CityGoTariffSnapshot,
} from "./citygo-tariff.js";

test("tariff snapshots fix each version to its original ratio and reject extras", () => {
  for (const tariff of [LEGACY_AT_COST_TARIFF, CITYGO_10X_TARIFF]) {
    assert.deepEqual(citygoTariffSnapshotSchema.parse(tariff), tariff);
    assert.ok(Object.isFrozen(tariff));
    for (const patch of [
      { version: "unknown" },
      { realCurrency: "USD" },
      { balanceUnit: "RUB" },
      { numerator: 100 },
      { denominator: 10 },
      { dailyLimitMicros: 500_000_000 },
    ])
      assert.equal(
        citygoTariffSnapshotSchema.safeParse({ ...tariff, ...patch }).success,
        false,
      );
  }
  assert.equal(
    citygoTariffSnapshotSchema.safeParse({
      ...LEGACY_AT_COST_TARIFF,
      numerator: 10,
    }).success,
    false,
  );
  assert.equal(
    citygoTariffSnapshotSchema.safeParse({
      ...CITYGO_10X_TARIFF,
      numerator: 1,
    }).success,
    false,
  );
});

test("new spending is 10x while an explicit legacy snapshot replays at cost", () => {
  assert.deepEqual(citygoDebitFromRealCostRub("2", CITYGO_10X_TARIFF), {
    realCostMicros: 2_000_000,
    citygoDebitMicros: 20_000_000,
  });
  assert.deepEqual(citygoDebitFromRealCostRub("2", LEGACY_AT_COST_TARIFF), {
    realCostMicros: 2_000_000,
    citygoDebitMicros: 2_000_000,
  });
  assert.equal(
    citygoDebitFromRealCostRub("50", CITYGO_10X_TARIFF).citygoDebitMicros,
    CITYGO_WELCOME_CREDIT_MICROS,
  );
  const replayed = JSON.parse(JSON.stringify(LEGACY_AT_COST_TARIFF));
  assert.deepEqual(
    citygoDebitFromRealCostRub("1.23", replayed),
    citygoDebitFromRealCostRub("1.23", LEGACY_AT_COST_TARIFF),
  );
});

test("exact decimal and scientific costs are floored only after the ratio", () => {
  for (const [value, realCostMicros, citygoDebitMicros] of [
    ["0", 0, 0],
    ["0.000000000000000000000000000001", 0, 0],
    ["0.00000019", 0, 1],
    ["0.000000099999999999999999999999", 0, 0],
    ["0.0000001", 0, 1],
    ["1.99999999", 1_999_999, 19_999_999],
    ["123.4567899", 123_456_789, 1_234_567_899],
    ["1.9e-7", 0, 1],
    ["19E-8", 0, 1],
    ["12345e-2", 123_450_000, 1_234_500_000],
    ["1e+6", REAL_MAX_COST_MICROS, CITYGO_MAX_AMOUNT_MICROS],
  ] as const) {
    assert.deepEqual(citygoDebitFromRealCostRub(value, CITYGO_10X_TARIFF), {
      realCostMicros,
      citygoDebitMicros,
    });
    assert.equal(
      citygoDebitFromRealCostRub(value, LEGACY_AT_COST_TARIFF)
        .citygoDebitMicros,
      realCostMicros,
    );
  }
  assert.equal(routerAiCostMicros("0.00000019"), 0);
  assert.equal(
    citygoDebitFromRealCostRub("0.00000019", CITYGO_10X_TARIFF)
      .citygoDebitMicros,
    1,
  );
});

test("invalid, oversized and overprecision real prices fail closed", () => {
  for (const value of [
    "",
    "-0",
    "-1",
    "+1",
    " 1",
    "1 ",
    ".5",
    "1.",
    "1,5",
    "1_000",
    "Infinity",
    "NaN",
    "0x10",
    "1e100",
    "1e-99",
    "1e7",
    "1000000.000000000000000000000001",
    "1000001",
    "99999999999999",
    "0.0000000000000000000000000000001",
  ])
    assert.throws(
      () => citygoDebitFromRealCostRub(value, CITYGO_10X_TARIFF),
      Error,
      value,
    );
});

test("real cost rejects non-strings before coercion and bounds input size", () => {
  let conversions = 0;
  const object = {
    toString() {
      conversions++;
      return "2";
    },
  };
  for (const value of [2, ["2"], object, null, undefined, true, "0".repeat(81)])
    assert.throws(() =>
      citygoDebitFromRealCostRub(value as string, CITYGO_10X_TARIFF),
    );
  assert.equal(conversions, 0);
});

test("reservations multiply checked real microunits and reject unsafe values", () => {
  for (const real of [0, 1, 123_456_789, REAL_MAX_COST_MICROS]) {
    assert.equal(reserveCitygoMicros(real, LEGACY_AT_COST_TARIFF), real);
    assert.equal(reserveCitygoMicros(real, CITYGO_10X_TARIFF), real * 10);
  }
  for (const real of [
    -1,
    0.1,
    NaN,
    Infinity,
    REAL_MAX_COST_MICROS + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => reserveCitygoMicros(real, CITYGO_10X_TARIFF));
  const forged = {
    ...CITYGO_10X_TARIFF,
    numerator: 100,
  } as unknown as CityGoTariffSnapshot;
  assert.throws(() => reserveCitygoMicros(1, forged));
  assert.throws(() => citygoDebitFromRealCostRub("1", forged));
});

test("paid roubles credit 1:1, never 10x, with exact kopeks and bounded integers", () => {
  assert.equal(citygoTopUpMicrosFromPaidKopeks(10_000), 100_000_000);
  assert.equal(citygoTopUpMicrosFromPaidKopeks(1), 10_000);
  assert.equal(citygoTopUpMicrosFromPaidKopeks(12_345), 123_450_000);
  assert.equal(
    citygoTopUpMicrosFromPaidKopeks(1_000_000_000),
    CITYGO_MAX_AMOUNT_MICROS,
  );
  for (const paid of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    1_000_000_001,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => citygoTopUpMicrosFromPaidKopeks(paid));
});

test("provider receipt continues recording real cost without a spending multiplier", () => {
  const receipt = {
    generationId: "synthetic_generation",
    reference: "2f3da619-a1e0-4b57-bb12-f5c425f2179b",
    model: "synthetic-model",
    upstream: "synthetic",
    currency: "RUB",
    costRub: "2",
    amountMicros: 2_000_000,
  };
  assert.ok(routerAiChargeSchema.safeParse(receipt).success);
  assert.equal(
    routerAiChargeSchema.safeParse({ ...receipt, amountMicros: 20_000_000 })
      .success,
    false,
  );
});
