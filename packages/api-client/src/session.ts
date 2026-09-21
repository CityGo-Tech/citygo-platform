// A client-side lifetime, not authentication or server-side session revocation.
export class StaleSessionError extends Error {
  constructor() {
    super("Сессия клиента изменилась");
  }
}
export type SessionTicket = {
  signal: AbortSignal;
  active(): boolean;
  check(): void;
};
export function createSessionGuard() {
  let controller = new AbortController();
  let owner: string | undefined;
  return {
    capture(): SessionTicket {
      const current = controller;
      return {
        signal: current.signal,
        active: () => current === controller && !current.signal.aborted,
        check() {
          if (current !== controller || current.signal.aborted)
            throw new StaleSessionError();
        },
      };
    },
    reset(nextOwner?: string) {
      controller.abort();
      controller = new AbortController();
      owner = nextOwner;
    },
    ownerChanged(nextOwner: string) {
      const changed = owner !== undefined && owner !== nextOwner;
      if (!changed) owner = nextOwner;
      return changed;
    },
    hasOwner: () => owner !== undefined,
  };
}

// SecureStore operations must stay ordered: a delayed login write must never
// recreate a credential after logout removed it. Never store tokens in logs.
export function createSessionStorage(store: {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  remove(): Promise<void>;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  return {
    async load(ticket: SessionTicket) {
      const token = await enqueue(async () => {
        ticket.check();
        return store.get();
      });
      ticket.check();
      return token;
    },
    async save(token: string, ticket: SessionTicket) {
      await enqueue(async () => {
        ticket.check();
        await store.set(token);
      });
      ticket.check();
    },
    clear: () => enqueue(() => store.remove()),
  };
}

export async function clearSessionAndRevoke(
  storage: { clear(): Promise<void> },
  revoke?: () => Promise<unknown>,
) {
  // A storage failure must not be reported as successful local logout.
  await storage.clear();
  if (!revoke) return { serverRevoked: false };
  try {
    await revoke();
    return { serverRevoked: true };
  } catch {
    return { serverRevoked: false };
  }
}

const browserSessionEvent = "citygo-session-changed";
export function notifyBrowserSessionChange() {
  window.dispatchEvent(new Event(browserSessionEvent));
  // Only an invalidation nonce, never a token, identity or profile.
  try {
    window.localStorage.setItem(browserSessionEvent, crypto.randomUUID());
  } catch {
    /* Storage may be disabled; same-page invalidation still works. */
  }
}
export function subscribeBrowserSessionChange(onChange: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === browserSessionEvent) onChange();
  };
  window.addEventListener(browserSessionEvent, onChange);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(browserSessionEvent, onChange);
    window.removeEventListener("storage", storage);
  };
}
