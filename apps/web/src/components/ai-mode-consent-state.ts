import { ApiError } from "@citygo/api-client";
import type { AiModeId, ServiceConsentState } from "@citygo/contracts";

export type AiModeConsentChoice = {
  expectedUserId: string;
  policyVersion: string;
  policyId: string;
  personalData: true;
};
export type AiModeConsentView =
  | { phase: "closed" }
  | { phase: "loading"; mode: AiModeId }
  | {
      phase: "ready" | "saving";
      mode: AiModeId;
      consent: ServiceConsentState;
    }
  | { phase: "error"; mode: AiModeId; message: string };

/** A selection lifetime only. It never sends a chat or changes marketing. */
export function createAiModeConsentResource(options: {
  userId: string;
  sessionSignal: AbortSignal;
  load: (signal: AbortSignal) => Promise<ServiceConsentState>;
  save: (
    choice: AiModeConsentChoice,
    signal: AbortSignal,
  ) => Promise<ServiceConsentState>;
  verifyOwner: (signal: AbortSignal) => Promise<boolean>;
  onConfirmed: (mode: AiModeId) => Promise<void>;
  onBaseConsentRequired: () => Promise<void>;
  onAccessDenied: () => void;
  publish: (view: AiModeConsentView) => void;
}) {
  let sequence = 0;
  let disposed = false;
  let current: AiModeConsentView = { phase: "closed" };
  let controller: AbortController | null = null;
  const publish = (value: AiModeConsentView) => {
    current = value;
    options.publish(value);
  };
  const cancel = () => {
    sequence++;
    controller?.abort();
    controller = null;
    publish({ phase: "closed" });
  };
  const active = (version: number, signal: AbortSignal) =>
    !disposed &&
    !options.sessionSignal.aborted &&
    !signal.aborted &&
    version === sequence;
  const failed = (cause: unknown, mode: AiModeId) => {
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      options.onAccessDenied();
      cancel();
      return;
    }
    publish({
      phase: "error",
      mode,
      message:
        cause instanceof ApiError && cause.status === 409
          ? "Условия обновились. Загрузите их ещё раз."
          : "Не удалось подтвердить условия. Попробуйте ещё раз.",
    });
  };
  const abortSession = () => cancel();
  options.sessionSignal.addEventListener("abort", abortSession, {
    once: true,
  });
  return {
    async open(mode: AiModeId) {
      if (disposed || options.sessionSignal.aborted) return;
      cancel();
      const version = sequence;
      controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        options.sessionSignal,
      ]);
      publish({ phase: "loading", mode });
      try {
        const consent = await options.load(signal);
        if (!active(version, signal)) return;
        if (consent.serviceConsentRequired) {
          await options.onBaseConsentRequired();
          if (active(version, signal)) cancel();
        } else if (!consent.personalDataGranted) {
          throw new Error("Missing base consent");
        } else if (consent.currentAiConsentRequired === false) {
          await options.onConfirmed(mode);
          if (active(version, signal)) cancel();
        } else if (
          consent.currentAiConsentRequired !== true ||
          !consent.policy.aiProcessing
        ) {
          throw new Error("Missing current AI policy");
        } else publish({ phase: "ready", mode, consent });
      } catch (cause) {
        if (active(version, signal)) failed(cause, mode);
      }
    },
    async confirm(checked: boolean) {
      if (
        !checked ||
        current.phase !== "ready" ||
        !controller ||
        disposed ||
        options.sessionSignal.aborted
      )
        return;
      const ready = current;
      const policy = ready.consent.policy;
      if (!policy.aiProcessing) return;
      const version = sequence;
      const signal = AbortSignal.any([
        controller.signal,
        options.sessionSignal,
      ]);
      publish({ ...ready, phase: "saving" });
      try {
        if (!(await options.verifyOwner(signal))) {
          if (active(version, signal)) cancel();
          return;
        }
        if (!active(version, signal)) return;
        const saved = await options.save(
          {
            expectedUserId: options.userId,
            policyVersion: policy.version,
            policyId: policy.aiProcessing.id,
            personalData: true,
          },
          signal,
        );
        if (!active(version, signal)) return;
        if (
          saved.serviceConsentRequired ||
          saved.currentAiConsentRequired !== false ||
          !saved.personalDataGranted ||
          saved.policy.version !== policy.version ||
          saved.policy.aiProcessing?.id !== policy.aiProcessing.id
        )
          throw new Error("Unconfirmed current AI choice");
        await options.onConfirmed(ready.mode);
        if (active(version, signal)) cancel();
      } catch (cause) {
        if (active(version, signal)) failed(cause, ready.mode);
      }
    },
    cancel,
    dispose() {
      disposed = true;
      options.sessionSignal.removeEventListener("abort", abortSession);
      cancel();
    },
  };
}
