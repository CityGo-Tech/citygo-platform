"use client";
import * as React from "react";
import { Button } from "@citygo/ui-web";
import { aiModeLabels, type AiModeId, type AiModes } from "@citygo/contracts";
import { aiModeDescriptions, selectableAiMode } from "./ai-mode-picker-state";
import styles from "./ai-mode-selector.module.css";

export function AiModeSelector({
  modes,
  selected,
  disabled,
  onSelect,
  className = "",
}: {
  modes?: AiModes;
  selected: AiModeId;
  disabled: boolean;
  onSelect: (mode: AiModeId) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLDivElement>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const id = React.useId();
  const canOpen = !!modes && !disabled;
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }
  React.useEffect(() => {
    if (!open) return;
    if (!canOpen) {
      dialog.current?.close();
      setOpen(false);
      return;
    }
    const current = dialog.current;
    if (!current) return;
    if (!current.open) current.showModal();
    const chosen = current.querySelector<HTMLButtonElement>(
      '[aria-pressed="true"]:not(:disabled)',
    );
    (
      chosen ??
      current.querySelector<HTMLButtonElement>("[aria-pressed]:not(:disabled)")
    )?.focus();
    return () => {
      if (current.open) current.close();
    };
  }, [open, canOpen]);
  if (!modes) return null;
  return (
    <div ref={trigger} className={`${styles.root} ${className}`}>
      <Button
        type="button"
        variant="secondary"
        className={`${styles.trigger} ym-show-content`}
        aria-label="Режим работы"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        data-ai-mode={selected}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className={styles.triggerLabel}>Режим работы</span>
        <span className={styles.triggerValue}>{aiModeLabels[selected]}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
      <dialog
        ref={dialog}
        id={id}
        className={styles.dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const panel = event.currentTarget;
          const actions = Array.from(
            panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const first = actions[0];
          const last = actions.at(-1);
          if (!first || !last) return;
          const active = panel.ownerDocument.activeElement;
          if (
            event.shiftKey
              ? active === first || !panel.contains(active)
              : active === last || !panel.contains(active)
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            close();
        }}
      >
        <h2 id={`${id}-title`} className={styles.title}>
          Режим работы
        </h2>
        <p className={styles.current}>Сейчас: {aiModeLabels[selected]}</p>
        <div
          className={styles.options}
          role="group"
          aria-label="Выберите режим"
        >
          {modes.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={styles.option}
              aria-label={option.label}
              aria-pressed={selected === option.id}
              aria-describedby={`${id}-${option.id}`}
              disabled={disabled || !option.available}
              onClick={() => {
                if (!selectableAiMode(modes, option.id, disabled)) return;
                close();
                onSelect(option.id);
              }}
            >
              <span className={styles.optionHeading}>
                <strong>{option.label}</strong>
                <span className={styles.check} aria-hidden="true">
                  {selected === option.id ? "✓" : ""}
                </span>
              </span>
              <span className={styles.description} id={`${id}-${option.id}`}>
                {aiModeDescriptions[option.id]}
              </span>
              {!option.available && (
                <span className={styles.unavailable}>Временно недоступен</span>
              )}
            </button>
          ))}
        </div>
        <p id={`${id}-hint`} className={styles.hint}>
          Для следующего сообщения. История и черновик сохранятся.
        </p>
        <Button
          type="button"
          variant="secondary"
          className={styles.close}
          onClick={close}
        >
          Закрыть
        </Button>
      </dialog>
    </div>
  );
}
