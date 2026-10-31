import { ApiError } from "./transport.js";
import { personalPlanSearchSchema } from "@citygo/contracts";
import type {
  PersonalPlanItem,
  PersonalPlanItemResult,
  PersonalPlanPage,
  PersonalPlanRemoveResult,
  PersonalPlanStatus,
  PersonalPlanSummary,
  UpdatePersonalPlanItem,
} from "@citygo/contracts";

export type PersonalPlanFilter = "all" | PersonalPlanStatus;
export type PersonalPlanState = {
  phase: "loading" | "ready" | "error" | "closed";
  filter: PersonalPlanFilter;
  search: string;
  items: readonly PersonalPlanItem[];
  nextBefore: string | null;
  summary: PersonalPlanSummary | null;
  mutating: boolean;
  needsRefresh: boolean;
  error: string;
};
type Client = {
  page: (
    before: string | undefined,
    status: PersonalPlanStatus | undefined,
    signal: AbortSignal,
    search?: string,
  ) => Promise<PersonalPlanPage>;
  summary: (signal: AbortSignal) => Promise<PersonalPlanSummary>;
  update: (
    item: PersonalPlanItem,
    value: UpdatePersonalPlanItem,
    signal: AbortSignal,
  ) => Promise<PersonalPlanItemResult>;
  remove: (
    item: PersonalPlanItem,
    signal: AbortSignal,
  ) => Promise<PersonalPlanRemoveResult>;
};

/** One owner's explicit plan. Filters replace the lifetime of pending reads. */
export function createPersonalPlanResource({
  userId,
  sessionSignal,
  client,
  publish,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  client: Client;
  publish: (state: PersonalPlanState) => void;
  onAccessDenied: () => void;
}) {
  let state: PersonalPlanState = {
    phase: "loading",
    filter: "all",
    search: "",
    items: [],
    nextBefore: null,
    summary: null,
    mutating: false,
    needsRefresh: false,
    error: "",
  };
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  let mutation = false;
  const active = () => !disposed && !sessionSignal.aborted;
  const snapshot = () => ({
    ...state,
    summary: state.summary ? { ...state.summary } : null,
    items: state.items.map((item) => ({
      ...item,
      source: item.source ? { ...item.source } : null,
    })),
  });
  function commit(next: PersonalPlanState) {
    if (!active()) return;
    state = next;
    publish(snapshot());
  }
  function close(denied = false) {
    request?.abort();
    generation++;
    state = {
      ...state,
      phase: "closed",
      search: "",
      items: [],
      nextBefore: null,
      summary: null,
      mutating: false,
      error: "",
    };
    publish(snapshot());
    if (denied) onAccessDenied();
  }
  const onAbort = () => close();
  sessionSignal.addEventListener("abort", onAbort, { once: true });
  function owner(value: { userId: string }) {
    if (value.userId === userId) return true;
    close(true);
    disposed = true;
    sessionSignal.removeEventListener("abort", onAbort);
    return false;
  }
  function failure(cause: unknown, changed: boolean) {
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      close(true);
      disposed = true;
      sessionSignal.removeEventListener("abort", onAbort);
      return;
    }
    commit({
      ...state,
      phase: "error",
      summary: changed ? null : state.summary,
      mutating: false,
      needsRefresh: true,
      error:
        cause instanceof ApiError && cause.status === 409
          ? "Шаг уже изменён. Обновите план и проверьте актуальную версию перед следующим действием."
          : changed
            ? "Не удалось подтвердить изменение. Оно уже могло сохраниться. Обновите план перед повторным действием."
            : "Не удалось загрузить план. Попробуйте обновить список.",
    });
  }
  function begin() {
    request?.abort();
    request = new AbortController();
    // Session abort already calls close(), which aborts this controller.
    // Keep per-request cancellation portable to native runtimes.
    const signal = request.signal;
    const ticket = ++generation;
    return {
      signal,
      current: () => active() && !signal.aborted && ticket === generation,
    };
  }
  async function read(before?: string) {
    if (
      !active() ||
      mutation ||
      (before && (state.phase === "loading" || before !== state.nextBefore))
    )
      return;
    const { signal, current } = begin();
    const filter = state.filter;
    commit({ ...state, phase: "loading", error: "" });
    try {
      const [page, summary] = await Promise.all([
        client.page(
          before,
          filter === "all" ? undefined : filter,
          signal,
          state.search || undefined,
        ),
        client.summary(signal),
      ]);
      if (!current() || !owner(page) || !owner(summary)) return;
      if (
        page.items.some(
          (item) =>
            (filter !== "all" && item.status !== filter) ||
            (before && BigInt(item.id) >= BigInt(before)),
        ) ||
        (before &&
          page.items.some((item) =>
            state.items.some((old) => old.id === item.id),
          ))
      )
        throw new Error("Invalid plan page");
      commit({
        ...state,
        phase: "ready",
        items: before ? [...state.items, ...page.items] : page.items,
        nextBefore: page.nextBefore,
        summary,
        needsRefresh: false,
        error: "",
      });
    } catch (cause) {
      if (current()) failure(cause, false);
    }
  }
  async function change(
    item: PersonalPlanItem,
    value?: UpdatePersonalPlanItem,
  ) {
    if (
      !active() ||
      mutation ||
      state.phase === "loading" ||
      state.needsRefresh
    )
      return false;
    mutation = true;
    const { signal, current } = begin();
    const filter = state.filter;
    commit({ ...state, mutating: true, error: "" });
    try {
      const receipt = value
        ? await client.update(item, value, signal)
        : await client.remove(item, signal);
      if (!current() || !owner(receipt)) return false;
      if (
        "item" in receipt &&
        (receipt.item.source?.messageId !== item.source?.messageId ||
          receipt.item.source?.threadId !== item.source?.threadId ||
          receipt.item.source?.role !== item.source?.role)
      )
        throw new Error("Plan source changed");
      const [page, summary] = await Promise.all([
        client.page(
          undefined,
          filter === "all" ? undefined : filter,
          signal,
          state.search || undefined,
        ),
        client.summary(signal),
      ]);
      if (!current() || !owner(page) || !owner(summary)) return false;
      if (
        filter !== "all" &&
        page.items.some((entry) => entry.status !== filter)
      )
        throw new Error("Plan filter changed");
      commit({
        ...state,
        phase: "ready",
        items: page.items,
        nextBefore: page.nextBefore,
        summary,
        mutating: false,
        needsRefresh: false,
        error: "",
      });
      return true;
    } catch (cause) {
      if (current()) failure(cause, true);
      return false;
    } finally {
      mutation = false;
    }
  }
  return {
    snapshot,
    load: () => read(),
    loadMore: () =>
      state.nextBefore ? read(state.nextBefore) : Promise.resolve(),
    select(filter: PersonalPlanFilter, rawSearch = state.search) {
      if (!active() || mutation) return Promise.resolve();
      const parsed = rawSearch.trim()
        ? personalPlanSearchSchema.safeParse(rawSearch)
        : null;
      if (parsed && !parsed.success) {
        commit({
          ...state,
          phase: "error",
          error: "Поиск: до 160 символов, без управляющих знаков.",
        });
        return Promise.resolve();
      }
      const search = parsed?.data ?? "";
      if (filter === state.filter && search === state.search)
        return Promise.resolve();
      request?.abort();
      commit({
        ...state,
        filter,
        search,
        items: [],
        nextBefore: null,
        phase: "loading",
        needsRefresh: false,
        error: "",
      });
      return read();
    },
    update: (item: PersonalPlanItem, value: UpdatePersonalPlanItem) =>
      change(item, value),
    remove: (item: PersonalPlanItem) => change(item),
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      sessionSignal.removeEventListener("abort", onAbort);
    },
  };
}
