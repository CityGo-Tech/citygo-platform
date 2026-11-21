import { ApiError, createClient, type SessionTicket } from "@citygo/api-client";
import {
  personalPlanIdSchema,
  type ResultDiscussionSource,
} from "@citygo/contracts";

type LinkSource = {
  getInitialURL(): Promise<string | null>;
  addEventListener(
    type: "url",
    listener: (event: { url: string }) => void,
  ): { remove(): void };
};

export function savedPlanIdFromUrl(url: string): string | null {
  const match = /^citygo:\/\/results\/plan\/([0-9]{1,19})$/.exec(url);
  if (!match || match[0] !== url) return null;
  const id = personalPlanIdSchema.safeParse(match[1]);
  return id.success ? id.data : null;
}

/** Subscribe before reading the launch URL so a newer intent wins. */
export function observeSavedPlanLinks(
  linking: LinkSource,
  open: (id: string) => void,
): () => void {
  let active = true;
  let receivedLiveLink = false;
  const subscription = linking.addEventListener("url", ({ url }) => {
    const id = savedPlanIdFromUrl(url);
    if (active && id) {
      receivedLiveLink = true;
      open(id);
    }
  });
  void linking
    .getInitialURL()
    .then((url) => {
      if (!active || receivedLiveLink || !url) return;
      const id = savedPlanIdFromUrl(url);
      if (id) open(id);
    })
    .catch(() => {
      // A platform launch lookup failure leaves the running app usable.
    });
  return () => {
    active = false;
    subscription.remove();
  };
}

export type SavedPlanAccess = {
  token: string;
  userId: string;
  sessionTicket: SessionTicket;
};
type SavedPlanRead =
  | { phase: "opened"; result: ResultDiscussionSource }
  | { phase: "expired" | "unavailable" | "retry" };

/** A link supplies an ID only. The authenticated result endpoint owns access. */
export async function readSavedPlanResult({
  base,
  fetch,
  id,
  signal,
  access,
}: {
  base: string;
  fetch: typeof globalThis.fetch;
  id: string;
  signal: AbortSignal;
  access: SavedPlanAccess;
}): Promise<SavedPlanRead | null> {
  const { userId, token, sessionTicket } = access;
  const active = () => !signal.aborted && sessionTicket.active();
  if (!active()) return null;

  // React Native may lack AbortSignal.any(). Bind the read to both lifetimes.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  sessionTicket.signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await createClient(base, {
      native: true,
      fetch,
      token: () => token,
      signal: () => controller.signal,
    }).resultDiscussionSource({ kind: "plan", id });
    if (!active()) return null;
    return result.userId === userId &&
      result.kind === "plan" &&
      result.id === id
      ? { phase: "opened", result }
      : { phase: "unavailable" };
  } catch (error) {
    if (!active()) return null;
    if (error instanceof ApiError) {
      if (error.status === 401) return { phase: "expired" };
      if (error.status === 403 || error.status === 404)
        return { phase: "unavailable" };
    }
    return { phase: "retry" };
  } finally {
    signal.removeEventListener("abort", abort);
    sessionTicket.signal.removeEventListener("abort", abort);
  }
}
