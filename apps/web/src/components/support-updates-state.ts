import { ApiError, type createClient } from "@citygo/api-client";
import {
  supportUpdatesPageSchema,
  type SupportUpdatesPage,
} from "@citygo/contracts";

export type SupportUpdatesState = {
  page: SupportUpdatesPage | null;
  busy: boolean;
  error: string;
  closed: boolean;
};
export function createSupportUpdatesResource(o: {
  userId: string;
  signal: AbortSignal;
  client: Pick<ReturnType<typeof createClient>, "supportUpdates">;
  publish: (state: SupportUpdatesState) => void;
  onAccessDenied: () => void;
}) {
  let state: SupportUpdatesState = {
    page: null,
    busy: false,
    error: "",
    closed: false,
  };
  let live = true,
    generation = 0;
  const active = () => live && !o.signal.aborted && !state.closed;
  const publish = (patch: Partial<SupportUpdatesState>) => {
    if (active()) {
      state = { ...state, ...patch };
      o.publish({
        ...state,
        page: state.page ? structuredClone(state.page) : null,
      });
    }
  };
  function close(denied = false) {
    if (!live || state.closed) return;
    state = { page: null, busy: false, error: "", closed: true };
    generation++;
    o.publish({ ...state });
    if (denied) o.onAccessDenied();
  }
  const abort = () => close();
  o.signal.addEventListener("abort", abort, { once: true });
  return {
    async load(before?: string) {
      if (!active() || state.busy) return;
      const ticket = ++generation;
      publish({ busy: true, error: "" });
      try {
        const page = supportUpdatesPageSchema.parse(
          await o.client.supportUpdates(before ? { before } : {}),
        );
        if (!active() || ticket !== generation) return;
        if (page.userId !== o.userId) {
          close(true);
          return;
        }
        publish({ page, busy: false });
      } catch (e) {
        if (!active() || ticket !== generation) return;
        if (e instanceof ApiError && [401, 403].includes(e.status)) close(true);
        else
          publish({ busy: false, error: "Не удалось проверить новые ответы." });
      }
    },
    dispose() {
      close();
      live = false;
      generation++;
      o.signal.removeEventListener("abort", abort);
    },
  };
}
