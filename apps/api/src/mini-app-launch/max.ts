import { launchUserId, validLaunchQueryId } from "./wire.js";

const maxUserId = (1n << 63n) - 1n;

export function maxLaunchSubject(
  fields: ReadonlyMap<string, string>,
): string | undefined {
  const queryId = fields.get("query_id");
  if (queryId === undefined || !validLaunchQueryId(queryId)) return;
  return launchUserId(fields.get("user"), maxUserId);
}
