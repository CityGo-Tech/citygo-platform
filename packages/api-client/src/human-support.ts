import { z } from "zod";
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
} from "@citygo/contracts";
import { ApiError } from "./transport.js";

type Request = <T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  method?: "PATCH" | "DELETE",
) => Promise<T>;
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
function page<
  T extends {
    requests: { id: string; status: string }[];
    nextBefore: string | null;
  },
>(value: T, before?: string, status?: string) {
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
  return value;
}
export function createHumanSupportMethods(request: Request) {
  return {
    supportRequests: async (query: SupportRequestsQuery = {}) =>
      page(
        await request(
          path("/v1/support-requests", query),
          supportRequestsPageSchema,
        ),
        query.before,
        query.status,
      ),
    createSupportRequest: async (raw: CreateSupportRequest) => {
      const input = createSupportRequestSchema.parse(raw),
        value = await request(
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
    adminSupportRequests: async (query: SupportRequestsQuery = {}) =>
      page(
        await request(
          path("/v1/admin/support-requests", query),
          adminSupportRequestsPageSchema,
        ),
        query.before,
        query.status,
      ),
    adminSupportRequest: async (raw: string) => {
      const id = supportRequestIdSchema.parse(raw),
        value = await request(
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
      const value = await request(
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
