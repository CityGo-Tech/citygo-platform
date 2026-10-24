import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiAccess, Message } from "@citygo/contracts";
import {
  EmptyAiCreditHint,
  hasEmptyChargeBalance,
  messageInterruptionLabel,
} from "./chat-readiness";

const message: Message = {
  id: "synthetic-message",
  role: "assistant",
  content: "Проверьте баланс перед платным запросом.",
  agentKey: "support",
  status: "interrupted",
};
function access(
  chargingStatus: "not_connected" | "routerai_at_cost" | "routerai_citygo_10x",
  availableMicros = 0,
): AiAccess {
  return {
    policy: null,
    granted: false,
    dailyLimit: 0,
    credit: {
      currency: "RUB",
      bonusGranted: false,
      grantedMicros: availableMicros,
      availableMicros,
      heldMicros: 0,
      spentMicros: 0,
      chargingStatus,
      topUpAvailable: false,
      history: [],
    },
  };
}

test("only the confirmed assistant failure code changes the historical interrupted label", () => {
  assert.equal(
    messageInterruptionLabel(
      { ...message, failureCode: "AI_CREDIT_EXHAUSTED" },
      "Ответ прерван",
    ),
    "Запрос не отправлен ИИ",
  );
  for (const failureCode of [undefined, null]) {
    assert.equal(
      messageInterruptionLabel({ ...message, failureCode }, "Ответ прерван"),
      "Ответ прерван",
    );
    assert.equal(
      messageInterruptionLabel(
        { ...message, failureCode },
        "Ответ не завершён",
      ),
      "Ответ не завершён",
    );
  }
  assert.equal(
    messageInterruptionLabel(
      { ...message, status: "complete" },
      "Ответ прерван",
    ),
    null,
  );
  assert.equal(
    messageInterruptionLabel(
      { ...message, role: "user", failureCode: "AI_CREDIT_EXHAUSTED" },
      "Ответ прерван",
    ),
    "Ответ прерван",
  );
});

test("zero-credit guidance requires connected charging and never guesses a reserve for positive balances", () => {
  assert.equal(hasEmptyChargeBalance(), false);
  assert.equal(hasEmptyChargeBalance(access("not_connected")), false);
  for (const mode of ["routerai_at_cost", "routerai_citygo_10x"] as const) {
    assert.equal(hasEmptyChargeBalance(access(mode)), true);
    assert.equal(hasEmptyChargeBalance(access(mode, 1)), false);
    assert.equal(hasEmptyChargeBalance(access(mode, 100_000_000)), false);
  }
});

test("guidance renders an explicit balance anchor, not a payment action or a hardcoded reserve", () => {
  const html = renderToStaticMarkup(
    createElement(EmptyAiCreditHint, { access: access("routerai_citygo_10x") }),
  );
  assert.match(html, /href="#citygo-balance"/);
  assert.match(html, /Баланс и пополнение/);
  assert.match(html, /Недостаточно средств для нового ответа\./);
  assert.doesNotMatch(html, /100|<button|<form|target=|yookassa|requestId/);
  assert.equal(
    renderToStaticMarkup(
      createElement(EmptyAiCreditHint, { access: access("not_connected") }),
    ),
    "",
  );
});

test("fixed-reserve guidance includes debt and sub-five balances without blocking free handoff", () => {
  const fixed = access("routerai_citygo_10x", 5_000_000);
  fixed.credit = {
    ...fixed.credit!,
    reservationMode: "fixed5_overdraft",
    minimumRequestBalanceMicros: 5_000_000,
    outstandingDebtMicros: 0,
  };
  for (const availableMicros of [-1_000_000, 0, 1, 4_999_999])
    assert.equal(
      hasEmptyChargeBalance({
        ...fixed,
        credit: { ...fixed.credit!, availableMicros },
      }),
      true,
    );
  assert.equal(hasEmptyChargeBalance(fixed), false);
  assert.equal(
    hasEmptyChargeBalance({
      ...fixed,
      credit: { ...fixed.credit!, outstandingDebtMicros: 1 },
    }),
    true,
  );
  assert.equal(
    hasEmptyChargeBalance({
      ...fixed,
      credit: {
        ...fixed.credit!,
        minimumRequestBalanceMicros: undefined,
        availableMicros: 4_999_999,
      },
    }),
    true,
  );
  const html = renderToStaticMarkup(
    createElement(EmptyAiCreditHint, {
      access: { ...fixed, credit: { ...fixed.credit!, availableMicros: -1 } },
    }),
  );
  assert.match(html, /Недостаточно средств для нового ответа\./);
  assert.doesNotMatch(
    html,
    /резерв|5 ₽|×10|стоимость модели|RouterAI|DeepSeek/i,
  );
  assert.match(html, /href="#citygo-balance"/);
  assert.doesNotMatch(html, /<button|<form|disabled|target=|yookassa/);
  assert.equal(hasEmptyChargeBalance(access("routerai_citygo_10x", -1)), true);
});
