import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiAccess } from "@citygo/contracts";
import { AiAccessPanel } from "./ai-access";

function balance(availableMicros: number, outstandingDebtMicros?: number) {
  const access: AiAccess = {
    policy: null,
    granted: true,
    dailyLimit: 20,
    credit: {
      currency: "RUB",
      bonusGranted: false,
      grantedMicros: 5_000_000,
      heldMicros: 5_000_000,
      spentMicros: -availableMicros,
      availableMicros,
      reservationMode: "fixed5_overdraft",
      minimumRequestBalanceMicros: 5_000_000,
      outstandingDebtMicros,
      chargingStatus: "routerai_citygo_10x",
      topUpAvailable: false,
      history: [],
    },
  };
  return access;
}
function render(access: AiAccess) {
  return renderToStaticMarkup(
    createElement(AiAccessPanel, {
      access,
      busy: false,
    }),
  ).replace(/<!--.*?-->/g, "");
}
test("balance panel displays exact signed availability and actual debt without internal pricing", () => {
  const html = render(balance(-8_000_001, 3_000_001));
  assert.match(html, /class="balance-amount">-8\.000001 ₽ CityGo/);
  assert.match(html, /Задолженность: 3\.000001 ₽ CityGo/);
  assert.match(html, /Пополнение сначала погасит её/);
  assert.match(html, /баланс может стать отрицательным/);
  assert.doesNotMatch(
    html,
    /резерв|×10|стоимость модели|RouterAI|DeepSeek|ЮKassa|ProstoSMS/i,
  );
});
test("balance panel never invents outstanding debt from negative availability or reprices legacy mode", () => {
  const access = balance(-5_000_000);
  assert.doesNotMatch(render(access), /Задолженность:/);
  const legacy = {
    ...access,
    credit: {
      ...access.credit!,
      reservationMode: undefined,
      minimumRequestBalanceMicros: undefined,
      outstandingDebtMicros: undefined,
    },
  };
  const html = render(legacy);
  assert.match(html, /class="balance-amount">-5 ₽ CityGo/);
  assert.doesNotMatch(html, /Задолженность:|резерв|×10|стоимость модели/i);
});

test("dedicated wallet has no AI-consent mutations or stale SMS availability claim", () => {
  const html = renderToStaticMarkup(
    createElement(AiAccessPanel, {
      access: balance(0),
      busy: false,
      onPhone() {},
    }),
  );
  assert.match(html, /id="citygo-balance"/);
  assert.match(html, /Получить подарок 500 ₽/);
  assert.doesNotMatch(
    html,
    /<h2|резерв|×10|RouterAI|DeepSeek|ЮKassa|ProstoSMS/i,
  );
  assert.doesNotMatch(
    html,
    /Подтверждение пока не подключено|Отозвать согласие|Условия обработки сообщений/,
  );
});

test("wallet is independent of AI consent and never includes the removed pre-chat card", () => {
  const access = balance(23_000_000);
  access.policy = {
    id: "a".repeat(64),
    version: "synthetic-policy",
    provider: "routerai",
    model: "synthetic/private-model",
    recipient: "SYNTHETIC_PRIVATE_RECIPIENT",
    routing: "SYNTHETIC_PRIVATE_ROUTING",
    data: "SYNTHETIC_PRIVATE_DATA",
  };
  const grantedHtml = render(access);
  access.granted = false;
  const ungrantedHtml = render(access);
  assert.equal(ungrantedHtml, grantedHtml);
  assert.match(ungrantedHtml, /id="citygo-balance"/);
  assert.match(ungrantedHtml, /23 ₽ CityGo/);
  assert.doesNotMatch(
    ungrantedHtml,
    /Перед началом|Настройки обработки сообщений|Условия обработки сообщений|Отозвать согласие|SYNTHETIC_PRIVATE|<input[^>]+checkbox|<h2/,
  );
});

test("wallet links to full read-only history instead of projecting the last operational rows", () => {
  const access = balance(12_345_678);
  access.credit!.history = ["bonus", "topup", "settle", "hold", "release"].map(
    (kind, index) => ({
      id: `synthetic-operation-${index}`,
      kind: kind as "bonus" | "topup" | "settle" | "hold" | "release",
      amountMicros: 1_000_000 + index,
      createdAt: "2026-10-25T10:00:00.000Z",
    }),
  );
  const html = renderToStaticMarkup(
    createElement(AiAccessPanel, {
      access,
      busy: false,
      userId: "1",
      renderHistory: () => null,
    }),
  );
  assert.match(html, /История баланса/);
  assert.doesNotMatch(
    html,
    /Последние операции|Общение с помощником|1\.00000|synthetic-operation|hold|release/,
  );
});
