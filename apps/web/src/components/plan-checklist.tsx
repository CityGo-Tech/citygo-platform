"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createClient,
  createPlanChecklistResource,
  type PlanChecklistState,
} from "@citygo/api-client";
import type { PlanChecklistEntry } from "@citygo/contracts";
import { Button, Field } from "@citygo/ui-web";
import styles from "./plan-checklist.module.css";
export function PlanItemChecklist({
  userId,
  itemId,
  sessionSignal,
  disabled,
  onAccessDenied,
  onSaved,
}: {
  userId: string;
  itemId: string;
  sessionSignal: AbortSignal;
  disabled: boolean;
  onAccessDenied: () => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    item: string;
    signal: AbortSignal;
    state: PlanChecklistState;
  } | null>(null);
  const [editor, setEditor] = useState<{
    id: string;
    title: string;
    details: string;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const resource = useRef<ReturnType<
    typeof createPlanChecklistResource
  > | null>(null);
  const handlers = useRef({ onAccessDenied, onSaved });
  handlers.current = { onAccessDenied, onSaved };
  useEffect(() => {
    if (!open) return;
    setEditor(null);
    setRemoving(null);
    const control = new AbortController();
    const signal = AbortSignal.any([control.signal, sessionSignal]);
    const api = (request: AbortSignal) =>
      createClient("/api", { signal: () => request });
    const current = createPlanChecklistResource({
      userId,
      itemId,
      sessionSignal: signal,
      client: {
        get: (request) => api(request).planChecklist(itemId),
        save: (revision, entries, request) =>
          api(request).savePlanChecklist(itemId, {
            expectedRevision: revision,
            entries,
          }),
      },
      publish: (state) =>
        setSnapshot({
          owner: userId,
          item: itemId,
          signal: sessionSignal,
          state,
        }),
      onAccessDenied: () => handlers.current.onAccessDenied(),
      onSaved: () => handlers.current.onSaved(),
    });
    resource.current = current;
    void current.load();
    return () => {
      current.dispose();
      control.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, itemId, sessionSignal, open]);
  const current =
    snapshot?.owner === userId &&
    snapshot.item === itemId &&
    snapshot.signal === sessionSignal &&
    !sessionSignal.aborted
      ? snapshot.state
      : null;
  const entries = current?.value?.entries ?? [];
  const blocked =
    disabled || !current?.value || current.busy || current.needsRefresh;
  if (sessionSignal.aborted || current?.closed) return null;
  async function save(items: PlanChecklistEntry[]) {
    if (blocked) return;
    if (await resource.current?.save(items)) {
      setEditor(null);
      setRemoving(null);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor || !editor.title.trim() || blocked) return;
    const existing = entries.find((entry) => entry.id === editor.id);
    const next = { ...editor, completed: existing?.completed ?? false };
    void save(
      existing
        ? entries.map((entry) => (entry.id === editor.id ? next : entry))
        : [...entries, next],
    );
  }
  return (
    <section
      className={styles.panel + " ym-hide-content"}
      aria-label="Чек-лист шага"
    >
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Скрыть чек-лист" : "Чек-лист"}
      </Button>
      {open && (
        <div className={styles.content}>
          <h3>Чек-лист</h3>
          <p className={styles.intro}>
            Разбейте шаг на небольшие действия и отмечайте готовое.
          </p>
          {current?.error && <p role="alert">{current.error}</p>}
          {current?.busy && (
            <p role="status">Сохраняем и обновляем чек-лист…</p>
          )}
          {(!current?.value || current?.needsRefresh || current?.error) && (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || !!current?.busy}
              onClick={() => {
                setEditor(null);
                setRemoving(null);
                void resource.current?.load();
              }}
            >
              Обновить чек-лист
            </Button>
          )}
          {current?.value && (
            <>
              <p className={styles.count}>
                Готово {entries.filter((entry) => entry.completed).length} из{" "}
                {entries.length}
              </p>
              <ul className={styles.list}>
                {entries.map((entry) => (
                  <li key={entry.id} className={styles.row}>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={entry.completed}
                        disabled={blocked}
                        onChange={() =>
                          void save(
                            entries.map((value) =>
                              value.id === entry.id
                                ? { ...value, completed: !value.completed }
                                : value,
                            ),
                          )
                        }
                      />
                      <strong>{entry.title}</strong>
                    </label>
                    {entry.details && (
                      <p className={styles.details}>{entry.details}</p>
                    )}
                    <div className={styles.actions}>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={blocked || !!editor}
                        onClick={() => {
                          setEditor({
                            id: entry.id,
                            title: entry.title,
                            details: entry.details,
                          });
                          setRemoving(null);
                        }}
                      >
                        Изменить пункт
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={blocked || !!editor}
                        onClick={() => setRemoving(entry.id)}
                      >
                        Удалить пункт
                      </Button>
                    </div>
                    {removing === entry.id && (
                      <div className={styles.actions}>
                        <span>Удалить пункт?</span>
                        <Button
                          type="button"
                          disabled={blocked}
                          onClick={() =>
                            void save(
                              entries.filter((value) => value.id !== entry.id),
                            )
                          }
                        >
                          Подтвердить удаление пункта
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!!current.busy}
                          onClick={() => setRemoving(null)}
                        >
                          Оставить пункт
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {!entries.length && (
                <p>Пунктов пока нет. Добавьте первое действие.</p>
              )}
              {editor ? (
                <form className={styles.editor} onSubmit={submit}>
                  <Field
                    className="ym-disable-keys ym-hide-content"
                    label="Название пункта"
                    maxLength={120}
                    required
                    value={editor.title}
                    disabled={blocked}
                    onChange={(event) =>
                      setEditor({ ...editor, title: event.target.value })
                    }
                  />
                  <label>
                    Подробности пункта
                    <textarea
                      className="ym-disable-keys ym-hide-content"
                      maxLength={1000}
                      value={editor.details}
                      disabled={blocked}
                      onChange={(event) =>
                        setEditor({ ...editor, details: event.target.value })
                      }
                    />
                  </label>
                  <div className={styles.actions}>
                    <Button
                      type="submit"
                      disabled={blocked || !editor.title.trim()}
                    >
                      Сохранить пункт
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!!current.busy}
                      onClick={() => setEditor(null)}
                    >
                      Отмена пункта
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={blocked || entries.length >= 20}
                  onClick={() => {
                    setRemoving(null);
                    setEditor({
                      id: crypto.randomUUID(),
                      title: "",
                      details: "",
                    });
                  }}
                >
                  Добавить пункт
                </Button>
              )}
              {entries.length >= 20 && (
                <p>В одном шаге можно сохранить до 20 пунктов.</p>
              )}
              <p className={styles.intro}>
                Отметки сохраняются отдельно. Завершить сам шаг можно кнопкой
                «Отметить выполненным».
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
