"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type {
  CreatePersonalMemoryItem,
  PersonalMemoryItem,
  UpdatePersonalMemoryItem,
} from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import type { PlanMessageSource } from "./personal-plan";
import styles from "./personal-memory.module.css";

type OwnerProps = {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
};
type MemoryFields = { label: string; value: string };
const excerpt = (text: string, limit: number) =>
  text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");

function MemoryEditor({
  label,
  value,
  disabled,
  onChange,
}: MemoryFields & {
  disabled: boolean;
  onChange: (fields: MemoryFields) => void;
}) {
  const valueId = useId();
  return (
    <>
      <Field
        label="О чём это"
        value={label}
        maxLength={80}
        required
        disabled={disabled}
        onChange={(event) => onChange({ label: event.target.value, value })}
      />
      <div className={styles.valueField}>
        <label htmlFor={valueId}>Что запомнить</label>
        <textarea
          id={valueId}
          value={value}
          maxLength={800}
          required
          rows={5}
          disabled={disabled}
          onChange={(event) => onChange({ label, value: event.target.value })}
        />
      </div>
    </>
  );
}

/** A preview is not confirmation. Only the explicit submit creates memory. */
export function PersonalMemoryComposer({
  userId,
  sessionSignal,
  onAccessDenied,
  source,
  onSaved,
  onCancel,
}: OwnerProps & {
  source: PlanMessageSource;
  onSaved: () => void;
  onCancel: (checkMemory: boolean) => void;
}) {
  const text = source.content.trim();
  const [fields, setFields] = useState<MemoryFields>({
    label: excerpt(text.split(/\r?\n/)[0] ?? "", 80),
    value: excerpt(text, 800),
  });
  const [frozen, setFrozen] = useState<CreatePersonalMemoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submit, setSubmit] = useState<(() => Promise<void>) | null>(null);
  const currentFields = useRef(fields);
  currentFields.current = fields;
  const callbacks = useRef({ onSaved, onAccessDenied });
  callbacks.current = { onSaved, onAccessDenied };
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    let pending = false;
    let request: CreatePersonalMemoryItem | null = null;
    const send = async () => {
      if (pending || signal.aborted) return;
      if (!request) {
        const value = currentFields.current;
        if (!value.label.trim() || !value.value.trim()) return;
        request = {
          operationId: crypto.randomUUID(),
          sourceMessageId: source.messageId,
          label: value.label.trim(),
          value: value.value.trim(),
          confirmed: true,
        };
      }
      const payload = request;
      pending = true;
      setFrozen(payload);
      setBusy(true);
      setError("");
      try {
        const result = await api.createPersonalMemoryItem(payload);
        if (signal.aborted) return;
        if (result.userId !== userId) {
          controller.abort();
          callbacks.current.onAccessDenied();
          return;
        }
        if (
          result.item.source.messageId !== source.messageId ||
          result.item.source.threadId !== source.threadId ||
          result.item.source.role !== source.role
        )
          throw new Error("Memory receipt source mismatch");
        callbacks.current.onSaved();
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          controller.abort();
          callbacks.current.onAccessDenied();
        } else {
          setError(
            "Не удалось подтвердить сохранение. Запись уже могла сохраниться. Повторите тот же запрос или закройте форму и проверьте память перед новой записью.",
          );
        }
      } finally {
        pending = false;
        if (!signal.aborted) setBusy(false);
      }
    };
    setSubmit(() => send);
    heading.current?.focus({ preventScroll: true });
    return () => controller.abort();
  }, [userId, sessionSignal, source.messageId, source.threadId, source.role]);

  if (sessionSignal.aborted) return null;
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void submit?.();
  };
  return (
    <section
      className={styles.composer}
      aria-label="Сохранение в память"
      aria-busy={busy}
    >
      <h2 ref={heading} tabIndex={-1}>
        Сохранить в память
      </h2>
      <p>
        Помощники смогут учитывать это в следующих ответах. Проверьте текст.
      </p>
      {text.length > 800 && (
        <small>
          Перенесены первые 800 символов. Исходное сообщение останется в
          диалоге.
        </small>
      )}
      <form onSubmit={confirm}>
        <MemoryEditor
          {...fields}
          disabled={busy || !!frozen}
          onChange={setFields}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            type="submit"
            disabled={
              busy || !submit || !fields.label.trim() || !fields.value.trim()
            }
          >
            {busy
              ? "Сохраняем…"
              : frozen
                ? "Повторить тот же запрос"
                : "Подтвердить и сохранить"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onCancel(!!frozen)}
          >
            {frozen ? "Закрыть и проверить память" : "Отмена"}
          </Button>
        </div>
      </form>
    </section>
  );
}

type MemoryActions = {
  load: () => Promise<void>;
  update: (
    item: PersonalMemoryItem,
    value: UpdatePersonalMemoryItem,
  ) => Promise<void>;
  remove: (item: PersonalMemoryItem) => Promise<void>;
};

export function PersonalMemoryPanel({
  userId,
  sessionSignal,
  onAccessDenied,
  onOpenConversation,
  onContinue,
  navigationBusy = false,
}: OwnerProps & {
  onOpenConversation: (threadId: string) => Promise<boolean>;
  onContinue: () => void;
  navigationBusy?: boolean;
}) {
  const [items, setItems] = useState<PersonalMemoryItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [editing, setEditing] = useState<PersonalMemoryItem | null>(null);
  const [fields, setFields] = useState<MemoryFields>({ label: "", value: "" });
  const [removing, setRemoving] = useState<PersonalMemoryItem | null>(null);
  const [actions, setActions] = useState<MemoryActions | null>(null);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const editorTitle = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    let pending = false;
    const active = () => !signal.aborted;
    const clearPrivateState = () => {
      setItems([]);
      setEditing(null);
      setRemoving(null);
      setFields({ label: "", value: "" });
    };
    const owner = (result: { userId: string }) => {
      if (result.userId === userId) return true;
      clearPrivateState();
      controller.abort();
      denied.current();
      return false;
    };
    const failure = (cause: unknown, mutation: boolean) => {
      if (!active()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        clearPrivateState();
        controller.abort();
        denied.current();
      } else {
        setNeedsRefresh(true);
        setError(
          cause instanceof ApiError && cause.status === 409
            ? "Запись уже изменена. Обновите память и проверьте актуальную версию."
            : mutation
              ? "Не удалось подтвердить изменение. Оно уже могло сохраниться. Обновите память перед следующим действием."
              : "Не удалось загрузить память. Попробуйте обновить список.",
        );
      }
    };
    const load = async () => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.listPersonalMemory();
        if (!active() || !owner(result)) return;
        setItems(result.items);
        setNeedsRefresh(false);
        setEditing(null);
        setRemoving(null);
        setFields({ label: "", value: "" });
      } catch (cause) {
        failure(cause, false);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    const update = async (
      item: PersonalMemoryItem,
      value: UpdatePersonalMemoryItem,
    ) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.updatePersonalMemoryItem(item.id, value);
        if (!active() || !owner(result)) return;
        if (
          result.item.id !== item.id ||
          result.item.source.messageId !== item.source.messageId ||
          result.item.source.threadId !== item.source.threadId ||
          result.item.source.role !== item.source.role
        )
          throw new Error("Memory correction source mismatch");
        setItems((current) =>
          current.map((old) => (old.id === item.id ? result.item : old)),
        );
        setEditing(null);
      } catch (cause) {
        failure(cause, true);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    const remove = async (item: PersonalMemoryItem) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.removePersonalMemoryItem(
          item.id,
          item.revision,
        );
        if (!active() || !owner(result)) return;
        if (result.itemId !== item.id || result.removed !== true)
          throw new Error("Memory removal receipt mismatch");
        setItems((current) => current.filter((old) => old.id !== item.id));
        setRemoving(null);
      } catch (cause) {
        failure(cause, true);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    setActions({ load, update, remove });
    void load();
    return () => controller.abort();
  }, [userId, sessionSignal]);

  useEffect(() => {
    if (editing) editorTitle.current?.focus({ preventScroll: true });
  }, [editing]);
  if (sessionSignal.aborted) return null;
  const disabled = busy || needsRefresh || navigationBusy || !actions;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editing || disabled || !fields.label.trim() || !fields.value.trim())
      return;
    void actions?.update(editing, {
      expectedRevision: editing.revision,
      label: fields.label.trim(),
      value: fields.value.trim(),
      confirmed: true,
    });
  };
  return (
    <Card
      className={styles.panel}
      aria-label="Память разговора"
      aria-busy={busy}
    >
      <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1>Память разговора</h1>
      <p className={styles.intro}>
        Здесь — только то, что вы подтвердили. Помощники смогут учитывать эти
        сведения в следующих ответах. Можно исправить или удалить любую запись.
      </p>
      <div className={styles.toolbar}>
        <span className={styles.meta}>{items.length} ИЗ 20 ЗАПИСЕЙ</span>
        <Button
          variant="ghost"
          disabled={busy || navigationBusy}
          onClick={() => void actions?.load()}
        >
          Обновить память
        </Button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy || navigationBusy}
            onClick={() => void actions?.load()}
          >
            Обновить список
          </Button>
        </div>
      )}
      {busy && <p role="status">Обновляем память…</p>}
      {!busy && !error && !items.length && (
        <div className={styles.empty}>
          <p>
            Пока ничего не сохранено. Выберите сообщение в диалоге и нажмите
            «Запомнить». Бюджет и срок могут оставаться неизвестными.
          </p>
          <Button disabled={navigationBusy} onClick={onContinue}>
            Открыть диалог
          </Button>
        </div>
      )}
      <ul className={styles.list} aria-label="Подтверждённые сведения">
        {items.map((item) => (
          <li key={item.id}>
            <article
              className={styles.item}
              aria-label={"Запись: " + item.label}
              data-memory-id={item.id}
            >
              <h2>{item.label}</h2>
              <p className={styles.value}>{item.value}</p>
              <span className={styles.meta}>ПОДТВЕРЖДЕНО ВАМИ</span>
              {editing?.id === item.id ? (
                <form className={styles.editor} onSubmit={save}>
                  <h3 ref={editorTitle} tabIndex={-1}>
                    Исправить запись
                  </h3>
                  <MemoryEditor
                    {...fields}
                    disabled={disabled}
                    onChange={setFields}
                  />
                  <div className={styles.actions}>
                    <Button
                      type="submit"
                      disabled={
                        disabled || !fields.label.trim() || !fields.value.trim()
                      }
                    >
                      Подтвердить исправление
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Отмена исправления
                    </Button>
                  </div>
                </form>
              ) : removing?.id === item.id ? (
                <div className={styles.editor}>
                  <p>
                    Удалить запись из памяти? Исходное сообщение и диалог
                    останутся.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      disabled={disabled}
                      onClick={() => void actions?.remove(item)}
                    >
                      Подтвердить удаление
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setRemoving(null)}
                    >
                      Отмена удаления
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={styles.actions}>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setEditing(item);
                      setRemoving(null);
                      setFields({ label: item.label, value: item.value });
                    }}
                  >
                    Исправить
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setRemoving(item);
                      setEditing(null);
                    }}
                  >
                    Удалить
                  </Button>
                </div>
              )}
              <Button
                className={styles.source}
                variant="ghost"
                disabled={busy || navigationBusy}
                onClick={() => void onOpenConversation(item.source.threadId)}
              >
                Открыть исходный диалог
              </Button>
            </article>
          </li>
        ))}
      </ul>
      <Button disabled={navigationBusy} onClick={onContinue}>
        Продолжить разговор
      </Button>
    </Card>
  );
}
