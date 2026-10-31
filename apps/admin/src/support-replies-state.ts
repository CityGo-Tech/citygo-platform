import { ApiError } from "@citygo/api-client";
import {
  createSupportReplySchema,
  type CreateSupportReply,
  type SupportReply,
  type SupportRepliesPage,
  type AdminSupportRepliesPage,
  type SupportReplyResult,
} from "@citygo/contracts";

export type SupportRepliesState = {
  replies: SupportReply[];
  nextBefore: string | null;
  loaded: boolean;
  busy: boolean;
  error: string;
  pending: CreateSupportReply | null;
  draft: string;
  closed: boolean;
};
export function createSupportRepliesResource(o: {
  viewerId: string;
  requestId: string;
  signal: AbortSignal;
  admin: boolean;
  list: (
    before?: string,
  ) => Promise<SupportRepliesPage | AdminSupportRepliesPage>;
  send?: (input: CreateSupportReply) => Promise<SupportReplyResult>;
  operationId: () => string;
  publish: (state: SupportRepliesState) => void;
  onAccessDenied: () => void;
  onReplied?: (result: SupportReplyResult) => void;
}) {
  let state: SupportRepliesState = {
    replies: [],
    nextBefore: null,
    loaded: false,
    busy: false,
    error: "",
    pending: null,
    draft: "",
    closed: false,
  };
  let live = true,
    generation = 0;
  const active = () => live && !o.signal.aborted && !state.closed;
  const publish = (patch: Partial<SupportRepliesState>) => {
    if (active()) {
      state = { ...state, ...patch };
      o.publish({
        ...state,
        replies: state.replies.map((r) => ({ ...r })),
        pending: state.pending ? { ...state.pending } : null,
      });
    }
  };
  function close(denied = false) {
    if (!live || state.closed) return;
    state = {
      replies: [],
      nextBefore: null,
      loaded: false,
      busy: false,
      error: "",
      pending: null,
      draft: "",
      closed: true,
    };
    generation++;
    o.publish({ ...state });
    if (denied) o.onAccessDenied();
  }
  const abort = () => close();
  o.signal.addEventListener("abort", abort, { once: true });
  function fail(e: unknown, mutation = false) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      close(true);
      return;
    }
    if (
      mutation &&
      state.pending &&
      e instanceof ApiError &&
      [400, 404, 409, 413].includes(e.status)
    )
      publish({
        busy: false,
        pending: null,
        error:
          "Ответ не сохранён. Обновите обращение перед следующей попыткой.",
      });
    else
      publish({
        busy: false,
        error: state.pending
          ? "Сохранение ответа не подтверждено. Повторите тот же ответ. Сброс черновика не удалит уже сохранённый ответ."
          : "Не удалось загрузить ответы. Попробуйте ещё раз.",
      });
  }
  async function load(before?: string) {
    if (!active() || state.busy) return;
    const ticket = ++generation;
    publish({ busy: true, error: "" });
    try {
      const r = await o.list(before);
      if (!active() || ticket !== generation) return;
      if (
        ("actorId" in r ? r.actorId : r.userId) !== o.viewerId ||
        r.requestId !== o.requestId
      ) {
        close(true);
        return;
      }
      if (
        r.replies.some(
          (v, i, rs) =>
            v.requestId !== o.requestId ||
            (before && BigInt(v.id) >= BigInt(before)) ||
            (i > 0 && BigInt(v.id) >= BigInt(rs[i - 1]!.id)) ||
            (before && state.replies.some((old) => old.id === v.id)),
        )
      )
        throw new Error("Invalid replies page");
      publish({
        replies: before ? [...state.replies, ...r.replies] : r.replies,
        nextBefore: r.nextBefore,
        loaded: true,
        busy: false,
      });
    } catch (e) {
      if (active() && ticket === generation) fail(e);
    }
  }
  return {
    edit(draft: string) {
      if (active() && !state.busy && !state.pending) publish({ draft });
    },
    cancel() {
      if (active() && !state.busy)
        publish({ draft: "", pending: null, error: "" });
    },
    load,
    async send(expectedRevision: number) {
      if (!active() || state.busy || !o.admin || !o.send) return;
      const parsed = createSupportReplySchema.safeParse(
        state.pending ?? {
          operationId: o.operationId(),
          expectedRevision,
          body: state.draft,
        },
      );
      if (!parsed.success) {
        publish({ error: "Проверьте текст ответа." });
        return;
      }
      const input = parsed.data;
      const ticket = ++generation;
      publish({ busy: true, pending: input, error: "" });
      try {
        const r = await o.send(input);
        if (!active() || ticket !== generation) return;
        if (
          r.actorId !== o.viewerId ||
          r.request.id !== o.requestId ||
          r.reply.requestId !== o.requestId
        ) {
          close(true);
          return;
        }
        publish({
          // A replay may acknowledge an older reply below the loaded cursor.
          // Reset the range before reading a fresh first page; never splice it
          // into an unrelated keyset page or retry the POST automatically.
          replies: [r.reply],
          nextBefore: null,
          pending: null,
          draft: "",
          busy: false,
          loaded: false,
        });
        o.onReplied?.(r);
        await load();
      } catch (e) {
        if (active() && ticket === generation) fail(e, true);
      }
    },
    dispose() {
      close();
      live = false;
      o.signal.removeEventListener("abort", abort);
      generation++;
    },
  };
}
