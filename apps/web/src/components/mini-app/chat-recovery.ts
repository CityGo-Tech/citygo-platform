import { aiModeIdSchema, personalPlanIdSchema } from "@citygo/contracts";
import type { AiModeId, MiniAppChatStatus } from "@citygo/contracts";

const prefix = "citygo:mini-chat-request:v1:";
const requestPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type MiniChatMarker = { requestId: string; mode: AiModeId };
export type MiniChatRecovery = MiniChatMarker & {
  ownerId: string;
  threadId: string;
  status: MiniAppChatStatus | "unchecked" | "checking";
};

export function miniChatMarkerKey(ownerId: string, threadId: string) {
  if (
    !personalPlanIdSchema.safeParse(ownerId).success ||
    !personalPlanIdSchema.safeParse(threadId).success
  )
    return null;
  return `${prefix}${ownerId}:${threadId}`;
}

export function readMiniChatMarker(storage: Storage | null, key: string) {
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > 160) return null;
    const marker: unknown = JSON.parse(raw);
    if (
      !marker ||
      typeof marker !== "object" ||
      !("requestId" in marker) ||
      !("mode" in marker)
    )
      return null;
    const mode = aiModeIdSchema.safeParse(marker.mode);
    if (
      !mode.success ||
      typeof marker.requestId !== "string" ||
      !requestPattern.test(marker.requestId)
    )
      return null;
    return {
      requestId: marker.requestId,
      mode: mode.data,
    } satisfies MiniChatMarker;
  } catch {
    return null;
  }
}

export function writeMiniChatMarker(
  storage: Storage | null,
  key: string,
  marker: MiniChatMarker | null,
) {
  try {
    if (marker)
      storage?.setItem(
        key,
        JSON.stringify({ requestId: marker.requestId, mode: marker.mode }),
      );
    else storage?.removeItem(key);
  } catch {
    // The current workspace still has its in-memory marker.
  }
}

export function clearMiniChatMarkers(storage: Storage | null) {
  if (!storage) return;
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // Some WebViews disable storage.
  }
}
