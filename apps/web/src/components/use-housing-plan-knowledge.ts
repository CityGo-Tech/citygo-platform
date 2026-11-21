"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type { KnowledgeLookupRequest } from "@citygo/contracts";
import type { HousingPlanKnowledgeState } from "./housing-plan-sources";

const firstPaymentQuery = {
  factKey: "housing.rent.first_payment",
  scope: { kind: "global" },
  limit: 1,
} as const satisfies KnowledgeLookupRequest;

type Snapshot = {
  ownerId: string;
  signal: AbortSignal;
  request: number;
  state: HousingPlanKnowledgeState;
};

export function useHousingPlanKnowledge({
  userId,
  sessionSignal,
  enabled,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  enabled: boolean;
  onAccessDenied: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [request, setRequest] = useState(0);
  const accessDenied = useRef(onAccessDenied);
  accessDenied.current = onAccessDenied;

  const refresh = useCallback(() => setRequest((version) => version + 1), []);
  const active = enabled && !!userId && !sessionSignal.aborted;
  const state: HousingPlanKnowledgeState =
    active &&
    snapshot?.ownerId === userId &&
    snapshot.signal === sessionSignal &&
    snapshot.request === request
      ? snapshot.state
      : { status: "loading" };

  useEffect(() => {
    const clear = () => setSnapshot(null);
    sessionSignal.addEventListener("abort", clear, { once: true });
    return () => sessionSignal.removeEventListener("abort", clear);
  }, [sessionSignal]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", {
      signal: () => signal,
      limits: { requestTimeoutMs: 5_000 },
    });
    function show(state: HousingPlanKnowledgeState) {
      if (!signal.aborted)
        setSnapshot({ ownerId: userId, signal: sessionSignal, request, state });
    }
    void api.lookupKnowledge(firstPaymentQuery).then(show, (error: unknown) => {
      if (signal.aborted) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        accessDenied.current();
      else show({ status: "unavailable" });
    });
    return () => controller.abort();
  }, [active, request, sessionSignal, userId]);

  useEffect(() => {
    if (!active) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refreshVisible);
    return () => window.removeEventListener("focus", refreshVisible);
  }, [active, refresh]);

  useEffect(() => {
    if (state.status !== "hit") return;
    const deadline = Math.min(
      ...state.matches.flatMap((match) => [
        Date.parse(match.validUntil),
        ...match.evidence.map((source) => Date.parse(source.validUntil)),
      ]),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopShowingExpiredFact = () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(
          stopShowingExpiredFact,
          Math.min(remaining, 2_147_483_647),
        );
        return;
      }
      setSnapshot((current) =>
        current?.state === state
          ? {
              ...current,
              state: {
                status: "stale",
                reason: "expired",
                researchNeeded: true,
              },
            }
          : current,
      );
    };
    stopShowingExpiredFact();
    return () => clearTimeout(timer);
  }, [state]);

  return { state, refresh };
}
