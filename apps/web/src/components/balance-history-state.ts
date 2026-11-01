import { ApiError } from "@citygo/api-client";
import {
  compareBalanceHistoryEntries,
  type BalanceHistoryEntry,
  type BalanceHistoryFilter,
  type BalanceHistoryPage,
  type BalanceHistoryQuery,
} from "@citygo/contracts";
export type BalanceHistoryState = {
  filter: BalanceHistoryFilter;
  entries: BalanceHistoryEntry[];
  nextCursor: string | null;
  busy: boolean;
  loaded: boolean;
  error: string;
};
export const emptyBalanceHistory: BalanceHistoryState = {
  filter: "all",
  entries: [],
  nextCursor: null,
  busy: false,
  loaded: false,
  error: "",
};
export function createBalanceHistoryResource(options: {
  userId: string;
  signal: AbortSignal;
  client: {
    balanceHistory: (input: BalanceHistoryQuery) => Promise<BalanceHistoryPage>;
  };
  publish: (state: BalanceHistoryState) => void;
  onAccessDenied: () => void;
}) {
  let state = { ...emptyBalanceHistory },
    live = true,
    generation = 0;
  const active = () => live && !options.signal.aborted;
  const publish = (patch: Partial<BalanceHistoryState>) => {
    if (active()) {
      state = { ...state, ...patch };
      options.publish(state);
    }
  };
  async function load(more = false) {
    if (!active() || state.busy || (more && !state.nextCursor)) return;
    const epoch = ++generation,
      filter = state.filter,
      cursor = more ? state.nextCursor! : undefined;
    publish({ busy: true, error: "" });
    try {
      const page = await options.client.balanceHistory({
        filter,
        ...(cursor ? { cursor } : {}),
      });
      if (!active() || epoch !== generation) return;
      if (page.userId !== options.userId)
        throw new ApiError(401, "Аккаунт изменился", "invalid_response");
      if (
        page.filter !== filter ||
        (cursor && page.nextCursor === cursor) ||
        (more &&
          page.entries.some((entry) =>
            state.entries.some((old) => old.id === entry.id),
          )) ||
        (more &&
          state.entries.length &&
          page.entries.length &&
          compareBalanceHistoryEntries(
            state.entries.at(-1)!,
            page.entries[0]!,
          ) >= 0)
      )
        throw new ApiError(200, "Некорректная история", "invalid_response");
      publish({
        entries: more ? [...state.entries, ...page.entries] : page.entries,
        nextCursor: page.nextCursor,
        loaded: true,
        busy: false,
      });
    } catch (error) {
      if (!active() || epoch !== generation) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        publish({ entries: [], nextCursor: null, busy: false, error: "" });
        live = false;
        options.onAccessDenied();
        return;
      }
      if (error instanceof ApiError && [400, 409].includes(error.status)) {
        publish({
          entries: [],
          nextCursor: null,
          loaded: false,
          busy: false,
          error: "История обновилась. Обновите список.",
        });
        return;
      }
      publish({
        busy: false,
        error: "Не удалось загрузить историю. Попробуйте ещё раз.",
      });
    }
  }
  const abort = () => {
    live = false;
    generation++;
    state = { ...emptyBalanceHistory };
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return {
    loadMore: () => load(true),
    refresh() {
      generation++;
      publish({ ...emptyBalanceHistory, filter: state.filter });
      return load();
    },
    filter(filter: BalanceHistoryFilter) {
      generation++;
      publish({ ...emptyBalanceHistory, filter });
      return load();
    },
    dispose() {
      abort();
      options.signal.removeEventListener("abort", abort);
    },
  };
}
