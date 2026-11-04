"use client";
import { forwardRef, useState, type TextareaHTMLAttributes } from "react";
import {
  CHAT_CHARACTER_LIMIT_LABEL,
  CHAT_MAX_UTF16_UNITS,
  chatCharacterCount,
  chatTextError,
} from "@citygo/contracts";
import styles from "./chat-textarea.module.css";

type Props = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "maxLength"
> & { id: string; value: string };

/** Invalid text stays editable; native maxLength must never cut pasted text. */
export const ChatTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function ChatTextarea(
    { value, id, className, onChange, onPaste, ...props },
    ref,
  ) {
    const [pasteRejected, setPasteRejected] = useState(false);
    const error = pasteRejected
      ? `Не удалось вставить текст. В сообщении можно отправить до ${CHAT_CHARACTER_LIMIT_LABEL} символов. Сократите текст и вставьте его снова.`
      : chatTextError(value);
    const count =
      value.length <= CHAT_MAX_UTF16_UNITS ? chatCharacterCount(value) : null;
    const statusId = id + "-length";
    const showStatus = Boolean(error) || (count !== null && count >= 1000);
    return (
      <>
        <textarea
          {...props}
          ref={ref}
          id={id}
          value={value}
          className={[styles.input, className].filter(Boolean).join(" ")}
          aria-invalid={Boolean(error)}
          aria-describedby={[props["aria-describedby"], showStatus && statusId]
            .filter(Boolean)
            .join(" ")}
          onChange={(event) => {
            setPasteRejected(false);
            onChange?.(event);
          }}
          onPaste={(event) => {
            onPaste?.(event);
            if (event.defaultPrevented) return;
            const insertion = event.clipboardData.getData("text/plain");
            const replaced =
              event.currentTarget.selectionEnd -
              event.currentTarget.selectionStart;
            if (
              value.length - replaced + insertion.length >
              CHAT_MAX_UTF16_UNITS
            ) {
              event.preventDefault();
              setPasteRejected(true);
            }
          }}
        />
        {showStatus && (
          <small
            id={statusId}
            className={[styles.status, error && styles.error]
              .filter(Boolean)
              .join(" ")}
            role={error ? "alert" : undefined}
            aria-live="polite"
          >
            {error ??
              (count !== null && count >= 1000
                ? `${count.toLocaleString("ru-RU")} / ${CHAT_CHARACTER_LIMIT_LABEL} символов`
                : "")}
          </small>
        )}
      </>
    );
  },
);
