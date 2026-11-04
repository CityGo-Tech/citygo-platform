"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@citygo/ui-web";
import {
  createTextMaterialResource,
  sameTextMaterialScope,
  TEXT_MESSAGE_MAX_LENGTH,
  type TextMaterialContext,
  type TextMaterialScope,
  type TextMaterialView,
} from "./text-material-state";
import {
  CHAT_CHARACTER_LIMIT_LABEL,
  CHAT_MAX_UTF16_UNITS,
  chatCharacterCount,
} from "@citygo/contracts";
import styles from "./text-material-preview.module.css";

export function TextMaterialPreview({
  userId,
  threadId,
  sessionSignal,
  draft,
  disabled,
  onDraft,
}: {
  userId: string;
  threadId: string;
  sessionSignal: AbortSignal;
  draft: string;
  disabled: boolean;
  onDraft: (text: string) => void;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const latest = useRef<TextMaterialContext & { apply: typeof onDraft }>({
    userId,
    threadId,
    sessionSignal,
    draft,
    enabled: !disabled,
    apply: onDraft,
  });
  latest.current = {
    userId,
    threadId,
    sessionSignal,
    draft,
    enabled: !disabled,
    apply: onDraft,
  };
  const [scope, setScope] = useState<TextMaterialScope | null>(null);
  const available =
    !!scope &&
    !sessionSignal.aborted &&
    !disabled &&
    sameTextMaterialScope(scope, latest.current);
  useEffect(() => {
    if (!available) setScope(null);
  }, [available]);
  return (
    <>
      <span ref={trigger}>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || sessionSignal.aborted}
          onClick={() => setScope({ userId, threadId, sessionSignal })}
        >
          Прикрепить материал
        </Button>
      </span>
      {scope && available && (
        <TextMaterialDialog
          scope={scope}
          current={() => latest.current}
          onApply={(text) => latest.current.apply(text)}
          onClose={() => setScope(null)}
          onRestore={() => {
            if (
              !scope.sessionSignal.aborted &&
              sameTextMaterialScope(scope, latest.current)
            )
              trigger.current?.querySelector("button")?.focus();
          }}
          draftLength={
            draft.length > CHAT_MAX_UTF16_UNITS
              ? null
              : chatCharacterCount(draft)
          }
        />
      )}
    </>
  );
}

function TextMaterialDialog({
  scope,
  current,
  onApply,
  onClose,
  onRestore,
  draftLength,
}: {
  scope: TextMaterialScope;
  current: () => TextMaterialContext;
  onApply: (text: string) => void;
  onClose: () => void;
  onRestore: () => void;
  draftLength: number | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const fileChoice = useRef<HTMLSpanElement>(null);
  const [view, setView] = useState<TextMaterialView>({ phase: "select" });
  const callbacks = useRef({ current, onApply, onClose, onRestore });
  callbacks.current = { current, onApply, onClose, onRestore };
  const resource = useRef<ReturnType<typeof createTextMaterialResource> | null>(
    null,
  );
  useEffect(() => {
    const reader = createTextMaterialResource({
      scope,
      current: () => callbacks.current.current(),
      publish: setView,
      apply: (text) => callbacks.current.onApply(text),
    });
    resource.current = reader;
    const element = dialog.current;
    element?.showModal();
    title.current?.focus();
    const aborted = () => callbacks.current.onClose();
    scope.sessionSignal.addEventListener("abort", aborted, { once: true });
    return () => {
      reader.dispose();
      if (resource.current === reader) resource.current = null;
      scope.sessionSignal.removeEventListener("abort", aborted);
      element?.close();
      callbacks.current.onRestore();
    };
  }, [scope]);
  const preview = view.phase === "preview" ? view : null;
  const reading = view.phase === "reading";
  const close = () => {
    resource.current?.dispose();
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog + " ym-hide-content"}
      aria-labelledby="text-material-title"
      aria-describedby="text-material-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={styles.card}>
        <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
        <h2 id="text-material-title" ref={title} tabIndex={-1}>
          {preview
            ? "Предпросмотр материала"
            : "Прикрепить материал к разговору"}
        </h2>
        <p id="text-material-description">
          {preview
            ? "Проверьте и при необходимости измените текст перед добавлением."
            : "Резюме или пример условий лучше сначала проверить на лишние данные."}
        </p>
        <aside className={styles.notice}>
          <strong>Файл не отправлен</strong>
          <p>
            Проверьте текст и уберите лишние данные. Материал добавится в ваше
            сообщение; отправить его можно обычной кнопкой «Отправить».
          </p>
        </aside>
        {preview ? (
          <section className={styles.file} aria-label="Текст материала">
            <span className={styles.eyebrow}>ПРОСМОТР ПЕРЕД ОТПРАВКОЙ</span>
            <h3>{preview.filename}</h3>
            <label htmlFor="text-material-content">
              {preview.format === "pdf"
                ? "Текст из PDF-файла"
                : "Текст из TXT-файла"}
            </label>
            {preview.format === "pdf" && (
              <p>
                PDF: {preview.pages} стр. Оставьте нужный фрагмент для вашего
                вопроса. Форматирование и порядок текста могут отличаться от
                документа.
              </p>
            )}
            <textarea
              id="text-material-content"
              className="ym-disable-keys ym-hide-content"
              value={preview.text}
              rows={9}
              onChange={(event) => resource.current?.edit(event.target.value)}
              aria-describedby="text-material-count"
            />
            <small id="text-material-count">
              Вопрос и материал:{" "}
              {draftLength === null ||
              preview.text.length > CHAT_MAX_UTF16_UNITS * 2
                ? "больше допустимого"
                : (
                    draftLength +
                    (draftLength ? 2 : 0) +
                    10 +
                    chatCharacterCount(preview.text)
                  ).toLocaleString("ru-RU")}
              /{TEXT_MESSAGE_MAX_LENGTH.toLocaleString("ru-RU")} символов с
              заголовком «Материал».
            </small>
          </section>
        ) : (
          <section className={styles.file} aria-label="Выбор файла">
            <span className={styles.eyebrow}>ПРОСМОТР ПЕРЕД ОТПРАВКОЙ</span>
            <h3>Текстовый материал</h3>
            <label htmlFor="text-material-file">
              TXT до 1 МБ или PDF с текстом до 8 МБ и 50 страниц
            </label>
            <input
              ref={file}
              id="text-material-file"
              type="file"
              hidden
              className="ym-disable-keys ym-hide-content"
              accept=".txt,.pdf,text/plain,application/pdf"
              disabled={reading}
              onChange={(event) => {
                const selected = event.target.files?.[0];
                event.target.value = "";
                if (selected) void resource.current?.select(selected);
              }}
            />
            <span ref={fileChoice}>
              <Button
                type="button"
                disabled={reading}
                onClick={() => file.current?.click()}
              >
                Выбрать файл
              </Button>
            </span>
            <p>
              Сканы и PDF с паролем не поддерживаются. После проверки оставьте
              фрагмент: вопрос вместе с материалом — до{" "}
              {CHAT_CHARACTER_LIMIT_LABEL} символов.
            </p>
            {reading && <p role="status">Читаем текст…</p>}
          </section>
        )}
        {"error" in view && view.error && (
          <p className={styles.error} role="alert">
            {view.error}
          </p>
        )}
        <div className={styles.actions}>
          {preview && (
            <Button
              type="button"
              onClick={() => {
                if (resource.current?.confirm()) onClose();
              }}
            >
              Добавить в сообщение
            </Button>
          )}
          {preview || reading ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                resource.current?.back();
                requestAnimationFrame(() =>
                  fileChoice.current?.querySelector("button")?.focus(),
                );
              }}
            >
              Назад к выбору
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={close}>
            Вернуться к разговору
          </Button>
        </div>
      </Card>
    </dialog>
  );
}
