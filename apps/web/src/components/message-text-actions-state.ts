export type MessageTextScope = {
  userId: string;
  threadId: string;
  messageId: string;
  text: string;
  sessionSignal: AbortSignal;
};
export type MessageTextContext = MessageTextScope & { enabled: boolean };
export type MessageTextView = {
  phase: "idle" | "copying" | "copied" | "manual" | "downloaded" | "error";
};
export function sameMessageTextScope(
  scope: MessageTextScope,
  current: MessageTextContext,
) {
  return (
    scope.userId === current.userId &&
    scope.threadId === current.threadId &&
    scope.messageId === current.messageId &&
    scope.text === current.text &&
    scope.sessionSignal === current.sessionSignal
  );
}
export function isMessageTextActionCurrent(
  scope: MessageTextScope,
  current: MessageTextContext,
) {
  return (
    !scope.sessionSignal.aborted &&
    current.enabled &&
    sameMessageTextScope(scope, current)
  );
}
/** Explicit local actions only. A stale owner/thread handler cannot read a new scope. */
export function createMessageTextActions(options: {
  scope: MessageTextScope;
  current: () => MessageTextContext;
  publish: (view: MessageTextView) => void;
  writeClipboard: (text: string) => Promise<void>;
  download: (text: string, filename: string) => void;
}) {
  let disposed = false,
    pending = false;
  const active = () =>
    !disposed &&
    !options.scope.sessionSignal.aborted &&
    options.current().enabled &&
    sameMessageTextScope(options.scope, options.current());
  return {
    async copy() {
      if (!active() || pending) return;
      pending = true;
      options.publish({ phase: "copying" });
      try {
        await options.writeClipboard(options.scope.text);
        if (active()) options.publish({ phase: "copied" });
      } catch {
        if (active()) options.publish({ phase: "manual" });
      } finally {
        pending = false;
      }
    },
    download() {
      if (!active() || pending) return;
      try {
        const id = /^[1-9][0-9]*$/.test(options.scope.messageId)
          ? "-" + options.scope.messageId
          : "";
        options.download(options.scope.text, "citygo-message" + id + ".txt");
        if (active()) options.publish({ phase: "downloaded" });
      } catch {
        if (active()) options.publish({ phase: "error" });
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
