import { ApiError, type createClient } from "@citygo/api-client";
import {
  createSupportRequestSchema,
  type CreateSupportRequest,
  type SupportRequest,
} from "@citygo/contracts";

type Client = Pick<
  ReturnType<typeof createClient>,
  "supportRequests" | "createSupportRequest"
> &
  Partial<Pick<ReturnType<typeof createClient>, "supportRequest">>;
export type SupportState = {
  requests: SupportRequest[];
  nextBefore: string | null;
  receipt: SupportRequest | null;
  busy: boolean;
  error: string;
  pending: CreateSupportRequest | null;
  loaded: boolean;
};
export function createHumanSupportResource(options: {
  userId: string;
  signal: AbortSignal;
  client: Client;
  publish: (state: SupportState) => void;
  onAccessDenied: () => void;
  operationId: () => string;
}) {
  let state: SupportState = {
    requests: [],
    nextBefore: null,
    receipt: null,
    busy: false,
    error: "",
    pending: null,
    loaded: false,
  };
  let live = true,
    generation = 0;
  const active = () => live && !options.signal.aborted;
  const publish = (patch: Partial<SupportState>) => {
    if (active()) {
      state = { ...state, ...patch };
      options.publish(state);
    }
  };
  const fail = (error: unknown) => {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      publish({
        requests: [],
        receipt: null,
        pending: null,
        busy: false,
        error: "",
      });
      live = false;
      options.onAccessDenied();
      return;
    }
    if (
      state.pending &&
      error instanceof ApiError &&
      [400, 409, 413].includes(error.status)
    ) {
      publish({
        pending: null,
        busy: false,
        error: "Вопрос не сохранён. Проверьте текст и отправьте его снова.",
      });
      return;
    }
    publish({
      busy: false,
      error: state.pending
        ? "Сохранение не подтверждено. Повторите ту же операцию: повтор не создаст второе обращение."
        : "Не удалось загрузить обращения. Попробуйте ещё раз.",
    });
  };
  const owner = (userId: string) => {
    if (userId !== options.userId)
      throw new ApiError(401, "Аккаунт изменился", "invalid_response");
  };
  return {
    async open(id: string) {
      if (!active() || state.busy || !options.client.supportRequest)
        return false;
      const current = ++generation;
      publish({ busy: true, error: "" });
      try {
        const result = await options.client.supportRequest(id);
        if (!active() || current !== generation) return false;
        owner(result.userId);
        if (result.request.id !== id)
          throw new Error("Invalid support request");
        publish({
          requests: [
            ...state.requests.filter((r) => r.id !== id),
            result.request,
          ].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1)),
          busy: false,
        });
        return true;
      } catch (e) {
        if (active() && current === generation) fail(e);
        return false;
      }
    },
    async load(before?: string) {
      if (!active() || state.busy) return;
      const current = ++generation;
      publish({ busy: true, error: "" });
      try {
        const page = await options.client.supportRequests(
          before ? { before } : {},
        );
        if (!active() || current !== generation) return;
        owner(page.userId);
        publish({
          requests: before
            ? [...state.requests, ...page.requests]
            : page.requests,
          nextBefore: page.nextBefore,
          receipt: state.receipt
            ? (page.requests.find((item) => item.id === state.receipt?.id) ??
              state.receipt)
            : null,
          busy: false,
          loaded: true,
        });
      } catch (error) {
        if (active() && current === generation) fail(error);
      }
    },
    async send(body: string) {
      if (!active() || state.busy) return;
      const input =
        state.pending ??
        createSupportRequestSchema.parse({
          operationId: options.operationId(),
          body,
        });
      const current = ++generation;
      publish({ busy: true, error: "", pending: input });
      try {
        const result = await options.client.createSupportRequest(input);
        if (!active() || current !== generation) return;
        owner(result.userId);
        publish({
          receipt: result.request,
          requests: [
            result.request,
            ...state.requests.filter((r) => r.id !== result.request.id),
          ],
          pending: null,
          busy: false,
        });
      } catch (error) {
        if (active() && current === generation) fail(error);
      }
    },
    compose() {
      if (active() && !state.busy && !state.pending)
        publish({ receipt: null, error: "" });
    },
    dispose() {
      live = false;
      generation++;
    },
  };
}
