import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@citygo/api-client";
import type { OwnerNpdReceiptTask } from "@citygo/contracts";
import { OwnerReceiptList, OwnerReceiptsPanel } from "./owner-receipts";
import {
  createOwnerReceiptsResource,
  ownerReceiptPresentation,
  receiptLoadError,
  receiptMoney,
  type OwnerReceiptsState,
} from "./owner-receipts-state";

const documentUrl =
  "https://lknpd.nalog.ru/api/v1/receipt/SYNTHETIC/receipt-synthetic/print";
function task(
  overrides: Partial<OwnerNpdReceiptTask> = {},
): OwnerNpdReceiptTask {
  return {
    id: "871802b8-deb3-4235-8f61-9e28a7889a52",
    userId: "1",
    paymentId: "synthetic-payment",
    paymentProvider: "yookassa",
    amountKopeks: 10000,
    cumulativeRefundedKopeks: 0,
    remainingIncomeKopeks: 10000,
    revision: 2,
    registrationStatus: "operator_reported",
    deliveryStatus: "pending",
    correctionStatus: "not_required",
    activeEvidenceId: "c2529a6e-c322-4b84-a4fd-6056e0ab5e28",
    activeReceiptId: "receipt-synthetic",
    activeReceiptUrl: documentUrl,
    reviewReason: null,
    observedAt: "2026-10-18T10:00:00.000Z",
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:01:00.000Z",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(load: (signal: AbortSignal) => Promise<unknown>) {
  const session = new AbortController();
  const states: OwnerReceiptsState[] = [];
  let denied = 0;
  const resource = createOwnerReceiptsResource({
    userId: "1",
    sessionSignal: session.signal,
    load,
    publish: (state) => states.push(state),
    onAccessDenied: () => denied++,
  });
  return { session, resource, states, denied: () => denied };
}

test("receipt amounts are actual exact roubles, without the AI ×10 markup", () => {
  assert.equal(receiptMoney(10000), "100,00 ₽");
  assert.equal(receiptMoney(1), "0,01 ₽");
  assert.equal(receiptMoney(0), "0,00 ₽");
  assert.match(receiptMoney(1_000_000_000), /10\D000\D000,00 ₽/);
  for (const bad of [-1, 0.5, NaN, Infinity, 1_000_000_001])
    assert.throws(() => receiptMoney(bad), /Некорректная сумма/);
  const view = ownerReceiptPresentation(task());
  assert.equal(view.paid, "100,00 ₽");
  assert.ok(view.statuses.includes("Передача покупателю ещё не подтверждена"));
});

test("a legacy nonnumeric dashboard ID fails only the receipt panel closed, without crashing the application", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerReceiptsPanel, {
      userId: "legacy-compatible-user",
      sessionSignal: new AbortController().signal,
    }),
  );
  assert.ok(html.includes(receiptLoadError));
  assert.equal(html.includes("Загружаем чеки"), false);
  assert.equal(html.includes("lknpd.nalog.ru"), false);
});

test("corrections distinguish old documents, remaining-income receipts and cancellation evidence", () => {
  const refunded = {
    cumulativeRefundedKopeks: 4000,
    remainingIncomeKopeks: 6000,
  };
  const pending = ownerReceiptPresentation(
    task({ ...refunded, correctionStatus: "required" }),
  );
  assert.equal(pending.uncertainDocument, true);
  assert.equal(pending.link?.label, "Открыть ранее сохранённый документ ФНС");
  const corrected = ownerReceiptPresentation(
    task({ ...refunded, correctionStatus: "operator_reported" }),
  );
  assert.equal(corrected.remaining, "60,00 ₽");
  assert.equal(
    corrected.link?.label,
    "Открыть текущий чек на оставшийся доход",
  );
  const canceled = ownerReceiptPresentation(
    task({
      cumulativeRefundedKopeks: 10000,
      remainingIncomeKopeks: 0,
      correctionStatus: "operator_reported",
      activeReceiptId: null,
    }),
  );
  assert.equal(canceled.remaining, "0,00 ₽");
  assert.equal(
    canceled.link?.label,
    "Открыть подтверждение аннулирования или корректировки",
  );
});

test("presentation reuses the strict owner/FNS contract, never arbitrary links or admin fields", () => {
  for (const activeReceiptUrl of [
    "javascript:alert(1)",
    "https://lknpd.nalog.ru.evil.example.test/receipt",
    "https://lknpd.nalog.ru/receipt?secret=synthetic",
    "https://person@lknpd.nalog.ru/receipt",
  ])
    assert.throws(() => ownerReceiptPresentation(task({ activeReceiptUrl })));
  assert.throws(() =>
    ownerReceiptPresentation({
      ...task(),
      buyerEmail: "synthetic@example.test",
    } as OwnerNpdReceiptTask),
  );
});

test("loading and empty results are distinct; refreshing clears previous document data", async () => {
  const f = fixture(async () => ({ tasks: [task()] }));
  await f.resource.refresh();
  assert.deepEqual(
    f.states.map((s) => s.phase),
    ["loading", "ready"],
  );
  assert.equal(f.states[0]?.tasks.length, 0);
  assert.equal(f.states[1]?.tasks[0]?.activeReceiptUrl, documentUrl);
  await f.resource.refresh();
  assert.deepEqual(f.states[2], { phase: "loading", tasks: [] });
  f.resource.dispose();
  const empty = fixture(async () => ({ tasks: [] }));
  await empty.resource.refresh();
  assert.deepEqual(empty.states.at(-1), { phase: "ready", tasks: [] });
  empty.resource.dispose();
});

test("a refresh supersedes and aborts the old request, even when its loader ignores abort", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const signals: AbortSignal[] = [];
  const f = fixture((signal) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : second.promise;
  });
  const a = f.resource.refresh();
  const b = f.resource.refresh();
  assert.equal(signals[0]?.aborted, true);
  second.resolve({ tasks: [] });
  await b;
  first.resolve({ tasks: [task()] });
  await a;
  assert.deepEqual(f.states.at(-1), { phase: "ready", tasks: [] });
  assert.equal(f.states.filter((s) => s.phase === "ready").length, 1);
  f.resource.dispose();
});

test("logout aborts in-flight work, erases data and rejects all late success/error continuations", async () => {
  for (const outcome of ["success", "denied"] as const) {
    const late = deferred<unknown>();
    let captured: AbortSignal | undefined;
    const f = fixture((signal) => {
      captured = signal;
      return late.promise;
    });
    const pending = f.resource.refresh();
    f.session.abort();
    assert.equal(captured?.aborted, true);
    assert.deepEqual(f.states.at(-1), { phase: "closed", tasks: [] });
    const length = f.states.length;
    if (outcome === "success") late.resolve({ tasks: [task()] });
    else late.reject(new ApiError(401, "synthetic-private-error"));
    await pending;
    await f.resource.refresh();
    assert.equal(f.states.length, length);
    assert.equal(f.denied(), 0);
    f.resource.dispose();
  }
});

test("unmount disposal prevents late publications and access-denied callbacks", async () => {
  const late = deferred<unknown>();
  const f = fixture(() => late.promise);
  const pending = f.resource.refresh();
  f.resource.dispose();
  const length = f.states.length;
  late.reject(new ApiError(403, "synthetic-private-error"));
  await pending;
  assert.equal(f.states.length, length);
  assert.equal(f.denied(), 0);
});

test("active 401/403 responses clear documents and notify only the current UI lifetime", async () => {
  for (const code of [401, 403]) {
    const f = fixture(async () => {
      throw new ApiError(code, "synthetic-private-error");
    });
    await f.resource.refresh();
    assert.deepEqual(f.states.at(-1), { phase: "closed", tasks: [] });
    assert.equal(f.denied(), 1);
    await f.resource.refresh();
    assert.equal(f.denied(), 1);
    assert.doesNotMatch(JSON.stringify(f.states), /synthetic-private-error/);
    f.resource.dispose();
  }
});

test("foreign-owner, malformed and admin-bearing responses fail the entire batch without leaking data", async () => {
  for (const value of [
    { tasks: [task(), task({ userId: "2" })] },
    { tasks: [{ ...task(), buyerEmail: "synthetic-private@example.test" }] },
    {
      tasks: [task({ activeReceiptUrl: "https://evil.example.test/private" })],
    },
    { tasks: [task()], events: [{ secret: "synthetic-private" }] },
    null,
  ]) {
    const f = fixture(async () => value);
    await f.resource.refresh();
    assert.deepEqual(f.states.at(-1), { phase: "error", tasks: [] });
    assert.doesNotMatch(
      JSON.stringify(f.states),
      /synthetic-private|receipt-synthetic/,
    );
    f.resource.dispose();
  }
});

test("network errors clear old data, remain generic and allow a deliberate read-only retry", async () => {
  let count = 0;
  const f = fixture(async () => {
    if (++count === 1) throw new Error("synthetic-private-body");
    return { tasks: [] };
  });
  await f.resource.refresh();
  assert.deepEqual(f.states.at(-1), { phase: "error", tasks: [] });
  await f.resource.refresh();
  assert.deepEqual(f.states.at(-1), { phase: "ready", tasks: [] });
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-private/);
  f.resource.dispose();
});

test("an already closed session never starts a read", async () => {
  const session = new AbortController();
  session.abort();
  let called = false;
  const resource = createOwnerReceiptsResource({
    userId: "1",
    sessionSignal: session.signal,
    load: async () => {
      called = true;
    },
    publish: () => assert.fail("Closed session must not publish"),
  });
  await resource.refresh();
  assert.equal(called, false);
  resource.dispose();
});

test("rendered receipts use exact amounts, safe FNS links and honest delivery/date/correction labels", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerReceiptList, { tasks: [task()] }),
  );
  assert.match(html, /100,00 ₽/);
  assert.match(html, /Передача покупателю ещё не подтверждена/);
  assert.match(html, /не дата расчёта/);
  assert.match(html, /href="https:\/\/lknpd\.nalog\.ru\//);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.doesNotMatch(html, /buyerEmail|claimedByUserId|mailto:/);
  const partial = renderToStaticMarkup(
    createElement(OwnerReceiptList, {
      tasks: [
        task({
          cumulativeRefundedKopeks: 4000,
          remainingIncomeKopeks: 6000,
          correctionStatus: "required",
        }),
      ],
    }),
  );
  assert.match(partial, /актуальность нужно уточнить/);
  assert.match(partial, /ранее сохранённый документ ФНС/);
});

test("initial panel has accessible loading/closed states and never claims viewing equals delivery", () => {
  const active = new AbortController();
  const html = renderToStaticMarkup(
    createElement(OwnerReceiptsPanel, {
      userId: "1",
      sessionSignal: active.signal,
    }),
  );
  assert.match(html, /Загружаем чеки/);
  assert.match(html, /не означает фактическую передачу/);
  assert.doesNotMatch(html, /receipt-synthetic/);
  active.abort();
  const closed = renderToStaticMarkup(
    createElement(OwnerReceiptsPanel, {
      userId: "1",
      sessionSignal: active.signal,
    }),
  );
  assert.match(closed, /Сессия недоступна/);
  assert.doesNotMatch(closed, /href=/);
});
