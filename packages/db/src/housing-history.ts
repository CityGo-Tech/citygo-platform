import { isDeepStrictEqual } from "node:util";
import { r1HousingBriefDraftV1Schema } from "@citygo/contracts";
import type { z } from "zod";
import {
  r1HousingIdV1Schema,
  r1HousingRevisionV1Schema,
} from "@citygo/contracts";

export type HousingDataContext = {
  operation: "get" | "history" | "recover" | "replay" | "write" | "selection";
  briefId?: string;
  revision?: number;
};

export type StoredHousingBriefContent = z.infer<
  typeof r1HousingBriefDraftV1Schema
>;

// Server data failure, not a bad client command. Never include stored content,
// Zod issues or free text in the message/cause returned to a caller or logger.
export class HousingStoredDataError extends Error {
  constructor(
    public readonly reason:
      | "invalid_content"
      | "unsupported_version"
      | "write_failed"
      | "invalid_metadata",
    context?: HousingDataContext,
  ) {
    super("Не удалось обработать данные брифа");
    this.name = "HousingStoredDataError";
    // Explicit allowlist, not a spread of a row, Error, payload or Zod issues.
    this.context =
      context &&
      ["get", "history", "recover", "replay", "write", "selection"].includes(
        context.operation,
      )
        ? Object.freeze({
            operation: context.operation,
            ...(r1HousingIdV1Schema.safeParse(context.briefId).success
              ? { briefId: context.briefId }
              : {}),
            ...(r1HousingRevisionV1Schema.safeParse(context.revision).success
              ? { revision: context.revision }
              : {}),
          })
        : undefined;
  }
  public readonly context: Readonly<HousingDataContext> | undefined;
}

// Dispatch by the persisted version, never by the current input contract.
// No fallback, in-place migration, guessed version or read-time normalization.
export function readStoredHousingBrief(
  content: unknown,
): StoredHousingBriefContent {
  if (
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    !("schemaVersion" in content) ||
    !Number.isInteger(content.schemaVersion) ||
    Number(content.schemaVersion) < 1
  )
    throw new HousingStoredDataError("invalid_content");
  switch (content.schemaVersion) {
    case 1: {
      const result = r1HousingBriefDraftV1Schema.safeParse(content);
      if (!result.success || !isDeepStrictEqual(content, result.data))
        throw new HousingStoredDataError("invalid_content");
      return result.data;
    }
    default:
      throw new HousingStoredDataError("unsupported_version");
  }
}
