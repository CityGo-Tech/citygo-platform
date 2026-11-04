import { ApiError } from "@citygo/api-client";
import {
  agentKeys,
  chatTextError,
  resultDiscussionSourceSchema,
  type AgentKey,
  type ResultDiscussionParams,
  type ResultDiscussionSource,
} from "@citygo/contracts";

export type ResultDiscussionInput = {
  source: ResultDiscussionSource;
  sessionSignal: AbortSignal;
  target: AgentKey;
  text: string;
};
export function resultDiscussionDraft(text: string, existing = "") {
  const reviewed = text.trim();
  if (!reviewed) throw new Error("Добавьте текст для обсуждения.");
  const result = (existing ? existing + "\n\n" : "") + reviewed;
  const error = chatTextError(result);
  if (error) throw new Error(error);
  for (const point of result) {
    const code = point.codePointAt(0)!;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new Error("Исправьте недопустимые символы в тексте.");
  }
  return result;
}
export function initialResultDiscussionDraft(source: ResultDiscussionSource) {
  const text = "Хочу обсудить сохранённый результат:\n\n" + source.text;
  try {
    return resultDiscussionDraft(text);
  } catch {
    return "";
  }
}
export function currentResultDiscussionInput(
  input: ResultDiscussionInput,
  owner: string,
  signal: AbortSignal,
) {
  return (
    !signal.aborted &&
    input.sessionSignal === signal &&
    input.source.userId === owner &&
    agentKeys.some((key) => key === input.target) &&
    resultDiscussionSourceSchema.safeParse(input.source).success
  );
}
export type ResultDiscussionState = {
  phase: "loading" | "ready" | "error" | "closed";
  checking: boolean;
  source: ResultDiscussionSource | null;
  error: string;
};
/** Private, abortable source reads; selection and confirmation never call a model. */
export function createResultDiscussionResource(options: {
  owner: string;
  selection: ResultDiscussionParams;
  sessionSignal: AbortSignal;
  read: (signal: AbortSignal) => Promise<unknown>;
  publish: (state: ResultDiscussionState) => void;
  onAccessDenied: () => void;
}) {
  let state: ResultDiscussionState = {
    phase: "loading",
    source: null,
    error: "",
    checking: false,
  };
  let disposed = false,
    epoch = 0;
  let request: AbortController | undefined;
  const active = () =>
    !disposed && !options.sessionSignal.aborted && state.phase !== "closed";
  const publish = () =>
    options.publish({
      ...state,
      source: state.source ? { ...state.source } : null,
    });
  function close() {
    request?.abort();
    epoch++;
    state = { phase: "closed", source: null, error: "", checking: false };
    publish();
  }
  options.sessionSignal.addEventListener("abort", close, { once: true });
  async function fetchSource(confirm: boolean) {
    if (!active()) return null;
    request?.abort();
    const token = ++epoch;
    const controller = new AbortController();
    request = controller;
    const signal = AbortSignal.any([controller.signal, options.sessionSignal]);
    const previous = state.source;
    state = {
      ...state,
      checking: confirm,
      error: "",
      phase: confirm && previous ? "ready" : "loading",
    };
    publish();
    try {
      const raw = await options.read(signal);
      if (!active() || signal.aborted || token !== epoch) return null;
      const source = resultDiscussionSourceSchema.parse(raw);
      if (
        source.userId !== options.owner ||
        source.kind !== options.selection.kind ||
        source.id !== options.selection.id
      )
        throw new Error("Saved result owner or identity mismatch");
      const changed =
        confirm && JSON.stringify(source) !== JSON.stringify(previous);
      state = {
        phase: "ready",
        source,
        checking: false,
        error: changed
          ? "Результат изменился. Проверьте обновлённый текст перед продолжением."
          : "",
      };
      publish();
      return changed ? null : source;
    } catch (error) {
      if (!active() || signal.aborted || token !== epoch) return null;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        close();
        options.onAccessDenied();
        return null;
      }
      state = {
        phase: "error",
        source: null,
        checking: false,
        error:
          error instanceof ApiError && error.status === 404
            ? "Результат больше недоступен. Вернитесь к списку."
            : "Не удалось проверить результат. Попробуйте ещё раз.",
      };
      publish();
      return null;
    }
  }
  return {
    load: () => fetchSource(false),
    confirm: () => fetchSource(true),
    dispose() {
      disposed = true;
      close();
      options.sessionSignal.removeEventListener("abort", close);
    },
  };
}
