import { ApiError } from "@citygo/api-client";
import {
  favoriteMessagesPageSchema,
  favoriteMessageFiltersSchema,
  personalPlanQuerySchema,
  type FavoriteMessageFilters,
  type PersonalPlanStatus,
  personalPlanPageSchema,
  personalPlanSummarySchema,
  type FavoriteMessage,
  type PersonalPlanItem,
  type PersonalPlanSummary,
} from "@citygo/contracts";

export type ResultsPlanFilters = {
  search?: string;
  status?: PersonalPlanStatus;
};
const planFiltersSchema = personalPlanQuerySchema.omit({ before: true });

export type ResultsCategory = "plan" | "favorites";
type ResultsPage<T> = {
  phase: "idle" | "loading" | "ready" | "error";
  items: readonly T[];
  nextBefore: string | null;
  error: string;
};
export type ResultsState = {
  category: ResultsCategory;
  closed: boolean;
  planFilters: ResultsPlanFilters;
  favoriteFilters: FavoriteMessageFilters;
  filterError: string;
  plan: ResultsPage<PersonalPlanItem>;
  favorites: ResultsPage<FavoriteMessage>;
  summary: PersonalPlanSummary | null;
};
const emptyPage = <T>(): ResultsPage<T> => ({
  phase: "idle",
  items: [],
  nextBefore: null,
  error: "",
});

/** One owner, two existing read APIs. Switching category replaces pending reads. */
export function createResultsResource({
  userId,
  sessionSignal,
  client,
  publish,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  client: {
    plan: (
      before: string | undefined,
      signal: AbortSignal,
      filters: ResultsPlanFilters,
    ) => Promise<unknown>;
    summary: (signal: AbortSignal) => Promise<unknown>;
    favorites: (
      before: string | undefined,
      signal: AbortSignal,
      filters: FavoriteMessageFilters,
    ) => Promise<unknown>;
  };
  publish: (state: ResultsState) => void;
  onAccessDenied: () => void;
}) {
  let state: ResultsState = {
    category: "plan",
    closed: false,
    planFilters: {},
    favoriteFilters: {},
    filterError: "",
    plan: emptyPage(),
    favorites: emptyPage(),
    summary: null,
  };
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  const active = () => !disposed && !state.closed && !sessionSignal.aborted;
  const snapshot = (): ResultsState => ({
    ...state,
    planFilters: { ...state.planFilters },
    favoriteFilters: { ...state.favoriteFilters },
    plan: {
      ...state.plan,
      items: state.plan.items.map((item) => ({
        ...item,
        source: item.source ? { ...item.source } : null,
      })),
    },
    favorites: {
      ...state.favorites,
      items: state.favorites.items.map((item) => ({ ...item })),
    },
    summary: state.summary ? { ...state.summary } : null,
  });
  function commit(next: ResultsState) {
    if (!active()) return;
    state = next;
    publish(snapshot());
  }
  function close(denied = false) {
    if (disposed || state.closed) return;
    request?.abort();
    generation++;
    state = {
      ...state,
      closed: true,
      plan: emptyPage(),
      favorites: emptyPage(),
      summary: null,
      planFilters: {},
      favoriteFilters: {},
      filterError: "",
    };
    publish(snapshot());
    if (denied) onAccessDenied();
  }
  const onAbort = () => close();
  sessionSignal.addEventListener("abort", onAbort, { once: true });
  function owner(value: { userId: string }) {
    if (value.userId === userId) return true;
    close(true);
    return false;
  }
  function validatePage(
    items: readonly { id: string }[],
    nextBefore: string | null,
    before?: string,
  ) {
    if (
      items.some(
        (item, index) =>
          (before && BigInt(item.id) >= BigInt(before)) ||
          (index > 0 && BigInt(items[index - 1]!.id) <= BigInt(item.id)) ||
          (before &&
            state[state.category].items.some((old) => old.id === item.id)),
      ) ||
      (nextBefore !== null &&
        ((state.category === "plan"
          ? items.length !== 20
          : items.length === 0) ||
          nextBefore !== items.at(-1)?.id))
    )
      throw new Error("Invalid results page");
  }
  async function read(before?: string) {
    if (!active()) return;
    const category = state.category;
    const page = state[category];
    if (page.phase === "loading" || (before && before !== page.nextBefore))
      return;
    request?.abort();
    request = new AbortController();
    const signal = AbortSignal.any([request.signal, sessionSignal]);
    const ticket = ++generation;
    const current = () => active() && !signal.aborted && ticket === generation;
    commit({ ...state, [category]: { ...page, phase: "loading", error: "" } });
    try {
      if (category === "plan") {
        const [raw, rawSummary] = await Promise.all([
          client.plan(before, signal, { ...state.planFilters }),
          client.summary(signal),
        ]);
        if (!current()) return;
        const result = personalPlanPageSchema.parse(raw);
        const summary = personalPlanSummarySchema.parse(rawSummary);
        if (!owner(result) || !owner(summary)) return;
        if (
          state.planFilters.status &&
          result.items.some((item) => item.status !== state.planFilters.status)
        )
          throw new Error("Invalid filtered page");
        validatePage(result.items, result.nextBefore, before);
        commit({
          ...state,
          summary,
          plan: {
            phase: "ready",
            items: before
              ? [...state.plan.items, ...result.items]
              : result.items,
            nextBefore: result.nextBefore,
            error: "",
          },
        });
      } else {
        const raw = await client.favorites(before, signal, {
          ...state.favoriteFilters,
        });
        if (!current()) return;
        const result = favoriteMessagesPageSchema.parse(raw);
        if (!owner(result)) return;
        if (
          result.messages.some(
            (item) =>
              (state.favoriteFilters.role &&
                item.role !== state.favoriteFilters.role) ||
              (state.favoriteFilters.assistantKey &&
                item.agentKey !== state.favoriteFilters.assistantKey),
          )
        )
          throw new Error("Invalid filtered page");
        validatePage(result.messages, result.nextBefore, before);
        commit({
          ...state,
          favorites: {
            phase: "ready",
            items: before
              ? [...state.favorites.items, ...result.messages]
              : result.messages,
            nextBefore: result.nextBefore,
            error: "",
          },
        });
      }
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status))
        close(true);
      else
        commit({
          ...state,
          [category]: {
            ...state[category],
            phase: "error",
            error: "Не удалось загрузить результаты. Попробуйте ещё раз.",
          },
        });
    }
  }
  async function applyFilters(category: ResultsCategory, raw: unknown) {
    if (!active() || category !== state.category) return;
    const parsed =
      category === "plan"
        ? planFiltersSchema.safeParse(raw)
        : favoriteMessageFiltersSchema.safeParse(raw);
    if (!parsed.success) {
      commit({
        ...state,
        filterError: "Проверьте фильтры. Поисковый запрос — до 160 символов.",
      });
      return;
    }
    const key = category === "plan" ? "planFilters" : "favoriteFilters";
    // Canonical schema output keeps category caches and cursors bound to one query.
    if (JSON.stringify(state[key]) === JSON.stringify(parsed.data)) {
      commit({ ...state, filterError: "" });
      return;
    }
    request?.abort();
    generation++;
    commit({
      ...state,
      [key]: parsed.data,
      [category]: emptyPage(),
      filterError: "",
    });
    await read();
  }
  return {
    snapshot,
    filterPlan: (filters: ResultsPlanFilters) => applyFilters("plan", filters),
    filterFavorites: (filters: FavoriteMessageFilters) =>
      applyFilters("favorites", filters),
    load: () => read(),
    loadMore: () =>
      state[state.category].nextBefore
        ? read(state[state.category].nextBefore!)
        : Promise.resolve(),
    select(category: ResultsCategory) {
      if (!active() || category === state.category) return Promise.resolve();
      request?.abort();
      generation++;
      const previous = state.category;
      commit({
        ...state,
        category,
        filterError: "",
        [previous]: {
          ...state[previous],
          phase:
            state[previous].phase === "loading"
              ? state[previous].items.length
                ? "ready"
                : "idle"
              : state[previous].phase,
        },
      });
      return state[category].phase === "ready" ? Promise.resolve() : read();
    },
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      state = {
        ...state,
        plan: emptyPage(),
        favorites: emptyPage(),
        summary: null,
        planFilters: {},
        favoriteFilters: {},
        filterError: "",
      };
      sessionSignal.removeEventListener("abort", onAbort);
    },
  };
}

/** Bound before any formatting: a saved message may contain up to 1 MiB. */
export function resultPreview(text: string, limit = 420) {
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}
export function resultMessageTitle(text: string) {
  const line = text
    .slice(0, 180)
    .split(/\r?\n/)
    .find((value) => value.trim())
    ?.trim();
  return line ? resultPreview(line, 80) : "Сохранённое сообщение";
}
