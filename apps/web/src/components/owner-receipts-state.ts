import { ApiError } from "@citygo/api-client";
import {
  creditUserIdSchema,
  ownerNpdReceiptListSchema,
  ownerNpdReceiptTaskSchema,
  type OwnerNpdReceiptTask,
} from "@citygo/contracts";

export type OwnerReceiptsState = {
  phase: "loading" | "ready" | "error" | "closed";
  tasks: readonly OwnerNpdReceiptTask[];
};

export const receiptLoadError =
  "Не удалось загрузить чеки. Обновите список позже. Это не повтор оплаты и не запрос нового чека.";

/** A UI lifetime, not authentication. Even a transport ignoring abort cannot publish late data. */
export function createOwnerReceiptsResource({
  userId,
  sessionSignal,
  load,
  publish,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  load: (signal: AbortSignal) => Promise<unknown>;
  publish: (state: OwnerReceiptsState) => void;
  onAccessDenied?: () => void;
}) {
  if (!creditUserIdSchema.safeParse(userId).success)
    throw new Error("Не удалось определить владельца чеков");
  let closed = sessionSignal.aborted;
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  function close() {
    if (closed || disposed) return;
    closed = true;
    generation++;
    request?.abort();
    sessionSignal.removeEventListener("abort", close);
    publish({ phase: "closed", tasks: [] });
  }
  sessionSignal.addEventListener("abort", close, { once: true });
  return {
    async refresh() {
      if (closed || disposed || sessionSignal.aborted) return;
      request?.abort();
      const current = ++generation;
      const controller = new AbortController();
      request = controller;
      const signal = AbortSignal.any([controller.signal, sessionSignal]);
      const active = () =>
        !closed && !disposed && current === generation && !signal.aborted;
      // Do not retain an earlier document while an access check is pending.
      publish({ phase: "loading", tasks: [] });
      try {
        const raw = await load(signal);
        if (!active()) return;
        const parsed = ownerNpdReceiptListSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.tasks.some((task) => task.userId !== userId)
        )
          throw new Error("Invalid owner receipt response");
        publish({ phase: "ready", tasks: parsed.data.tasks });
      } catch (error) {
        if (!active()) return;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          close();
          // The parent may revoke its current UI lifetime. Never notify it for
          // an old request, or expose the provider/server error text.
          onAccessDenied?.();
          return;
        }
        publish({ phase: "error", tasks: [] });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      sessionSignal.removeEventListener("abort", close);
    },
  };
}

export function receiptMoney(kopeks: number) {
  if (!Number.isSafeInteger(kopeks) || kopeks < 0 || kopeks > 1_000_000_000)
    throw new Error("Некорректная сумма чека");
  const value = BigInt(kopeks);
  return `${new Intl.NumberFormat("ru-RU").format(value / 100n)},${(value % 100n).toString().padStart(2, "0")} ₽`;
}

/** Current owner projection only: the API does not expose historical evidence documents. */
export function ownerReceiptPresentation(input: OwnerNpdReceiptTask) {
  const parsed = ownerNpdReceiptTaskSchema.safeParse(input);
  if (!parsed.success) throw new Error("Некорректные данные чека");
  const task = parsed.data;
  const statuses = [
    task.registrationStatus === "pending"
      ? "Оформление чека ожидается"
      : "Оформление отмечено оператором",
    task.deliveryStatus === "pending"
      ? "Передача покупателю ещё не подтверждена"
      : "Передача отмечена оператором",
  ];
  if (task.correctionStatus === "required")
    statuses.push("После возврата требуется корректировка чека");
  if (task.correctionStatus === "operator_reported")
    statuses.push("Корректировка отмечена оператором");
  if (task.reviewReason)
    statuses.push(
      {
        registration_uncertain: "Оформление требует ручной сверки",
        delivery_uncertain: "Передача требует ручной сверки",
        correction_uncertain: "Корректировка требует ручной сверки",
      }[task.reviewReason],
    );
  const uncertainDocument =
    task.correctionStatus === "required" ||
    task.reviewReason === "correction_uncertain";
  return {
    statuses,
    paid: receiptMoney(task.amountKopeks),
    refunded: receiptMoney(task.cumulativeRefundedKopeks),
    remaining: receiptMoney(task.remainingIncomeKopeks),
    link: task.activeReceiptUrl
      ? {
          href: task.activeReceiptUrl,
          label: uncertainDocument
            ? "Открыть ранее сохранённый документ ФНС"
            : task.activeReceiptId === null
              ? "Открыть подтверждение аннулирования или корректировки"
              : task.correctionStatus === "operator_reported"
                ? "Открыть текущий чек на оставшийся доход"
                : "Открыть чек ФНС",
        }
      : null,
    uncertainDocument,
  };
}
