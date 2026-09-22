import type { Dashboard, Quest } from "@citygo/contracts";
import type { SessionTicket } from "@citygo/api-client";

export type OperationKind =
  | "auth"
  | "questionnaire"
  | "consent"
  | "start"
  | "complete"
  | "refresh"
  | "chat"
  | "logout";
export type PendingOperation =
  | { kind: Exclude<OperationKind, "chat"> }
  | { kind: "chat"; phase: "streaming" | "stopping" | "refreshing" };

// The synchronous gate also covers two presses before React has rendered disabled.
// Finishing a stale operation must never unlock the next account's operation.
export function createOperations(
  changed: (state: PendingOperation | null) => void,
) {
  let active: { state: PendingOperation } | null = null;
  return {
    current: () => active?.state ?? null,
    reset() {
      active = null;
      changed(null);
    },
    begin(kind: OperationKind) {
      if (active) return null;
      const entry = {
        state: (kind === "chat"
          ? { kind, phase: "streaming" }
          : { kind }) as PendingOperation,
      };
      active = entry;
      changed(entry.state);
      return {
        refreshing() {
          if (active !== entry || entry.state.kind !== "chat") return;
          entry.state = { kind: "chat", phase: "refreshing" };
          changed(entry.state);
        },
        finish() {
          if (active !== entry) return;
          active = null;
          changed(null);
        },
      };
    },
    stopChat(cancel: () => void) {
      if (!canStopChat(active?.state ?? null)) return false;
      active!.state = { kind: "chat", phase: "stopping" };
      changed(active!.state);
      cancel();
      return true;
    },
  };
}
export type OperationTicket = NonNullable<
  ReturnType<ReturnType<typeof createOperations>["begin"]>
>;
export function canStopChat(state: PendingOperation | null) {
  return state?.kind === "chat" && state.phase === "streaming";
}
export function operationLabel(state: PendingOperation) {
  if (state.kind === "chat")
    return {
      streaming: "Помощник отвечает…",
      stopping: "Останавливаем ответ…",
      refreshing: "Обновляем историю…",
    }[state.phase];
  return {
    auth: "Входим в аккаунт…",
    questionnaire: "Сохраняем анкету…",
    consent: "Сохраняем разрешение AI…",
    start: "Начинаем квест…",
    complete: "Завершаем квест и обновляем план…",
    refresh: "Обновляем план…",
    logout: "Завершаем сессию…",
  }[state.kind];
}

export type CompletionReceipt = {
  questId: string;
  awarded: number;
  quests?: Quest[];
};
export function allQuestsCompleted(quests: readonly Quest[]) {
  return (
    quests.length > 0 && quests.every((quest) => quest.state === "completed")
  );
}
export function completionNotice(receipt: CompletionReceipt) {
  const award =
    receipt.awarded > 0
      ? `+${receipt.awarded} XP — квест завершён.`
      : "Квест уже завершён. Новых XP не начислено (0 XP).";
  const completed = receipt.quests?.find(
    (quest) => quest.id === receipt.questId,
  );
  if (completed?.state !== "completed")
    return `${award} Обновите план, чтобы увидеть актуальный прогресс.`;
  if (allQuestsCompleted(receipt.quests!))
    return `${award} Все квесты текущего плана завершены.`;
  const next = receipt.quests!.find(
    (quest) =>
      quest.id !== receipt.questId &&
      (quest.state === "available" || quest.state === "in_progress"),
  );
  return `${award} ${next ? `Доступный квест: ${next.title}.` : "Следующий квест пока недоступен."}`;
}

// Retain the confirmed server receipt even if the follow-up GET fails. Recovery
// is an explicit plan refresh, never an automatic repeat of the completion POST.
export async function completeQuest(input: {
  questId: string;
  complete: (id: string) => Promise<{ awarded: number }>;
  refresh: (ticket: SessionTicket) => Promise<Dashboard | undefined>;
  ticket: SessionTicket;
  received: (receipt: CompletionReceipt) => void;
}) {
  input.ticket.check();
  const result = await input.complete(input.questId);
  input.ticket.check();
  input.received({ questId: input.questId, awarded: result.awarded });
  await input.refresh(input.ticket);
  input.ticket.check();
}
