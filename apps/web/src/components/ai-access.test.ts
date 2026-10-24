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
      onConsent() {},
    }),
  ).replace(/<!--.*?-->/g, "");
}
test("balance panel displays signed availability, separate debt and the full-cost warning", () => {
  const html = render(balance(-8_000_001, 3_000_001));
  assert.match(html, /Доступно: -8\.000001 ₽/);
  assert.match(html, /Задолженность: 3\.000001 ₽ CityGo/);
  assert.match(html, /резервируется 5 ₽ CityGo/);
  assert.match(html, /Это не итоговая цена/);
  assert.match(html, /стоимость модели ×10/);
  assert.match(html, /баланс станет отрицательным/);
  assert.match(html, /пополнение сначала погашает задолженность/);
  assert.match(html, /Оплата 100 ₽ пополняет баланс на 100 ₽ CityGo/);
  assert.doesNotMatch(html, /резервируется верхняя оценка/);
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
  assert.match(html, /Доступно: -5 ₽/);
  assert.match(html, /резервируется верхняя оценка/);
  assert.doesNotMatch(html, /резервируется 5 ₽/);
});

test("dedicated wallet has no AI-consent mutations or stale SMS availability claim", () => {
  const html = renderToStaticMarkup(
    createElement(AiAccessPanel, {
      access: balance(0),
      busy: false,
      balanceOnly: true,
      onPhone() {},
      onConsent() {},
    }),
  );
  assert.match(html, /id="citygo-balance"/);
  assert.match(html, /Телефон и подарок/);
  assert.doesNotMatch(
    html,
    /Подтверждение пока не подключено|Отозвать разрешение AI|Подтвердить получателя AI/,
  );
});

test("chat with account navigation has no second wallet or payment form", () => {
  const html = renderToStaticMarkup(
    createElement(AiAccessPanel, {
      access: balance(0),
      busy: false,
      onBalance() {},
      onConsent() {},
    }),
  );
  assert.match(html, /Баланс и пополнение/);
  assert.doesNotMatch(html, /id="citygo-balance"|Сумма пополнения/);
  assert.match(html, /Отозвать разрешение AI/);
});
