import type {
  PersonalPlanHistoryEntry,
  PersonalPlanHistoryPage,
  RestorePersonalPlanRevision,
  PersonalPlanRestoreResult,
} from "@citygo/contracts";
import { ApiError } from "./transport.js";

export type PlanHistoryState = {
  phase: "loading" | "restoring" | "ready" | "error" | "closed";
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
  restore,
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
  restore?: (
    input: RestorePersonalPlanRevision,
    signal: AbortSignal,
  ) => Promise<PersonalPlanRestoreResult>;
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
      state.phase === "restoring" ||
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
  async function restoreRevision(revision: number, expectedRevision: number) {
    if (
      !active() ||
      !restore ||
      state.phase !== "ready" ||
      state.current?.revision !== expectedRevision
    )
      return false;
    const selected = state.entries.find(
      (entry) => entry.revision === revision && revision < expectedRevision,
    );
    if (!selected) return false;
    const frozen = clone(selected);
    request?.abort();
    request = new AbortController();
    const requestSignal = request.signal,
      ticket = ++generation;
    const current = () =>
      active() && !requestSignal.aborted && generation === ticket;
    commit({ ...state, phase: "restoring", error: "" });
    try {
      const result = await restore(
        { revision, expectedRevision },
        requestSignal,
      );
      if (!current()) return false;
      if (result.userId !== userId || result.itemId !== itemId) {
        close(true);
        return false;
      }
      if (
        result.restoredRevision !== revision ||
        result.entry.revision !== expectedRevision + 1 ||
        result.entry.initialSnapshot ||
        result.entry.title !== frozen.title ||
        result.entry.details !== frozen.details ||
        result.entry.status !== frozen.status ||
        JSON.stringify(result.entry.checklist) !==
          JSON.stringify(frozen.checklist)
      )
        throw new Error("Invalid restoration receipt");
      commit({
        ...state,
        phase: "ready",
        current: clone(result.entry),
        entries: [clone(result.entry)],
        nextBefore: null,
        error: "",
      });
      await load();
      return true;
    } catch (error) {
      if (!current()) return false;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        close(true);
        return false;
      }
      commit({
        phase: "error",
        current: null,
        entries: [],
        nextBefore: null,
        error:
          error instanceof ApiError && error.status === 409
            ? "Шаг изменился. Обновите историю и выберите версию заново."
            : "Не удалось подтвердить восстановление. Шаг уже мог измениться. Обновите историю перед новой попыткой.",
      });
      return false;
    }
  }
  return {
    restore: restoreRevision,
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
