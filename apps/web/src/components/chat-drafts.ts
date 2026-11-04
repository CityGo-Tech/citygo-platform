/** Tab-local unsent text. Never a message receipt and never sent automatically. */
import { CHAT_MAX_UTF16_UNITS, chatTextProblem } from "@citygo/contracts";
type DraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = "citygo:chat-draft:v1:";
const lifetime = 24 * 60 * 60 * 1000;
const validId = (value: string) =>
  value === value.trim() &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const keyFor = (owner: string, thread: string) =>
  validId(owner) && validId(thread) ? `${prefix}${owner}:${thread}` : null;

export function readChatDraft(
  owner: string,
  thread: string,
  storage: DraftStorage | null,
  now = Date.now(),
): string {
  const key = keyFor(owner, thread);
  if (!key || !storage) return "";
  try {
    const raw = storage.getItem(key);
    if (raw === null) return "";
    if (raw.length > CHAT_MAX_UTF16_UNITS * 6 + 256)
      throw new Error("Oversized draft");
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("text" in value) ||
      !("savedAt" in value) ||
      typeof value.text !== "string" ||
      chatTextProblem(value.text) !== null ||
      typeof value.savedAt !== "number" ||
      !Number.isFinite(value.savedAt) ||
      value.savedAt > now ||
      now - value.savedAt >= lifetime
    )
      throw new Error("Expired or invalid draft");
    return value.text;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* Disabled storage is optional. */
    }
    return "";
  }
}

export function writeChatDraft(
  owner: string,
  thread: string,
  text: string,
  storage: DraftStorage | null,
  now = Date.now(),
): boolean {
  const key = keyFor(owner, thread);
  if (!key || !storage) return false;
  if (chatTextProblem(text) !== null) {
    // Do not resurrect the earlier valid draft after a rejected oversized edit.
    try {
      storage.removeItem(key);
    } catch {
      /* Storage is optional; the current text stays in the composer. */
    }
    return false;
  }
  try {
    if (text === "") storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ text, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** Clear every owner on logout/session replacement, including stale tab entries. */
export function clearChatDrafts(storage: DraftStorage | null): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* Storage may be blocked by the browser. */
  }
}
