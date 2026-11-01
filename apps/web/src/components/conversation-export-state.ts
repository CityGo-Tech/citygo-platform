import { ApiError } from "@citygo/api-client";
import {
  conversationExportSchema,
  type ConversationExportSnapshot,
} from "@citygo/contracts";
import { agentNames } from "./agent-names";

export function conversationExportText(
  input: ConversationExportSnapshot,
): string {
  const snapshot = conversationExportSchema.parse(input);
  return [
    "CityGo · Диалог",
    "Снимок: " + snapshot.generatedAt,
    snapshot.thread.closed ? "Диалог завершён" : "Сохранённая история диалога",
    "",
    ...(snapshot.messages.length
      ? snapshot.messages.flatMap((message) => [
          (message.role === "user" ? "Вы" : agentNames[message.agentKey]) +
            " · " +
            message.createdAt,
          message.content,
          ...(message.status === "interrupted"
            ? [
                message.failureCode === "AI_CREDIT_EXHAUSTED"
                  ? "Запрос не отправлен ИИ: недостаточно средств."
                  : message.role === "assistant"
                    ? "Ответ прерван."
                    : "Сообщение не завершено.",
              ]
            : []),
          "",
        ])
      : ["В этом диалоге пока нет сохранённых сообщений.", ""]),
  ].join("\n");
}
export function conversationExportFilename(
  snapshot: ConversationExportSnapshot,
) {
  // Validated opaque decimal IDs, never Number/private text/path fragments.
  return (
    "citygo-dialog-" +
    conversationExportSchema.parse(snapshot).thread.id +
    ".txt"
  );
}
export type ConversationExportState = {
  busy: boolean;
  error: string;
  started: boolean;
};
type Scope = { userId: string; threadId: string; signal: AbortSignal };
export function createConversationExportAction(options: {
  scope: Scope;
  current: () => Scope & { enabled: boolean };
  read: (signal: AbortSignal) => Promise<ConversationExportSnapshot>;
  download: (text: string, filename: string) => void;
  publish: (state: ConversationExportState) => void;
  onAccessDenied: () => void;
}) {
  let disposed = false,
    controller: AbortController | null = null;
  const live = () => {
    const current = options.current();
    return (
      !disposed &&
      !options.scope.signal.aborted &&
      current.userId === options.scope.userId &&
      current.threadId === options.scope.threadId &&
      current.signal === options.scope.signal
    );
  };
  const publish = (state: ConversationExportState) => {
    if (live()) options.publish(state);
  };
  const cancel = () => {
    controller?.abort();
    controller = null;
    publish({ busy: false, error: "", started: false });
  };
  options.scope.signal.addEventListener("abort", cancel);
  return {
    async run() {
      if (!live() || !options.current().enabled || controller) return;
      const request = new AbortController();
      controller = request;
      publish({ busy: true, error: "", started: false });
      let error = "",
        started = false;
      try {
        const snapshot = conversationExportSchema.parse(
          await options.read(request.signal),
        );
        if (
          !live() ||
          request.signal.aborted ||
          controller !== request ||
          !options.current().enabled
        )
          return;
        if (
          snapshot.userId !== options.scope.userId ||
          snapshot.thread.id !== options.scope.threadId
        ) {
          disposed = true;
          options.onAccessDenied();
          return;
        }
        const text = conversationExportText(snapshot),
          filename = conversationExportFilename(snapshot);
        if (
          live() &&
          !request.signal.aborted &&
          controller === request &&
          options.current().enabled
        ) {
          options.download(text, filename);
          started = true;
        }
      } catch (failure) {
        if (!live() || request.signal.aborted || controller !== request) return;
        if (
          failure instanceof ApiError &&
          [401, 403].includes(failure.status)
        ) {
          disposed = true;
          options.onAccessDenied();
        } else if (failure instanceof ApiError && failure.status === 413)
          error =
            "Диалог слишком большой для одного файла. Можно скачать отдельные сообщения.";
        else if (failure instanceof ApiError && failure.status === 404)
          error = "Диалог недоступен. Обновите список разговоров.";
        else error = "Не удалось скачать весь диалог. Попробуйте ещё раз.";
      } finally {
        if (controller === request) {
          controller = null;
          publish({ busy: false, error, started });
        }
      }
    },
    cancel,
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
      options.scope.signal.removeEventListener("abort", cancel);
    },
  };
}
