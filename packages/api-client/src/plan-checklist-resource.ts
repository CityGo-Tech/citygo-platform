import {
  planChecklistSchema,
  savePlanChecklistSchema,
  type PlanChecklist,
  type PlanChecklistEntry,
} from "@citygo/contracts";
import { ApiError } from "./transport.js";
export type PlanChecklistState = {
  value: PlanChecklist | null;
  busy: boolean;
  error: string;
  needsRefresh: boolean;
  closed: boolean;
};
/** One authorized step and one session lifetime; uncertain writes require a read. */
export function createPlanChecklistResource(options: {
  userId: string;
  itemId: string;
  sessionSignal: AbortSignal;
  client: {
    get: (signal: AbortSignal) => Promise<PlanChecklist>;
    save: (
      revision: number,
      entries: PlanChecklistEntry[],
      signal: AbortSignal,
    ) => Promise<PlanChecklist>;
  };
  publish: (state: PlanChecklistState) => void;
  onAccessDenied: () => void;
  onSaved: () => void;
}) {
  let state: PlanChecklistState = {
    value: null,
    busy: false,
    error: "",
    needsRefresh: false,
    closed: false,
  };
  let disposed = false,
    generation = 0,
    request: AbortController | undefined;
  const active = () => !disposed && !options.sessionSignal.aborted;
  const snapshot = () => ({
    ...state,
    value: state.value
      ? {
          ...state.value,
          entries: state.value.entries.map((entry) => ({ ...entry })),
        }
      : null,
  });
  const emit = (next: PlanChecklistState) => {
    if (active()) {
      state = next;
      options.publish(snapshot());
    }
  };
  function close(denied = false) {
    request?.abort();
    generation++;
    state = {
      value: null,
      busy: false,
      error: "",
      needsRefresh: false,
      closed: true,
    };
    options.publish(snapshot());
    if (denied) options.onAccessDenied();
  }
  const abort = () => close();
  options.sessionSignal.addEventListener("abort", abort, { once: true });
  function validate(raw: PlanChecklist) {
    const value = planChecklistSchema.parse(raw);
    if (value.userId !== options.userId || value.itemId !== options.itemId) {
      close(true);
      disposed = true;
      throw new Error("Checklist owner changed");
    }
    return value;
  }
  async function work(entries?: PlanChecklistEntry[]) {
    if (
      !active() ||
      state.closed ||
      state.busy ||
      (entries && (!state.value || state.needsRefresh))
    )
      return false;
    const previous = state.value,
      write = entries !== undefined;
    const parsed = write
      ? savePlanChecklistSchema.safeParse({
          expectedRevision: previous!.revision,
          entries,
        })
      : null;
    if (parsed && !parsed.success) {
      emit({ ...state, error: "Проверьте название и подробности пункта." });
      return false;
    }
    const payload = parsed?.success ? parsed.data : null;
    request?.abort();
    request = new AbortController();
    const signal = request.signal,
      ticket = ++generation;
    const current = () => active() && !signal.aborted && ticket === generation;
    emit({ ...state, busy: true, error: "" });
    try {
      const raw = payload
        ? await options.client.save(
            payload.expectedRevision,
            payload.entries,
            signal,
          )
        : await options.client.get(signal);
      if (!current()) return false;
      const value = validate(raw);
      if (!current()) return false;
      if (
        payload &&
        (value.revision !== payload.expectedRevision + 1 ||
          JSON.stringify(value.entries) !== JSON.stringify(payload.entries))
      )
        throw new Error("Invalid checklist revision");
      emit({
        value,
        busy: false,
        error: "",
        needsRefresh: false,
        closed: false,
      });
      if (write) options.onSaved();
      return true;
    } catch (cause) {
      if (!current()) return false;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        close(true);
        return false;
      }
      emit({
        ...state,
        busy: false,
        value:
          cause instanceof ApiError && cause.status === 404
            ? null
            : state.value,
        needsRefresh: true,
        error:
          cause instanceof ApiError && cause.status === 409
            ? "Шаг изменился. Обновите чек-лист перед следующим действием."
            : write
              ? "Не удалось подтвердить сохранение. Обновите чек-лист: изменение уже могло сохраниться."
              : "Не удалось загрузить чек-лист. Попробуйте ещё раз.",
      });
      return false;
    }
  }
  return {
    snapshot,
    load: () => work(),
    save: (entries: PlanChecklistEntry[]) => work(entries),
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
      options.sessionSignal.removeEventListener("abort", abort);
    },
  };
}
