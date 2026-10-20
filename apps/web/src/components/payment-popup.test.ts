import assert from "node:assert/strict";
import test from "node:test";
import { type TopupOrder } from "@citygo/contracts";
import { openPaymentPopup } from "./payment-popup.js";

const order: TopupOrder = {
  orderId: "4a7ecb31-0895-4b81-965b-69f47c6ce9e7",
  amountKopeks: 10000,
  creditMicros: 100000000,
  currency: "RUB",
  test: true,
  status: "pending",
  credited: false,
  confirmationUrl: "https://checkout.example.test/pay",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
};

function fixture(
  options: {
    blocked?: boolean;
    cannotDetach?: boolean;
    brokenDocument?: boolean;
    navigationFails?: boolean;
    locationInaccessible?: boolean;
  } = {},
) {
  let opener: unknown = {};
  const calls: string[][] = [];
  const head: unknown[] = [];
  const body: unknown[] = [];
  const child = {
    closed: false,
    get opener() {
      return opener;
    },
    set opener(value: unknown) {
      if (!options.cannotDetach) opener = value;
    },
    close() {
      calls.push(["close"]);
      child.closed = true;
    },
    location: {
      currentHref: "about:blank",
      get href() {
        if (options.locationInaccessible)
          throw new Error("synthetic cross-origin restriction");
        return this.currentHref;
      },
      replace(url: string) {
        if (options.navigationFails)
          throw new Error("synthetic browser failure");
        calls.push(["navigate", url]);
      },
    },
    get document() {
      if (options.brokenDocument) throw new Error("synthetic document failure");
      return document;
    },
  };
  const document = {
    title: "",
    createElement(tagName: string) {
      return { tagName };
    },
    head: {
      append(node: unknown) {
        head.push(node);
      },
    },
    body: {
      replaceChildren(...nodes: unknown[]) {
        body.push(...nodes);
      },
    },
  };
  const browser = {
    open(url: string, target: string) {
      calls.push(["open", url, target]);
      return options.blocked ? null : child;
    },
  } as unknown as Pick<Window, "open">;
  return { browser, child, calls, document, head, body };
}

test("explicit create allocates only a blank tab synchronously and severs the opener before any navigation", () => {
  const f = fixture();
  const popup = openPaymentPopup(f.browser);
  assert.equal(popup.opened, true);
  assert.deepEqual(f.calls, [["open", "about:blank", "_blank"]]);
  assert.equal(f.child.opener, null);
  assert.equal(f.document.title, "Оплата CityGo");
  assert.deepEqual(f.head, [
    { tagName: "meta", name: "referrer", content: "no-referrer" },
  ]);
  assert.match(JSON.stringify(f.body), /Готовим страницу оплаты/);
  assert.doesNotMatch(
    JSON.stringify(f.body),
    /receiptEmail|@|requestId|amountKopeks/,
  );
});

test("only a valid pending response hands off once; later cleanup never closes the user's payment page", () => {
  const f = fixture();
  const popup = openPaymentPopup(f.browser);
  assert.equal(popup.navigate(order), true);
  assert.equal(popup.navigate(order), false);
  popup.close();
  assert.deepEqual(f.calls, [
    ["open", "about:blank", "_blank"],
    ["navigate", order.confirmationUrl!],
  ]);
  assert.equal(f.child.closed, false);
});

test("creating, succeeded, canceled and review responses close only the pending blank tab", () => {
  for (const status of [
    "creating",
    "succeeded",
    "canceled",
    "review_required",
  ] as const) {
    const f = fixture();
    const popup = openPaymentPopup(f.browser);
    assert.equal(
      popup.navigate({ ...order, status, credited: status === "succeeded" }),
      false,
    );
    assert.equal(f.child.closed, true);
    assert.equal(f.calls.filter(([kind]) => kind === "navigate").length, 0);
    popup.close();
    assert.equal(f.calls.filter(([kind]) => kind === "close").length, 1);
  }
});

test("malformed or unsafe confirmation responses never navigate or expose raw data in the loading document", () => {
  for (const response of [
    { ...order, confirmationUrl: "http://checkout.example.test/pay" },
    { ...order, confirmationUrl: "javascript:alert(1)" },
    { ...order, confirmationUrl: "data:text/html,PRIVATE" },
    {
      ...order,
      confirmationUrl: "https://PRIVATE:SECRET@checkout.example.test/pay",
    },
    { ...order, receiptEmail: "PRIVATE@synthetic-citygo-mail.ru" },
    { ...order, confirmationUrl: undefined },
    { ...order, creditMicros: 1 },
  ]) {
    const f = fixture();
    const popup = openPaymentPopup(f.browser);
    assert.equal(popup.navigate(response), false);
    assert.equal(f.child.closed, true);
    assert.equal(f.calls.filter(([kind]) => kind === "navigate").length, 0);
    assert.doesNotMatch(JSON.stringify(f.body), /PRIVATE|SECRET|receiptEmail/);
  }
});

test("popup blockers and an inaccessible or unseverable blank tab fail closed without another open", () => {
  for (const options of [
    { blocked: true },
    { cannotDetach: true },
    { brokenDocument: true },
  ]) {
    const f = fixture(options);
    const popup = openPaymentPopup(f.browser);
    assert.equal(popup.opened, false);
    assert.equal(popup.navigate(order), false);
    popup.close();
    assert.equal(f.calls.filter(([kind]) => kind === "open").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "navigate").length, 0);
    if (!options.blocked) assert.equal(f.child.closed, true);
  }
});

test("explicit failure/unmount cleanup prevents a late successful response from opening anything", () => {
  const f = fixture();
  const popup = openPaymentPopup(f.browser);
  popup.close();
  assert.equal(popup.navigate(order), false);
  assert.deepEqual(f.calls, [["open", "about:blank", "_blank"], ["close"]]);
});

test("a user-closed tab or navigation error uses fallback without reopening or changing the payment", () => {
  const closed = fixture();
  const popup = openPaymentPopup(closed.browser);
  closed.child.closed = true;
  assert.equal(popup.navigate(order), false);
  assert.equal(closed.calls.filter(([kind]) => kind === "open").length, 1);
  const failed = fixture({ navigationFails: true });
  assert.equal(openPaymentPopup(failed.browser).navigate(order), false);
  assert.equal(failed.child.closed, true);
  assert.equal(failed.calls.filter(([kind]) => kind === "open").length, 1);
});

test("a user-navigated same-origin or inaccessible loading tab is never closed or redirected", () => {
  for (const crossOrigin of [false, true]) {
    for (const action of ["close", "navigate"] as const) {
      const f = fixture({ locationInaccessible: crossOrigin });
      const popup = openPaymentPopup(f.browser);
      f.child.location.currentHref = "https://unrelated.example.test/";
      if (action === "close") popup.close();
      else assert.equal(popup.navigate(order), false);
      // Cleanup after a failed handoff must also leave this user's tab alone.
      popup.close();
      assert.equal(popup.navigate(order), false);
      assert.equal(f.child.closed, false);
      assert.deepEqual(f.calls, [["open", "about:blank", "_blank"]]);
    }
  }
});
