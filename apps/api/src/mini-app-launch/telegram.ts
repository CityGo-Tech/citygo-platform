import { validLaunchQueryId, validLaunchUser } from "./wire.js";

const telegramMaxUserId = (1n << 52n) - 1n;

export function validTelegramLaunch(
  fields: ReadonlyMap<string, string>,
): boolean {
  const queryId = fields.get("query_id");
  return (
    (queryId === undefined || validLaunchQueryId(queryId)) &&
    validLaunchUser(fields.get("user"), telegramMaxUserId)
  );
}
