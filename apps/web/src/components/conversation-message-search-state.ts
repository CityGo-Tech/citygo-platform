import { ApiError } from "@citygo/api-client";
import {
  conversationMessageSearchQuerySchema,
  conversationMessageSearchPageSchema,
  type ConversationMessageSearchMatch,
} from "@citygo/contracts";
export type MessageSearchState = {
  phase: "idle" | "loading" | "ready" | "error" | "closed";
  search: string;
  matches: readonly ConversationMessageSearchMatch[];
  nextCursor: string | null;
  trimmed: boolean;
  error: string;
};
/** One modal owner/thread/session lifetime; RAM only, with bounded visible results. */
export function createMessageSearchResource(options: {
  userId: string;
  threadId: string;
  sessionSignal: AbortSignal;
  load: (
    search: string,
    before: string | undefined,
    signal: AbortSignal,
  ) => Promise<unknown>;
  publish: (state: MessageSearchState) => void;
  onAccessDenied: () => void;
}) {
  let state: MessageSearchState = {
    phase: "idle",
    search: "",
    matches: [],
    nextCursor: null,
    trimmed: false,
    error: "",
  };
  let disposed = false,
    closed = false,
    generation = 0;
  let request: AbortController | undefined;
  const active = () => !disposed && !closed && !options.sessionSignal.aborted;
  const snapshot = () => ({
    ...state,
    matches: state.matches.map((m) => ({ ...m })),
  });
  const commit = (next: MessageSearchState) => {
    if (active()) {
      state = next;
      options.publish(snapshot());
    }
  };
  const close = () => {
    if (disposed || closed) return;
    closed = true;
    generation++;
    request?.abort();
    state = {
      phase: "closed",
      search: "",
      matches: [],
      nextCursor: null,
      trimmed: false,
      error: "",
    };
    options.publish(snapshot());
  };
  options.sessionSignal.addEventListener("abort", close, { once: true });
  async function run(search: string, before?: string) {
    if (!active()) return;
    const parsed = conversationMessageSearchQuerySchema.safeParse({
      search,
      ...(before ? { before } : {}),
    });
    if (!parsed.success) {
      generation++;
      request?.abort();
      commit({
        ...state,
        phase: "error",
        matches: [],
        nextCursor: null,
        error: "Введите от 1 до 160 символов для поиска.",
      });
      return;
    }
    const current = ++generation;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const signal = AbortSignal.any([controller.signal, options.sessionSignal]);
    const live = () => active() && !signal.aborted && generation === current;
    commit({
      phase: "loading",
      search: parsed.data.search,
      matches: before ? state.matches : [],
      nextCursor: before ? state.nextCursor : null,
      trimmed: before ? state.trimmed : false,
      error: "",
    });
    try {
      const raw = await options.load(parsed.data.search, before, signal);
      if (!live()) return;
      const result = conversationMessageSearchPageSchema.safeParse(raw);
      if (
        result.success &&
        (result.data.userId !== options.userId ||
          result.data.threadId !== options.threadId)
      ) {
        close();
        options.onAccessDenied();
        return;
      }
      if (
        !result.success ||
        result.data.search !== parsed.data.search ||
        (before !== undefined &&
          (before !== state.matches.at(-1)?.messageId ||
            result.data.matches.some(
              (m) => BigInt(m.messageId) >= BigInt(before),
            )))
      )
        throw new Error("Invalid search response");
      const combined = before
        ? [...state.matches, ...result.data.matches]
        : result.data.matches;
      commit({
        phase: "ready",
        search: parsed.data.search,
        matches: combined.slice(-200),
        nextCursor: result.data.nextCursor,
        trimmed: state.trimmed || combined.length > 200,
        error: "",
      });
    } catch (error) {
      if (!live()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        close();
        options.onAccessDenied();
        return;
      }
      commit({
        ...state,
        phase: "error",
        error: "Не удалось выполнить поиск. Попробуйте ещё раз.",
      });
    }
  }
  return {
    snapshot,
    search: (query: string) => run(query),
    more: () =>
      active() && state.phase !== "loading" && state.nextCursor
        ? run(state.search, state.nextCursor)
        : Promise.resolve(),
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      state = { ...state, matches: [], search: "", nextCursor: null };
      options.sessionSignal.removeEventListener("abort", close);
    },
  };
}
