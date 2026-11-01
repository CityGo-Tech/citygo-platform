"use client";
import { useEffect, useRef } from "react";
import { Button, Card } from "@citygo/ui-web";
import {
  createLogoutDecision,
  currentLogoutConfirmation,
  type LogoutConfirmationIntent,
} from "./logout-confirmation-state";
import styles from "./assistant-handoff.module.css";
import logoutStyles from "./logout-confirmation.module.css";

/** Figma 6:70: an explicit exit choice; cancelling leaves the cabinet intact. */
export function LogoutConfirmation({
  intent,
  owner,
  sessionSignal,
  onConfirm,
  onClose,
}: {
  intent: LogoutConfirmationIntent;
  owner: string;
  sessionSignal: AbortSignal;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const decision = useRef<ReturnType<typeof createLogoutDecision> | null>(null);
  const current = useRef({ owner, sessionSignal, onConfirm, onClose });
  current.current = { owner, sessionSignal, onConfirm, onClose };
  useEffect(() => {
    const element = dialog.current;
    const active = () =>
      currentLogoutConfirmation(
        intent,
        current.current.owner,
        current.current.sessionSignal,
      );
    const closeDialog = () => {
      element?.close();
      current.current.onClose();
      requestAnimationFrame(() => {
        if (active() && intent.trigger?.isConnected)
          intent.trigger.focus({ preventScroll: true });
      });
    };
    const action = createLogoutDecision({
      current: active,
      onClose: closeDialog,
      onConfirm: () => current.current.onConfirm(),
    });
    decision.current = action;
    if (active()) {
      element?.showModal();
      element?.querySelector<HTMLButtonElement>("[data-logout-stay]")?.focus();
    }
    const aborted = closeDialog;
    intent.ticket.signal.addEventListener("abort", aborted, { once: true });
    return () => {
      action.dispose();
      intent.ticket.signal.removeEventListener("abort", aborted);
      element?.close();
      if (decision.current === action) decision.current = null;
    };
  }, [intent]);
  if (!currentLogoutConfirmation(intent, owner, sessionSignal)) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="logout-confirmation-title"
      aria-describedby="logout-confirmation-description"
      className={styles.dialog + " ym-hide-content ym-disable-keys"}
      data-citygo-private
      onCancel={(event) => {
        event.preventDefault();
        decision.current?.cancel();
      }}
    >
      <Card className={styles.card}>
        <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
        <h2 id="logout-confirmation-title">Выйти из аккаунта?</h2>
        <p id="logout-confirmation-description">
          После выхода история и личные данные не будут видны на этом
          устройстве.
        </p>
        <div className={styles.context + " " + logoutStyles.notice}>
          <strong>План не исчезнет из аккаунта</strong>
          <p>
            При следующем входе вернётесь к сохранённым данным. Несохранённый
            текст после выхода не восстановится.
          </p>
        </div>
        <div className={styles.actions}>
          <Button onClick={() => decision.current?.confirm()}>Выйти</Button>
          <Button
            variant="secondary"
            data-logout-stay
            onClick={() => decision.current?.cancel()}
          >
            Остаться
          </Button>
        </div>
      </Card>
    </dialog>
  );
}
