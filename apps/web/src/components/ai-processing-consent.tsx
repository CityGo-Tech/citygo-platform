"use client";
import { useEffect, useId, useRef } from "react";
import type { AiAccess, AiPolicy } from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import styles from "./ai-processing-consent.module.css";

function ProcessingTerms({ policy }: { policy: AiPolicy }) {
  return (
    <details key={policy.id} className={styles.terms}>
      <summary>Условия обработки сообщений</summary>
      <div>
        <p>Обработку выполняет {policy.recipient}.</p>
        <p>{policy.routing}</p>
        <p>{policy.data}</p>
      </div>
    </details>
  );
}

/** Mount only for an explicit send intent. Opening never records consent. */
export function AiProcessingConsentDialog({
  policy,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  policy: AiPolicy;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  useEffect(() => {
    const current = dialog.current;
    if (!current) return;
    current.showModal();
    return () => current.close();
  }, [policy.id]);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={heading}
      aria-describedby={description}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={heading}>Обработка сообщений</h2>
      <p id={description}>
        Разрешите обработку ваших сообщений, чтобы помощник мог ответить.
        Нажимая «Разрешить и отправить», вы даёте согласие на эту обработку.
      </p>
      <ProcessingTerms policy={policy} />
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Сохраняем согласие…</p>}
      <div className={styles.actions}>
        <Button type="button" disabled={busy} onClick={onConfirm}>
          Разрешить и отправить
        </Button>
        <Button type="button" variant="ghost" autoFocus onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </dialog>
  );
}

/** Current processing terms remain available in account consent settings. */
export function AiProcessingSettings({
  access,
  busy,
  onRevoke,
}: {
  access: AiAccess;
  busy: boolean;
  onRevoke: () => void;
}) {
  const heading = useId();
  return (
    <section className={styles.settings} aria-labelledby={heading}>
      <h2 id={heading}>Обработка сообщений</h2>
      <p>
        {access.granted
          ? "Согласие на обработку сообщений дано."
          : "Согласие можно дать при отправке сообщения помощнику."}
      </p>
      {access.policy && <ProcessingTerms policy={access.policy} />}
      {access.granted && (
        <>
          <p>После отзыва новые ответы будут недоступны. История сохранится.</p>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onRevoke}
          >
            Отозвать согласие на обработку сообщений
          </Button>
        </>
      )}
    </section>
  );
}
