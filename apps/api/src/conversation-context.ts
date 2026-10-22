import { DomainError } from "@citygo/db";
import type { ModelMessage } from "@citygo/llm";

type HistoryMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
};

const invalidHistory = () =>
  new DomainError(
    503,
    "Не удалось подготовить историю диалога. Обновите страницу перед повторной отправкой.",
  );

/** Keep stored history intact; only the context of this model call is bounded. */
export function buildConversationContext(input: {
  instructions: string;
  profile: ModelMessage;
  history: readonly HistoryMessage[];
  currentQuestion: string;
  maxInputBytes: number;
}): { instructions: string; messages: ModelMessage[] } {
  if (
    !Number.isSafeInteger(input.maxInputBytes) ||
    input.maxInputBytes <= 0 ||
    input.profile.role !== "user"
  )
    throw invalidHistory();

  // PostgreSQL bigint IDs must not pass through Number (including in sorting).
  // Copy before sorting: neither persisted history nor its UI order is changed.
  if (input.history.some((message) => !/^[1-9]\d*$/.test(message.id)))
    throw invalidHistory();
  const history = [...input.history].sort((left, right) => {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  if (
    history.some(
      (message, index) => index > 0 && message.id === history[index - 1]!.id,
    )
  )
    throw invalidHistory();
  const current = history.at(-1);
  if (
    !current ||
    current.role !== "user" ||
    current.status !== "complete" ||
    current.content !== input.currentQuestion ||
    !input.currentQuestion.trim()
  )
    throw invalidHistory();

  const context = {
    instructions: input.instructions,
    messages: [
      { ...input.profile },
      { role: "user" as const, content: input.currentQuestion },
    ],
  };
  const bytes = (messages: ModelMessage[]) =>
    Buffer.byteLength(
      JSON.stringify({ instructions: input.instructions, messages }),
      "utf8",
    );
  if (bytes(context.messages) > input.maxInputBytes)
    throw new DomainError(
      413,
      "Текущий вопрос вместе с обязательным контекстом слишком длинный для одного запроса ИИ. Сократите вопрос или разделите его на несколько сообщений. История сохранена; запрос не отправлен ИИ, деньги не зарезервированы и не списаны.",
    );

  const rounds: [ModelMessage, ModelMessage][] = [];
  // Exclude the current question by position, not text: an older identical
  // question is still a distinct turn. Never reuse orphaned failed-turn users.
  for (let index = 0; index < history.length - 2; index++) {
    const user = history[index]!;
    const assistant = history[index + 1]!;
    if (
      user.role === "user" &&
      user.status === "complete" &&
      user.content.trim() &&
      assistant.role === "assistant" &&
      assistant.status === "complete" &&
      assistant.content.trim()
    ) {
      rounds.push([
        { role: "user", content: user.content },
        { role: "assistant", content: assistant.content },
      ]);
      index++;
    }
  }

  // Nine full rounds plus the current question stay below the disclosed cap of
  // twenty conversational messages. Keep a recent contiguous suffix of rounds;
  // do not backfill older pairs if a newer pair exceeds the byte budget.
  for (
    let index = rounds.length - 1, count = 0;
    index >= 0 && count < 9;
    index--
  ) {
    const candidate = [
      context.messages[0]!,
      ...rounds[index]!,
      ...context.messages.slice(1),
    ];
    if (bytes(candidate) > input.maxInputBytes) break;
    context.messages = candidate;
    count++;
  }
  return context;
}
