import {
  supportRequestIdSchema,
  createSupportRequestSchema,
  supportRequestsQuerySchema,
  supportRequestResultSchema,
  supportRequestsPageSchema,
  adminSupportRequestResultSchema,
  adminSupportRequestsPageSchema,
  updateSupportRequestStatusSchema,
  type CreateSupportRequest,
  type SupportRequestsQuery,
  type UpdateSupportRequestStatus,
  type SupportRequestsPage,
  type SupportRequestResult,
  type AdminSupportRequestsPage,
  type AdminSupportRequestResult,
  supportRepliesQuerySchema,
  supportRepliesPageSchema,
  adminSupportRepliesPageSchema,
  createSupportReplySchema,
  supportReplyResultSchema,
  type SupportRepliesQuery,
  type SupportRepliesPage,
  type AdminSupportRepliesPage,
  type CreateSupportReply,
  type SupportReplyResult,
} from "@citygo/contracts";
import { ApiError } from "./transport.js";

type Request = <T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  body?: unknown,
  method?: "PATCH" | "DELETE",
) => Promise<T>;
export type HumanSupportMethods = {
  supportReplies(
    id: string,
    query?: SupportRepliesQuery,
  ): Promise<SupportRepliesPage>;
  adminSupportReplies(
    id: string,
    query?: SupportRepliesQuery,
  ): Promise<AdminSupportRepliesPage>;
  replyToSupportRequest(
    id: string,
    command: CreateSupportReply,
  ): Promise<SupportReplyResult>;
  supportRequests(query?: SupportRequestsQuery): Promise<SupportRequestsPage>;
  createSupportRequest(
    raw: CreateSupportRequest,
  ): Promise<SupportRequestResult>;
  adminSupportRequests(
    query?: SupportRequestsQuery,
  ): Promise<AdminSupportRequestsPage>;
  adminSupportRequest(raw: string): Promise<AdminSupportRequestResult>;
  setSupportRequestStatus(
    raw: string,
    command: UpdateSupportRequestStatus,
  ): Promise<AdminSupportRequestResult>;
};
const invalid = () =>
  new ApiError(
    200,
    "Ответ сервера не соответствует обращению",
    "invalid_response",
  );
function path(base: string, query: SupportRequestsQuery) {
  const input = supportRequestsQuerySchema.parse(query),
    search = new URLSearchParams();
  if (input.before) search.set("before", input.before);
  if (input.status) search.set("status", input.status);
  return base + (search.size ? "?" + search.toString() : "");
}
function validatePage(
  value: {
    requests: { id: string; status: string }[];
    nextBefore: string | null;
  },
  before?: string,
  status?: string,
): void {
  if (
    value.requests.some(
      (r, i, rows) =>
        (status !== undefined && r.status !== status) ||
        (before !== undefined && BigInt(r.id) >= BigInt(before)) ||
        (i > 0 && BigInt(r.id) >= BigInt(rows[i - 1]!.id)),
    ) ||
    (value.nextBefore !== null &&
      (value.requests.length !== 20 ||
        value.nextBefore !== value.requests.at(-1)?.id))
  )
    throw invalid();
}
function validateReplies(
  value: {
    requestId: string;
    replies: { id: string; requestId: string }[];
    nextBefore: string | null;
  },
  id: string,
  before?: string,
) {
  if (
    value.requestId !== id ||
    value.replies.some(
      (r, i, rows) =>
        r.requestId !== id ||
        (before !== undefined && BigInt(r.id) >= BigInt(before)) ||
        (i > 0 && BigInt(r.id) >= BigInt(rows[i - 1]!.id)),
    ) ||
    (value.nextBefore !== null &&
      (value.replies.length !== 20 ||
        value.nextBefore !== value.replies.at(-1)?.id))
  )
    throw invalid();
}
export function createHumanSupportMethods(
  request: Request,
): HumanSupportMethods {
  return {
    supportReplies: async (raw, query = {}) => {
      const id = supportRequestIdSchema.parse(raw),
        input = supportRepliesQuerySchema.parse(query);
      const result = await request<SupportRepliesPage>(
        "/v1/support-requests/" +
          id +
          "/replies" +
          (input.before ? "?before=" + input.before : ""),
        supportRepliesPageSchema,
      );
      validateReplies(result, id, input.before);
      return result;
    },
    adminSupportReplies: async (raw, query = {}) => {
      const id = supportRequestIdSchema.parse(raw),
        input = supportRepliesQuerySchema.parse(query);
      const result = await request<AdminSupportRepliesPage>(
        "/v1/admin/support-requests/" +
          id +
          "/replies" +
          (input.before ? "?before=" + input.before : ""),
        adminSupportRepliesPageSchema,
      );
      validateReplies(result, id, input.before);
      return result;
    },
    replyToSupportRequest: async (raw, command) => {
      const id = supportRequestIdSchema.parse(raw),
        input = createSupportReplySchema.parse(command);
      const result = await request<SupportReplyResult>(
        "/v1/admin/support-requests/" + id + "/replies",
        supportReplyResultSchema,
        input,
      );
      if (
        result.request.id !== id ||
        result.reply.requestId !== id ||
        result.reply.operationId.toLowerCase() !== input.operationId ||
        result.reply.body !== input.body ||
        result.request.revision < input.expectedRevision + 1
      )
        throw invalid();
      return result;
    },
    supportRequests: async (query: SupportRequestsQuery = {}) => {
      // Keep the complete schema output at the transport boundary. Returning a
      // generic page(await request(...)) can infer the minimal cursor shape in
      // emitted declarations and erase the owner and full request DTO.
      const value = await request<SupportRequestsPage>(
        path("/v1/support-requests", query),
        supportRequestsPageSchema,
      );
      validatePage(value, query.before, query.status);
      return value;
    },
    createSupportRequest: async (raw: CreateSupportRequest) => {
      const input = createSupportRequestSchema.parse(raw),
        value = await request<SupportRequestResult>(
          "/v1/support-requests",
          supportRequestResultSchema,
          input,
        );
      if (
        value.request.operationId.toLowerCase() !== input.operationId ||
        value.request.body !== input.body
      )
        throw invalid();
      return value;
    },
    adminSupportRequests: async (query: SupportRequestsQuery = {}) => {
      const value = await request<AdminSupportRequestsPage>(
        path("/v1/admin/support-requests", query),
        adminSupportRequestsPageSchema,
      );
      validatePage(value, query.before, query.status);
      return value;
    },
    adminSupportRequest: async (raw: string) => {
      const id = supportRequestIdSchema.parse(raw),
        value = await request<AdminSupportRequestResult>(
          "/v1/admin/support-requests/" + id,
          adminSupportRequestResultSchema,
        );
      if (value.request.id !== id) throw invalid();
      return value;
    },
    setSupportRequestStatus: async (
      raw: string,
      command: UpdateSupportRequestStatus,
    ) => {
      const id = supportRequestIdSchema.parse(raw),
        input = updateSupportRequestStatusSchema.parse(command);
      const value = await request<AdminSupportRequestResult>(
        "/v1/admin/support-requests/" + id,
        adminSupportRequestResultSchema,
        input,
        "PATCH",
      );
      if (
        value.request.id !== id ||
        value.request.status !== input.status ||
        value.request.revision < input.expectedRevision ||
        value.request.revision > input.expectedRevision + 1
      )
        throw invalid();
      return value;
    },
  };
}
