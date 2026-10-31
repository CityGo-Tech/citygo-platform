import type { AgentKey, Dashboard } from "@citygo/contracts";
import { agentKeys } from "@citygo/contracts";

export type AssistantHandoffSource = {
  userId: string;
  threadId: string;
  messageId: string;
  assistantKey: AgentKey;
  content: string;
  sessionSignal: AbortSignal;
};
export type AssistantHandoffInput = {
  source: AssistantHandoffSource;
  target: AgentKey;
  text: string;
};

/** Source identity is checked again at the selection commit boundary. */
export function currentAssistantHandoffSource(
  source: AssistantHandoffSource,
  board: Dashboard,
  signal: AbortSignal,
) {
  const thread = board.thread;
  return (
    !signal.aborted &&
    source.sessionSignal === signal &&
    source.userId === board.user.id &&
    source.threadId === thread?.id &&
    source.assistantKey === (thread?.assistantKey ?? thread?.agentKey) &&
    !!thread?.messages.some(
      (message) =>
        message.id === source.messageId &&
        message.status === "complete" &&
        message.content === source.content,
    )
  );
}

export function assistantHandoffTarget(
  source: AssistantHandoffSource,
  target: string,
): target is AgentKey {
  return (
    agentKeys.some((key) => key === target) && target !== source.assistantKey
  );
}

/** The same UTF-16 bound as chatInputSchema/composer; no silent truncation. */
export function assistantHandoffDraft(text: string, existing = "") {
  const reviewed = text.trim();
  if (!reviewed) throw new Error("Выберите текст для другого помощника.");
  const result = (existing ? existing + "\n\n" : "") + reviewed;
  if (result.length > 4000)
    throw new Error(
      "Фрагмент и сохранённый черновик вместе превышают 4000 символов. Сократите фрагмент или сначала проверьте черновик помощника.",
    );
  for (const point of result) {
    const code = point.codePointAt(0)!;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new Error(
        "В тексте есть недопустимые символы. Исправьте фрагмент.",
      );
  }
  return result;
}
