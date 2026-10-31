import type {
  PersonalPlanHistoryEntry,
  PersonalPlanHistoryPage,
} from "@citygo/contracts";
import { ApiError } from "./transport.js";

export type PlanHistoryState = {
  phase: "loading" | "ready" | "error" | "closed";
  current: PersonalPlanHistoryEntry | null;
  entries: readonly PersonalPlanHistoryEntry[];
  nextBefore: number | null;
  error: string;
};
/** Pages replace each other. The current saved revision stays the comparison anchor. */
export function createPersonalPlanHistoryResource({
  userId,
  itemId,
  signal,
  read,
  publish,
  onAccessDenied,
}: {
  userId: string;
  itemId: string;
  signal: AbortSignal;
  read: (
    before: number | undefined,
    signal: AbortSignal,
  ) => Promise<PersonalPlanHistoryPage>;
  publish: (state: PlanHistoryState) => void;
  onAccessDenied: () => void;
}) {
  let state: PlanHistoryState = {
    phase: "loading",
    current: null,
    entries: [],
    nextBefore: null,
    error: "",
  };
  let disposed = false,
    generation = 0;
  let request: AbortController | undefined;
  const active = () => !disposed && !signal.aborted;
  const clone = (entry: PersonalPlanHistoryEntry) => ({
    ...entry,
    checklist: entry.checklist.map((row) => ({ ...row })),
  });
  const snapshot = () => ({
    ...state,
    current: state.current ? clone(state.current) : null,
    entries: state.entries.map(clone),
  });
  function commit(next: PlanHistoryState) {
    if (active()) {
      state = next;
      publish(snapshot());
    }
  }
  function close(denied = false) {
    request?.abort();
    generation++;
    signal.removeEventListener("abort", onAbort);
    state = {
      phase: "closed",
      current: null,
      entries: [],
      nextBefore: null,
      error: "",
    };
    publish(snapshot());
    disposed = true;
    if (denied) onAccessDenied();
  }
  const onAbort = () => close();
  signal.addEventListener("abort", onAbort, { once: true });
  async function load(before?: number) {
    if (
      !active() ||
      (before !== undefined &&
        (state.phase === "loading" || before !== state.nextBefore))
    )
      return;
    request?.abort();
    request = new AbortController();
    const requestSignal = request.signal,
      ticket = ++generation;
    commit({ ...state, phase: "loading", error: "" });
    const current = () =>
      active() && !requestSignal.aborted && ticket === generation;
    try {
      const page = await read(before, requestSignal);
      if (!current()) return;
      if (page.userId !== userId || page.itemId !== itemId) {
        close(true);
        disposed = true;
        return;
      }
      if (
        (before === undefined &&
          page.entries[0]?.revision !== page.currentRevision) ||
        (before !== undefined &&
          (page.currentRevision !== state.current?.revision ||
            page.entries.some((entry) => entry.revision >= before)))
      )
        throw new Error("History changed");
      commit({
        phase: "ready",
        current: before === undefined ? page.entries[0]! : state.current,
        entries: page.entries,
        nextBefore: page.nextBefore,
        error: "",
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        close(true);
        disposed = true;
        return;
      }
      commit({
        phase: "error",
        current: null,
        entries: [],
        nextBefore: null,
        error:
          error instanceof ApiError && error.status === 404
            ? "История шага недоступна."
            : "Не удалось загрузить историю. Обновите её перед просмотром.",
      });
    }
  }
  return {
    load: () => load(),
    earlier: () =>
      state.nextBefore !== null ? load(state.nextBefore) : Promise.resolve(),
    snapshot,
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      signal.removeEventListener("abort", onAbort);
      state = {
        phase: "closed",
        current: null,
        entries: [],
        nextBefore: null,
        error: "",
      };
    },
  };
}
