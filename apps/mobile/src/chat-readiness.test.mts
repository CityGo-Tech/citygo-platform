import assert from "node:assert/strict";
import test from "node:test";
import type { AiAccess, Message } from "@citygo/contracts";
import {
  hasEmptyChargeBalance,
  messageInterruptionLabel,
} from "./chat-readiness.js";

const message: Message = {
  id: "synthetic-message",
  role: "assistant",
  content: "Проверьте баланс перед платным запросом.",
  agentKey: "support",
  status: "interrupted",
};
test("native history uses confirmed no-dispatch code without reclassifying legacy interruptions", () => {
  assert.equal(
    messageInterruptionLabel({
      ...message,
      failureCode: "AI_CREDIT_EXHAUSTED",
    }),
    "Запрос не отправлен ИИ",
  );
  assert.equal(messageInterruptionLabel(message), "Ответ прерван");
  assert.equal(
    messageInterruptionLabel({ ...message, failureCode: null }),
    "Ответ прерван",
  );
  assert.equal(
    messageInterruptionLabel({ ...message, status: "complete" }),
    null,
  );
  assert.equal(
    messageInterruptionLabel({
      ...message,
      role: "user",
      failureCode: "AI_CREDIT_EXHAUSTED",
    }),
    "Ответ прерван",
  );
});
test("native zero-balance hint is not a model/handoff admission guard or a guessed reserve threshold", () => {
  const access: AiAccess = {
    policy: null,
    granted: false,
    dailyLimit: 0,
    credit: {
      currency: "RUB",
      bonusGranted: false,
      grantedMicros: 0,
      availableMicros: 0,
      heldMicros: 0,
      spentMicros: 0,
      chargingStatus: "not_connected",
      topUpAvailable: false,
      history: [],
    },
  };
  assert.equal(hasEmptyChargeBalance(), false);
  assert.equal(hasEmptyChargeBalance(access), false);
  for (const chargingStatus of [
    "routerai_at_cost",
    "routerai_citygo_10x",
  ] as const) {
    assert.equal(
      hasEmptyChargeBalance({
        ...access,
        credit: { ...access.credit!, chargingStatus },
      }),
      true,
    );
    assert.equal(
      hasEmptyChargeBalance({
        ...access,
        credit: { ...access.credit!, chargingStatus, availableMicros: 1 },
      }),
      false,
    );
  }
});
