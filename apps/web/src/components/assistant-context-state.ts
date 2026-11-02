import { ApiError } from "@citygo/api-client";
import {
  assistantContextPreviewSchema,
  type AssistantContextPreview,
} from "@citygo/contracts";

type Scope = {
  userId: string;
  threadId: string | null;
  draft: string;
  signal: AbortSignal;
};
export type AssistantContextView =
  | { phase: "loading" }
  | { phase: "ready"; value: AssistantContextPreview }
  | { phase: "error"; message: string }
  | { phase: "closed" };

/** One explicit preview, never an AI request, persistent memory or a write. */
export function createAssistantContextResource(options: {
  scope: Scope;
  current: () => Scope & { enabled: boolean };
  read: (signal: AbortSignal) => Promise<AssistantContextPreview>;
  publish: (view: AssistantContextView) => void;
  onAccessDenied: () => void;
}) {
  let disposed = false;
  let controller: AbortController | null = null;
  const live = () => {
    const now = options.current();
    return (
      !disposed &&
      !options.scope.signal.aborted &&
      now.enabled &&
      now.userId === options.scope.userId &&
      now.threadId === options.scope.threadId &&
      now.draft === options.scope.draft &&
      now.signal === options.scope.signal
    );
  };
  const dispose = () => {
    disposed = true;
    controller?.abort();
    controller = null;
    options.scope.signal.removeEventListener("abort", dispose);
  };
  options.scope.signal.addEventListener("abort", dispose, { once: true });
  return {
    async load() {
      if (!live() || controller) return;
      const current = new AbortController();
      controller = current;
      options.publish({ phase: "loading" });
      try {
        const value = assistantContextPreviewSchema.parse(
          await options.read(
            AbortSignal.any([current.signal, options.scope.signal]),
          ),
        );
        if (!live() || current.signal.aborted || controller !== current) return;
        if (
          value.userId !== options.scope.userId ||
          value.threadId !== options.scope.threadId
        ) {
          dispose();
          options.onAccessDenied();
          return;
        }
        options.publish({ phase: "ready", value });
      } catch (cause) {
        if (!live() || current.signal.aborted || controller !== current) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          dispose();
          options.onAccessDenied();
        } else
          options.publish({
            phase: "error",
            message:
              cause instanceof ApiError
                ? cause.message
                : "Не удалось показать контекст. Попробуйте ещё раз.",
          });
      } finally {
        if (controller === current) controller = null;
      }
    },
    dispose,
  };
}
