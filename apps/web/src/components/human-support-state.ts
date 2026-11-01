import { ApiError, type createClient } from "@citygo/api-client";
import {
  createSupportRequestSchema,
  supportRequestsPageSchema,
  supportRequestResultSchema,
  supportRequestStatusSchema,
  type CreateSupportRequest,
  type SupportRequest,
} from "@citygo/contracts";

type Client = Pick<
  ReturnType<typeof createClient>,
  "supportRequests" | "createSupportRequest"
> &
  Partial<
    Pick<
      ReturnType<typeof createClient>,
      "supportRequest" | "setOwnSupportRequestStatus"
    >
  >;
export type SupportFilter = "all" | "open" | "closed";
export type SupportState = {
  requests: SupportRequest[];
  nextBefore: string | null;
  receipt: SupportRequest | null;
  busy: boolean;
  error: string;
  pending: CreateSupportRequest | null;
  loaded: boolean;
  statusFilter: SupportFilter;
  changingId: string | null;
  uncertainRequestId: string | null;
  statusMessage: string;
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
    statusFilter: "all",
    changingId: null,
    uncertainRequestId: null,
    statusMessage: "",
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
        changingId: null,
        uncertainRequestId: null,
        statusMessage: "",
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
  const matches = (request: SupportRequest) =>
    state.statusFilter === "all" || request.status === state.statusFilter;
  return {
    async setFilter(filter: SupportFilter): Promise<void> {
      if (filter !== "all") supportRequestStatusSchema.parse(filter);
      if (
        !active() ||
        state.pending ||
        state.changingId ||
        filter === state.statusFilter
      )
        return;
      // A new generation supersedes an older page, even if fetch ignores abort.
      generation++;
      publish({
        statusFilter: filter,
        requests: [],
        nextBefore: null,
        loaded: false,
        busy: false,
        error: "",
        statusMessage: "",
      });
      await this.load();
    },
    async changeStatus(
      id: string,
      status: "open" | "closed",
      expectedRevision?: number,
    ) {
      supportRequestStatusSchema.parse(status);
      if (
        !active() ||
        state.busy ||
        state.pending ||
        state.uncertainRequestId === id ||
        !options.client.setOwnSupportRequestStatus
      )
        return false;
      const prior =
        state.requests.find((request) => request.id === id) ??
        (state.receipt?.id === id ? state.receipt : null);
      if (!prior) return false;
      if (
        expectedRevision !== undefined &&
        expectedRevision !== prior.revision
      ) {
        publish({
          error: "Обращение изменилось. Обновите его перед новым действием.",
          uncertainRequestId: id,
        });
        return false;
      }
      const current = ++generation;
      publish({ busy: true, changingId: id, error: "", statusMessage: "" });
      try {
        const response = await options.client.setOwnSupportRequestStatus(id, {
          expectedRevision: prior.revision,
          status,
        });
        if (!active() || current !== generation) return false;
        owner(response.userId);
        const result = supportRequestResultSchema.parse(response),
          item = result.request;
        if (
          item.id !== id ||
          item.status !== status ||
          item.body !== prior.body ||
          item.operationId !== prior.operationId ||
          item.createdAt !== prior.createdAt ||
          item.revision !== prior.revision + (prior.status === status ? 0 : 1)
        )
          throw new ApiError(
            200,
            "Некорректный статус обращения",
            "invalid_response",
          );
        publish({
          requests: state.requests
            .map((request) => (request.id === id ? item : request))
            .filter(matches),
          receipt: state.receipt?.id === id ? item : state.receipt,
          busy: false,
          changingId: null,
          uncertainRequestId: null,
          statusMessage:
            status === "closed"
              ? "Обращение закрыто. Переписка сохранена."
              : "Обращение снова открыто.",
        });
        return true;
      } catch (error) {
        if (active() && current === generation) {
          if (error instanceof ApiError && [401, 403].includes(error.status))
            fail(error);
          else
            publish({
              busy: false,
              changingId: null,
              uncertainRequestId: id,
              error:
                error instanceof ApiError && error.status === 409
                  ? "Обращение изменилось. Обновите его перед новым действием."
                  : "Изменение статуса не подтверждено. Обновите обращение перед новым действием.",
            });
        }
        return false;
      }
    },
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
          ]
            .filter(matches)
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1)),
          receipt: state.receipt?.id === id ? result.request : state.receipt,
          uncertainRequestId:
            state.uncertainRequestId === id ? null : state.uncertainRequestId,
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
        const response = await options.client.supportRequests({
          ...(before ? { before } : {}),
          ...(state.statusFilter === "all"
            ? {}
            : { status: state.statusFilter }),
        });
        if (!active() || current !== generation) return;
        owner(response.userId);
        const page = supportRequestsPageSchema.parse(response);
        // Validate the server's page before merging. A duplicate already
        // opened outside the loaded range is legitimate; duplicate/unordered
        // IDs inside a response or outside its keyset are not.
        if (
          page.requests.some(
            (request, index, rows) =>
              !matches(request) ||
              (before !== undefined && BigInt(request.id) >= BigInt(before)) ||
              (index > 0 && BigInt(request.id) >= BigInt(rows[index - 1]!.id)),
          ) ||
          (page.nextBefore !== null &&
            (page.requests.length !== 20 ||
              page.nextBefore !== page.requests.at(-1)?.id))
        )
          throw new ApiError(
            200,
            "Некорректная страница обращений",
            "invalid_response",
          );
        const requests = before
          ? new Map(state.requests.map((request) => [request.id, request]))
          : new Map<string, SupportRequest>();
        for (const request of page.requests) requests.set(request.id, request);
        publish({
          requests: [...requests.values()].sort((a, b) =>
            BigInt(a.id) === BigInt(b.id)
              ? 0
              : BigInt(a.id) > BigInt(b.id)
                ? -1
                : 1,
          ),
          nextBefore: page.nextBefore,
          uncertainRequestId: page.requests.some(
            (request) => request.id === state.uncertainRequestId,
          )
            ? null
            : state.uncertainRequestId,
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
          ].filter(matches),
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
