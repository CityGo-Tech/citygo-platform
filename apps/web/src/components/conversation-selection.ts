const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

/** Non-secret UI preference, scoped to owner. Server must still authorize every read. */
export function readConversationSelection(
  owner: string,
  storage: Pick<Storage, "getItem"> | null,
): string | null {
  if (!validId(owner) || !storage) return null;
  try {
    const value = storage.getItem("citygo:conversation:" + owner);
    return validId(value) ? value : null;
  } catch {
    return null;
  }
}
export function writeConversationSelection(
  owner: string,
  id: string | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  if (!validId(owner) || !storage || (id !== null && !validId(id))) return;
  try {
    const key = "citygo:conversation:" + owner;
    if (id === null) storage.removeItem(key);
    else storage.setItem(key, id);
  } catch {
    /* Storage may be disabled. Server-owned conversations remain available. */
  }
}
