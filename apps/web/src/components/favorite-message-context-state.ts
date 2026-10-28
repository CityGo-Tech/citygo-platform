import { ApiError } from "@citygo/api-client";
import {
  conversationMessagesResponseSchema,
  type Message,
} from "@citygo/contracts";

export type FavoriteContextState = {
  phase: "loading" | "ready" | "error" | "closed";
  messages: readonly Message[];
  nextCursor: string | null;
  trimmed: boolean;
  error: string;
};

/** Read-only, one owner/source lifetime. Nothing is persisted or submitted to AI. */
export function createFavoriteContextResource({
  userId,
  threadId,
  messageId,
  sessionSignal,
  context,
  older,
  publish,
  onAccessDenied,
  unavailableMessage = "Исходное сообщение недоступно. Вернитесь к избранному.",
}: {
  userId: string;
  threadId: string;
  messageId: string;
  sessionSignal: AbortSignal;
  context: (signal: AbortSignal) => Promise<unknown>;
  older: (before: string, signal: AbortSignal) => Promise<unknown>;
  publish: (state: FavoriteContextState) => void;
  onAccessDenied: () => void;
  unavailableMessage?: string;
}) {
  let state: FavoriteContextState = {
    phase: "ready",
    messages: [],
    nextCursor: null,
    trimmed: false,
    error: "",
  };
  let disposed = false;
  let pending = false;
  let request: AbortController | undefined;
  let failedBefore: string | undefined;
  const active = () => !disposed && !sessionSignal.aborted;
  const snapshot = () => ({
    ...state,
    messages: state.messages.map((message) => ({ ...message })),
  });
  function commit(next: FavoriteContextState) {
    if (!active()) return;
    state = next;
    publish(snapshot());
  }
  function close() {
    if (disposed) return;
    request?.abort();
    state = {
      phase: "closed",
      messages: [],
      nextCursor: null,
      trimmed: false,
      error: "",
    };
    publish(snapshot());
  }
  sessionSignal.addEventListener("abort", close, { once: true });
  async function load(before?: string) {
    if (!active() || pending) return;
    pending = true;
    const controller = new AbortController();
    request = controller;
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = () => active() && !signal.aborted;
    commit({ ...state, phase: "loading", error: "" });
    try {
      const raw = await (before ? older(before, signal) : context(signal));
      if (!current()) return;
      const parsed = conversationMessagesResponseSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.userId !== userId ||
        parsed.data.threadId !== threadId ||
        (before
          ? before !== state.messages[0]?.id ||
            parsed.data.messages.some(
              (message) => BigInt(message.id) >= BigInt(before),
            )
          : parsed.data.messages.at(-1)?.id !== messageId)
      )
        throw new Error("Invalid source history page");
      const page = parsed.data;
      const combined = before
        ? [...page.messages, ...state.messages]
        : page.messages;
      failedBefore = undefined;
      commit({
        phase: "ready",
        messages: combined.slice(0, 1000),
        nextCursor: page.nextCursor,
        trimmed: before ? state.trimmed || combined.length > 1000 : false,
        error: "",
      });
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        close();
        disposed = true;
        sessionSignal.removeEventListener("abort", close);
        onAccessDenied();
      } else {
        failedBefore = before;
        commit({
          ...state,
          phase: "error",
          error:
            cause instanceof ApiError && cause.status === 404
              ? unavailableMessage
              : "Не удалось открыть историю. Попробуйте ещё раз.",
        });
      }
    } finally {
      pending = false;
    }
  }
  return {
    snapshot,
    loadSource: () => load(),
    loadOlder: () =>
      state.nextCursor ? load(state.nextCursor) : Promise.resolve(),
    retry: () => load(failedBefore),
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.abort();
      state = { ...state, messages: [], nextCursor: null };
      sessionSignal.removeEventListener("abort", close);
    },
  };
}
