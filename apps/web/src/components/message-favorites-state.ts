import { ApiError } from "@citygo/api-client";
import {
  favoriteMessageFiltersSchema,
  favoriteMessagesPageSchema,
  type FavoriteMessage,
  type FavoriteMessageFilters,
  type FavoriteMessagesPage,
} from "@citygo/contracts";

export type FavoriteMessagesState = {
  phase: "loading" | "ready" | "error" | "closed";
  filters: FavoriteMessageFilters;
  messages: readonly FavoriteMessage[];
  nextBefore: string | null;
  mutating: boolean;
  error: string;
};
/** One owner, one filtered keyset. Byte-capped pages need not contain 20 rows. */
export function createFavoriteMessagesResource({
  userId,
  sessionSignal,
  client,
  publish,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  client: {
    page: (
      before: string | undefined,
      filters: FavoriteMessageFilters,
      signal: AbortSignal,
    ) => Promise<FavoriteMessagesPage>;
    remove: (id: string, signal: AbortSignal) => Promise<unknown>;
  };
  publish: (state: FavoriteMessagesState) => void;
  onAccessDenied: () => void;
}) {
  let state: FavoriteMessagesState = {
    phase: "loading",
    filters: {},
    messages: [],
    nextBefore: null,
    mutating: false,
    error: "",
  };
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  const active = () =>
    !disposed && !sessionSignal.aborted && state.phase !== "closed";
  const snapshot = () => ({
    ...state,
    filters: { ...state.filters },
    messages: state.messages.map((message) => ({ ...message })),
  });
  const commit = (next: FavoriteMessagesState) => {
    if (active()) {
      state = next;
      publish(snapshot());
    }
  };
  function close(denied = false) {
    if (disposed || state.phase === "closed") return;
    generation++;
    request?.abort();
    state = {
      ...state,
      phase: "closed",
      messages: [],
      nextBefore: null,
      mutating: false,
      error: "",
    };
    publish(snapshot());
    if (denied) onAccessDenied();
  }
  const onAbort = () => close();
  sessionSignal.addEventListener("abort", onAbort, { once: true });
  function begin() {
    request?.abort();
    request = new AbortController();
    const signal = request.signal;
    const ticket = ++generation;
    return {
      signal,
      current: () => active() && !signal.aborted && ticket === generation,
    };
  }
  function failure(cause: unknown) {
    if (cause instanceof ApiError && [401, 403].includes(cause.status))
      return close(true);
    commit({
      ...state,
      phase: "error",
      mutating: false,
      error: "Не удалось обновить избранное. Повторите действие позже.",
    });
  }
  async function load(before?: string) {
    if (
      !active() ||
      state.mutating ||
      (before && (state.phase === "loading" || before !== state.nextBefore))
    )
      return;
    const { signal, current } = begin();
    const filters = { ...state.filters };
    commit({ ...state, phase: "loading", error: "" });
    try {
      const page = favoriteMessagesPageSchema.parse(
        await client.page(before, filters, signal),
      );
      if (!current()) return;
      if (page.userId !== userId) return close(true);
      if (
        page.messages.some(
          (item, index) =>
            item.id !== item.id.trim() ||
            (index > 0 &&
              BigInt(page.messages[index - 1]!.id) <= BigInt(item.id)) ||
            (before && BigInt(item.id) >= BigInt(before)) ||
            (filters.assistantKey && item.agentKey !== filters.assistantKey) ||
            (filters.role && item.role !== filters.role) ||
            (before && state.messages.some((old) => old.id === item.id)),
        ) ||
        (page.nextBefore !== null &&
          (page.messages.length === 0 ||
            page.nextBefore !== page.messages.at(-1)?.id))
      )
        throw new Error("Invalid favorite page");
      commit({
        ...state,
        phase: "ready",
        messages: before
          ? [...state.messages, ...page.messages]
          : page.messages,
        nextBefore: page.nextBefore,
        error: "",
      });
    } catch (cause) {
      if (current()) failure(cause);
    }
  }
  return {
    snapshot,
    load,
    async filter(filters: FavoriteMessageFilters) {
      if (!active() || state.mutating) return;
      const parsed = favoriteMessageFiltersSchema.safeParse(filters);
      if (!parsed.success) {
        commit({
          ...state,
          error: "Введите текст поиска до 160 символов без служебных символов.",
        });
        return;
      }
      request?.abort();
      generation++;
      commit({
        ...state,
        filters: parsed.data,
        messages: [],
        nextBefore: null,
      });
      await load();
    },
    async remove(id: string) {
      if (
        !active() ||
        state.mutating ||
        state.phase === "loading" ||
        !state.messages.some((item) => item.id === id)
      )
        return;
      const { signal, current } = begin();
      commit({ ...state, mutating: true, error: "" });
      try {
        await client.remove(id, signal);
        if (current())
          commit({
            ...state,
            mutating: false,
            messages: state.messages.filter((item) => item.id !== id),
          });
      } catch (cause) {
        if (current()) failure(cause);
      }
    },
    dispose() {
      close();
      disposed = true;
      sessionSignal.removeEventListener("abort", onAbort);
    },
  };
}
