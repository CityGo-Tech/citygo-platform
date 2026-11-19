import { launchUserId, validLaunchQueryId } from "./wire.js";

const telegramMaxUserId = (1n << 52n) - 1n;

export function telegramLaunchSubject(
  fields: ReadonlyMap<string, string>,
): string | undefined {
  const queryId = fields.get("query_id");
  if (queryId !== undefined && !validLaunchQueryId(queryId)) return;
  return launchUserId(fields.get("user"), telegramMaxUserId);
}
