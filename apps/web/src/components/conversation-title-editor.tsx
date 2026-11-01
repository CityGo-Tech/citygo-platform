"use client";
import { useEffect, useRef, useState } from "react";
import type { ConversationTitle } from "@citygo/contracts";
import { conversationCustomTitleSchema } from "@citygo/contracts";
import { createClient } from "@citygo/api-client";
import { Button, Card, Field } from "@citygo/ui-web";
import {
  createConversationTitleEditor,
  type TitleEditorState,
} from "./conversation-title-editor-state";
import styles from "./conversation-title-editor.module.css";
export type TitleEditorSource = {
  userId: string;
  threadId: string;
  signal: AbortSignal;
  opener: HTMLButtonElement;
};
export function ConversationTitleEditor({
  source,
  busy,
  onSaved,
  onClose,
  onAccessDenied,
}: {
  source: TitleEditorSource;
  busy: boolean;
  onSaved: (title: ConversationTitle) => void;
  onClose: () => void;
  onAccessDenied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<TitleEditorState>({
    pending: true,
    value: null,
    error: "",
    conflict: false,
  });
  const [text, setText] = useState("");
  const editor = useRef<ReturnType<
    typeof createConversationTitleEditor
  > | null>(null);
  const seenRevision = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onSaved, onClose, onAccessDenied });
  callbacks.current = { onSaved, onClose, onAccessDenied };
  useEffect(() => {
    const element = dialog.current;
    const abort = new AbortController();
    const signal = AbortSignal.any([source.signal, abort.signal]);
    const client = createClient("/api", { signal: () => signal });
    const value = createConversationTitleEditor(
      client,
      source.userId,
      source.threadId,
      signal,
      (next) => {
        setState(next);
        if (next.value && next.value.revision !== seenRevision.current) {
          seenRevision.current = next.value.revision;
          setText(next.value.title ?? "");
        }
      },
      () => callbacks.current.onAccessDenied(),
    );
    editor.current = value;
    element?.showModal();
    heading.current?.focus();
    void value.load();
    const ended = () => callbacks.current.onClose();
    source.signal.addEventListener("abort", ended, { once: true });
    return () => {
      value.close();
      abort.abort();
      source.signal.removeEventListener("abort", ended);
      element?.close();
      if (source.opener.isConnected) source.opener.focus();
    };
  }, [source]);
  if (source.signal.aborted) return null;
  // Once a write has started, wait for its result rather than present a
  // cancelled form while the server may still be committing that write.
  const saving = state.pending && state.value !== null;
  const close = () => {
    if (!saving) callbacks.current.onClose();
  };
  const save = async (title: string | null) => {
    if (busy || state.pending || state.conflict || !state.value) return;
    const value = await editor.current?.save(title);
    if (!value || source.signal.aborted) return;
    callbacks.current.onSaved(value);
    callbacks.current.onClose();
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="conversation-title-heading"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={styles.card}>
        <h2 id="conversation-title-heading" ref={heading} tabIndex={-1}>
          Название разговора
        </h2>
        {state.pending && !state.value ? (
          <p role="status">Загружаем название…</p>
        ) : (
          state.value && (
            <form
              className="ym-hide-content"
              onSubmit={(event) => {
                event.preventDefault();
                const title = conversationCustomTitleSchema.safeParse(text);
                if (title.success) void save(title.data);
              }}
            >
              <Field
                label="Название"
                className="ym-disable-keys"
                value={text}
                maxLength={80}
                required
                disabled={state.pending || busy || state.conflict}
                onChange={(event) => setText(event.target.value)}
              />
              <div className={styles.actions}>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    state.pending ||
                    state.conflict ||
                    !conversationCustomTitleSchema.safeParse(text).success ||
                    text.trim() === state.value.title
                  }
                >
                  Сохранить
                </Button>
                {state.value.title !== null && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || state.pending || state.conflict}
                    onClick={() => void save(null)}
                  >
                    Вернуть исходное название
                  </Button>
                )}
              </div>
            </form>
          )
        )}
        {state.error && <p role="alert">{state.error}</p>}
        {(state.conflict || (!state.value && !state.pending)) && (
          <Button
            variant="secondary"
            disabled={state.pending}
            onClick={() => void editor.current?.load()}
          >
            Обновить название
          </Button>
        )}
        <Button variant="ghost" disabled={saving} onClick={close}>
          Отмена
        </Button>
      </Card>
    </dialog>
  );
}
