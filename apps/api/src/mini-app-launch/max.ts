import { validLaunchQueryId, validLaunchUser } from "./wire.js";

const maxUserId = (1n << 63n) - 1n;

export function validMaxLaunch(fields: ReadonlyMap<string, string>): boolean {
  const queryId = fields.get("query_id");
  return (
    queryId !== undefined &&
    validLaunchQueryId(queryId) &&
    validLaunchUser(fields.get("user"), maxUserId)
  );
}
