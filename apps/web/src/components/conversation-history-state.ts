import { ApiError } from "@citygo/api-client";
import {
  conversationHistoryIdSchema,
  conversationMessagesResponseSchema,
  type Message,
} from "@citygo/contracts";

export type ConversationHistoryState = {
  phase: "ready" | "loading" | "error" | "closed";
  messages: readonly Message[];
  nextCursor: string | null;
  detached: boolean;
  error: string;
  notice: string;
  loadedPages: number;
};
export const historyLoadError =
  "Не удалось загрузить ранние сообщения. Повторите загрузку. Запрос к ИИ не отправлялся.";
const copy = (messages: readonly Message[]) =>
  messages.map((message) => ({ ...message }));
function ascending(messages: readonly Message[]) {
  return messages.every(
    (message, index) =>
      conversationHistoryIdSchema.safeParse(message.id).success &&
      (index === 0 || BigInt(messages[index - 1]!.id) < BigInt(message.id)),
  );
}
function merge(older: readonly Message[], latest: readonly Message[]) {
  const byId = new Map(older.map((message) => [message.id, message]));
  for (const message of latest) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : 1,
  );
}
export function projectConversationHistory(
  state: ConversationHistoryState,
  latest: readonly Message[],
  maxMessages = 1000,
) {
  if (state.detached || state.phase === "closed") return state;
  if (!ascending(state.messages) || !ascending(latest))
    return { ...state, messages: copy(latest) };
  const first = latest[0],
    last = state.messages.at(-1);
  const gap =
    !!first &&
    !!last &&
    latest.length >= 100 &&
    BigInt(first.id) > BigInt(last.id);
  const messages = merge(state.messages, latest);
  if (gap)
    return {
      ...state,
      phase: "ready" as const,
      messages: copy(latest),
      nextCursor: latest[0]!.id,
      detached: false,
      error: "",
      notice:
        "Появились новые сообщения. Показана последняя часть диалога; раннюю историю можно загрузить.",
      loadedPages: 0,
    };
  return messages.length > maxMessages
    ? { ...state, detached: true }
    : { ...state, messages };
}

/** One visible owner/thread lifetime, RAM only. Ten pages are a window, not a
 * limit on how far back the owner can read: an explicit prepend evicts newest
 * pages and detaches the composer until the owner returns to the latest view.
 */
export function createConversationHistoryResource({
  userId,
  threadId,
  initialMessages,
  sessionSignal,
  load,
  publish,
  onAccessDenied,
  maxPages = 10,
}: {
  userId: string;
  threadId: string;
  initialMessages: readonly Message[];
  sessionSignal: AbortSignal;
  load: (before: string, signal: AbortSignal) => Promise<unknown>;
  publish: (state: ConversationHistoryState) => void;
  onAccessDenied?: () => void;
  maxPages?: number;
}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
    throw new Error("Invalid history window");
  const numeric =
    conversationHistoryIdSchema.safeParse(userId).success &&
    conversationHistoryIdSchema.safeParse(threadId).success &&
    ascending(initialMessages);
  let latest = copy(initialMessages);
  let closed = sessionSignal.aborted;
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  const initialCursor = (messages: readonly Message[]) =>
    numeric && messages.length === 100 ? messages[0]!.id : null;
  let state: ConversationHistoryState = {
    phase: closed ? "closed" : "ready",
    messages: closed ? [] : copy(latest),
    nextCursor: closed ? null : initialCursor(latest),
    detached: false,
    error: "",
    notice: "",
    loadedPages: 0,
  };
  const active = () => !closed && !disposed && !sessionSignal.aborted;
  const snapshot = () => ({ ...state, messages: copy(state.messages) });
  function commit(next: ConversationHistoryState) {
    if (!active()) return;
    state = next;
    publish(snapshot());
  }
  function close() {
    if (closed || disposed) return;
    closed = true;
    generation++;
    request?.abort();
    latest = [];
    state = {
      phase: "closed",
      messages: [],
      nextCursor: null,
      detached: false,
      error: "",
      notice: "",
      loadedPages: 0,
    };
    publish(snapshot());
  }
  sessionSignal.addEventListener("abort", close, { once: true });
  return {
    snapshot,
    acceptLatest(messages: readonly Message[]) {
      if (!active()) return;
      if (numeric && !ascending(messages)) return;
      latest = copy(messages);
      if (state.detached) return;
      // Do not discard already loaded older rows on a focus/balance/stream
      // refresh. If the bounded window fills, keep it read-only and offer the
      // explicit latest view rather than joining two ranges across a gap.
      const projected = projectConversationHistory(
        state,
        latest,
        maxPages * 100,
      );
      if (
        projected.messages[0]?.id !== state.messages[0]?.id &&
        projected.notice
      ) {
        generation++;
        request?.abort();
      }
      commit(projected);
    },
    patchFavorite(result: { messageId: string; saved: boolean }) {
      if (
        !active() ||
        !conversationHistoryIdSchema.safeParse(result.messageId).success ||
        typeof result.saved !== "boolean"
      )
        return;
      latest = latest.map((message) =>
        message.id === result.messageId
          ? { ...message, favorite: result.saved }
          : message,
      );
      commit({
        ...state,
        messages: state.messages.map((message) =>
          message.id === result.messageId
            ? { ...message, favorite: result.saved }
            : message,
        ),
      });
    },
    returnToLatest() {
      if (!active()) return;
      generation++;
      request?.abort();
      commit({
        phase: "ready",
        messages: copy(latest),
        nextCursor: initialCursor(latest),
        detached: false,
        error: "",
        notice: "",
        loadedPages: 0,
      });
    },
    async loadOlder() {
      if (
        !active() ||
        !numeric ||
        state.phase === "loading" ||
        !state.nextCursor
      )
        return;
      const before = state.nextCursor;
      if (before !== state.messages[0]?.id) return;
      const current = ++generation;
      const controller = new AbortController();
      request = controller;
      const signal = AbortSignal.any([controller.signal, sessionSignal]);
      const currentRequest = () =>
        active() && !signal.aborted && current === generation;
      commit({ ...state, phase: "loading", error: "" });
      try {
        const raw = await load(before, signal);
        if (!currentRequest()) return;
        const parsed = conversationMessagesResponseSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.userId !== userId ||
          parsed.data.threadId !== threadId ||
          before !== state.messages[0]?.id ||
          !ascending(parsed.data.messages) ||
          parsed.data.messages.some(
            (message) => BigInt(message.id) >= BigInt(before),
          ) ||
          (parsed.data.nextCursor !== null &&
            (parsed.data.messages.length !== 100 ||
              parsed.data.nextCursor !== parsed.data.messages[0]?.id))
        )
          throw new Error("Invalid history page");
        const page = parsed.data;
        const combined = [...copy(page.messages), ...state.messages];
        const max = maxPages * 100;
        const detached = state.detached || combined.length > max;
        commit({
          phase: "ready",
          messages: combined.slice(0, max),
          nextCursor: page.nextCursor,
          detached,
          error: "",
          notice: "",
          loadedPages: state.loadedPages + 1,
        });
      } catch (error) {
        if (!currentRequest()) return;
        if (error instanceof ApiError && error.status === 401) {
          close();
          onAccessDenied?.();
          return;
        }
        commit({ ...state, phase: "error", error: historyLoadError });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      latest = [];
      state = { ...state, messages: [] };
      sessionSignal.removeEventListener("abort", close);
    },
  };
}
