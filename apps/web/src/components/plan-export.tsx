"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button } from "@citygo/ui-web";
import {
  createPlanExportAction,
  type PlanExportState,
} from "./plan-export-state";

export function PlanExportAction({
  userId,
  sessionSignal,
  disabled,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  disabled: boolean;
  onAccessDenied: () => void;
}) {
  const [state, setState] = useState<{
    owner: string;
    signal: AbortSignal;
    value: PlanExportState;
  } | null>(null);
  const currentProps = useRef({
    userId,
    sessionSignal,
    disabled,
    onAccessDenied,
  });
  currentProps.current = { userId, sessionSignal, disabled, onAccessDenied };
  const resource = useRef<ReturnType<typeof createPlanExportAction> | null>(
    null,
  );
  const resourceScope = useRef<{ userId: string; signal: AbortSignal } | null>(
    null,
  );
  useEffect(() => {
    const current = createPlanExportAction({
      userId,
      signal: sessionSignal,
      read: (signal) =>
        createClient("/api", { signal: () => signal }).exportPersonalPlan(),
      publish: (value) =>
        setState({ owner: userId, signal: sessionSignal, value }),
      onAccessDenied: () => {
        if (
          !sessionSignal.aborted &&
          currentProps.current.userId === userId &&
          currentProps.current.sessionSignal === sessionSignal
        )
          currentProps.current.onAccessDenied();
      },
      download: (text) => {
        if (
          sessionSignal.aborted ||
          currentProps.current.userId !== userId ||
          currentProps.current.sessionSignal !== sessionSignal
        )
          return;
        const url = URL.createObjectURL(
          new Blob([text], { type: "text/plain;charset=utf-8" }),
        );
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = "citygo-plan.txt";
          document.body.append(link);
          link.click();
          link.remove();
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    });
    resource.current = current;
    resourceScope.current = { userId, signal: sessionSignal };
    return () => {
      current.dispose();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal]);
  const value =
    !sessionSignal.aborted &&
    state?.owner === userId &&
    state.signal === sessionSignal
      ? state.value
      : null;
  return (
    <div>
      <Button
        variant="ghost"
        disabled={disabled || sessionSignal.aborted || value?.busy}
        onClick={() => {
          const latest = currentProps.current;
          if (
            resourceScope.current?.userId === userId &&
            resourceScope.current.signal === sessionSignal &&
            latest.userId === userId &&
            latest.sessionSignal === sessionSignal &&
            !latest.disabled &&
            !sessionSignal.aborted
          )
            void resource.current?.run();
        }}
      >
        Скачать весь план
      </Button>
      {value?.busy && (
        <Button variant="ghost" onClick={() => resource.current?.cancel()}>
          Отменить скачивание
        </Button>
      )}
      {value?.error && <p role="alert">{value.error}</p>}
    </div>
  );
}
