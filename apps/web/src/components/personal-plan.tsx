"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type {
  CreatePersonalPlanItem,
  PersonalPlanItem,
  UpdatePersonalPlanItem,
} from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import styles from "./personal-plan.module.css";

type OwnerProps = {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
};
export type PlanMessageSource = {
  messageId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
};
type StepFields = { title: string; details: string };

function StepEditor({
  title,
  details,
  disabled,
  onChange,
}: StepFields & {
  disabled: boolean;
  onChange: (value: StepFields) => void;
}) {
  const detailsId = useId();
  const detailsHintId = detailsId + "-hint";
  return (
    <>
      <Field
        label="Название шага"
        value={title}
        maxLength={120}
        required
        disabled={disabled}
        onChange={(event) => onChange({ title: event.target.value, details })}
      />
      <div className={styles.detailsLabel}>
        <label htmlFor={detailsId}>Описание шага</label>
        <textarea
          id={detailsId}
          aria-describedby={detailsHintId}
          value={details}
          maxLength={4000}
          rows={5}
          disabled={disabled}
          onChange={(event) => onChange({ title, details: event.target.value })}
        />
        <small id={detailsHintId}>
          До 4 000 символов. Можно оставить пустым.
        </small>
      </div>
    </>
  );
}

/** A deliberate user action, never an automatic interpretation of a message. */
export function PlanStepComposer({
  userId,
  sessionSignal,
  onAccessDenied,
  source,
  onSaved,
  onCancel,
}: OwnerProps & {
  source: PlanMessageSource;
  onSaved: () => void;
  onCancel: (checkPlan: boolean) => void;
}) {
  const [fields, setFields] = useState<StepFields>({
    title: source.content.trim().split(/\r?\n/)[0]!.slice(0, 120),
    details: source.content.slice(0, 4000),
  });
  const [frozen, setFrozen] = useState<CreatePersonalPlanItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submit, setSubmit] = useState<(() => Promise<void>) | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const callbacks = useRef({ onSaved, onAccessDenied });
  callbacks.current = { onSaved, onAccessDenied };
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    let pending = false;
    // Once submitted, retries retain both the operation ID and exact payload.
    // In particular, a delayed/invalid receipt must not enable a second create.
    let request: CreatePersonalPlanItem | null = null;
    const send = async () => {
      if (pending || signal.aborted) return;
      if (!request) {
        const value = fieldsRef.current;
        if (!value.title.trim()) return;
        request = {
          operationId: crypto.randomUUID(),
          sourceMessageId: source.messageId,
          title: value.title.trim(),
          details: value.details.trim(),
        };
      }
      const payload = request;
      setFrozen(payload);
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.createPersonalPlanItem(payload);
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
          throw new Error("Plan receipt owner or source mismatch");
        callbacks.current.onSaved();
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          controller.abort();
          callbacks.current.onAccessDenied();
        } else {
          setError(
            "Не удалось подтвердить добавление. Шаг уже мог сохраниться. Повторите тот же запрос или закройте форму и проверьте «Мой план» перед новым добавлением.",
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
      aria-label="Добавление шага в план"
      aria-busy={busy}
    >
      <h2 ref={heading} tabIndex={-1}>
        Добавить шаг в план
      </h2>
      <p>
        Выберите действие и уточните формулировку перед сохранением. Добавление
        шага не подтверждает достоверность ответа помощника.
      </p>
      {source.content.length > 4000 && (
        <small>
          В описание перенесены первые 4 000 символов сообщения. Исходный диалог
          сохранится по ссылке.
        </small>
      )}
      <form onSubmit={confirm}>
        <StepEditor
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
            disabled={busy || !submit || !fields.title.trim()}
          >
            {busy
              ? "Сохраняем…"
              : frozen
                ? "Повторить тот же запрос"
                : "Подтвердить добавление"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onCancel(!!frozen)}
          >
            {frozen ? "Закрыть и проверить план" : "Отмена"}
          </Button>
        </div>
      </form>
    </section>
  );
}

type PlanActions = {
  load: (before?: string) => Promise<void>;
  update: (
    item: PersonalPlanItem,
    value: UpdatePersonalPlanItem,
  ) => Promise<void>;
  remove: (item: PersonalPlanItem) => Promise<void>;
};

export function PersonalPlanPanel({
  userId,
  sessionSignal,
  onAccessDenied,
  onOpenConversation,
  onContinue,
  onHelpers,
  navigationBusy = false,
}: OwnerProps & {
  onOpenConversation: (threadId: string) => Promise<boolean>;
  onContinue: () => void;
  onHelpers: () => void;
  navigationBusy?: boolean;
}) {
  const [items, setItems] = useState<PersonalPlanItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [editing, setEditing] = useState<PersonalPlanItem | null>(null);
  const [fields, setFields] = useState<StepFields>({ title: "", details: "" });
  const [removing, setRemoving] = useState<PersonalPlanItem | null>(null);
  const [actions, setActions] = useState<PlanActions | null>(null);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const editorTitle = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    let pending = false;
    const active = () => !signal.aborted;
    const owner = (value: { userId: string }) => {
      if (value.userId !== userId) {
        setItems([]);
        setEditing(null);
        setRemoving(null);
        controller.abort();
        denied.current();
        return false;
      }
      return true;
    };
    const failure = (cause: unknown, mutation: boolean) => {
      if (!active()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setItems([]);
        setEditing(null);
        setRemoving(null);
        controller.abort();
        denied.current();
      } else {
        setNeedsRefresh(true);
        setError(
          cause instanceof ApiError && cause.status === 409
            ? "Шаг уже изменён. Обновите план и проверьте актуальную версию перед следующим действием."
            : mutation
              ? "Не удалось подтвердить изменение. Оно уже могло сохраниться. Обновите план перед повторным действием."
              : "Не удалось загрузить план. Попробуйте обновить список.",
        );
      }
    };
    const load = async (before?: string) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const page = await api.personalPlan(before);
        if (!active()) return;
        if (!owner(page)) return;
        setItems((current) =>
          before
            ? [
                ...current,
                ...page.items.filter(
                  (item) => !current.some((old) => old.id === item.id),
                ),
              ]
            : page.items,
        );
        setNextBefore(page.nextBefore);
        setNeedsRefresh(false);
        setEditing(null);
        setRemoving(null);
      } catch (cause) {
        failure(cause, false);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    const update = async (
      item: PersonalPlanItem,
      value: UpdatePersonalPlanItem,
    ) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.updatePersonalPlanItem(item.id, value);
        if (!active()) return;
        if (!owner(result)) return;
        if (
          result.item.source.messageId !== item.source.messageId ||
          result.item.source.threadId !== item.source.threadId ||
          result.item.source.role !== item.source.role
        )
          throw new Error("Plan update source mismatch");
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
    const remove = async (item: PersonalPlanItem) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const result = await api.removePersonalPlanItem(item.id, item.revision);
        if (!active()) return;
        if (!owner(result)) return;
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
    if (!editing || disabled || !fields.title.trim()) return;
    void actions?.update(editing, {
      expectedRevision: editing.revision,
      title: fields.title.trim(),
      details: fields.details.trim(),
      status: editing.status,
    });
  };
  return (
    <Card
      className={styles.panel}
      aria-label="Мой план переезда"
      aria-busy={busy}
    >
      <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1>Ваш переезд — понятными шагами</h1>
      <p className={styles.intro}>
        Здесь — шаги, которые вы выбрали в разговорах с помощниками. Уточняйте
        план в своём темпе, даже если бюджет и дата ещё неизвестны.
      </p>
      <div className={styles.toolbar}>
        <span className={styles.meta}>МОЙ ПЛАН</span>
        <Button
          variant="ghost"
          disabled={busy || navigationBusy}
          onClick={() => void actions?.load()}
        >
          Обновить план
        </Button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void actions?.load()}
          >
            Обновить список
          </Button>
        </div>
      )}
      {busy && <p role="status">Обновляем план…</p>}
      {!busy && !error && !items.length && !nextBefore && (
        <div className={styles.empty}>
          <span className={styles.meta}>ПЕРВЫЙ ШАГ</span>
          <h2>Начнём с того, что важно вам</h2>
          <p>
            В диалоге нажмите «Добавить шаг в план» под своим сообщением или
            ответом помощника. Проверьте и подтвердите формулировку — шаг
            сохранится здесь.
          </p>
          <Button onClick={onContinue}>Открыть диалог</Button>
        </div>
      )}
      <ol className={styles.list} aria-label="Сохранённые шаги">
        {items.map((item) => (
          <li key={item.id}>
            <article
              className={styles.item}
              aria-label={"Шаг: " + item.title}
              data-plan-id={item.id}
            >
              <span className={styles.meta}>
                {item.status === "completed" ? "✓ ВЫПОЛНЕНО" : "СЛЕДУЮЩИЙ ШАГ"}
              </span>
              <h2>{item.title}</h2>
              {item.details && <p className={styles.details}>{item.details}</p>}
              <small>
                Из{" "}
                {item.source.role === "user"
                  ? "вашего сообщения"
                  : "ответа помощника"}{" "}
                · {new Date(item.createdAt).toLocaleDateString("ru-RU")}
              </small>
              {editing?.id === item.id ? (
                <form className={styles.editor} onSubmit={save}>
                  <h3 ref={editorTitle} tabIndex={-1}>
                    Изменить шаг
                  </h3>
                  <StepEditor
                    {...fields}
                    disabled={disabled}
                    onChange={setFields}
                  />
                  <div className={styles.actions}>
                    <Button
                      type="submit"
                      disabled={disabled || !fields.title.trim()}
                    >
                      Сохранить изменения
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Отмена редактирования
                    </Button>
                  </div>
                </form>
              ) : removing?.id === item.id ? (
                <div className={styles.confirmRemove}>
                  <p>
                    Удалить этот шаг? Сообщение и исходный диалог останутся.
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
                    variant="secondary"
                    disabled={disabled}
                    onClick={() =>
                      void actions?.update(item, {
                        expectedRevision: item.revision,
                        title: item.title,
                        details: item.details,
                        status:
                          item.status === "completed" ? "pending" : "completed",
                      })
                    }
                  >
                    {item.status === "completed"
                      ? "Вернуть в работу"
                      : "Отметить выполненным"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setEditing(item);
                      setRemoving(null);
                      setFields({ title: item.title, details: item.details });
                    }}
                  >
                    Изменить
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
      </ol>
      {nextBefore && (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => void actions?.load(nextBefore)}
        >
          Показать ещё шаги
        </Button>
      )}
      <div className={styles.bottomActions}>
        <Button disabled={navigationBusy} onClick={onContinue}>
          Продолжить разговор
        </Button>
        <Button
          disabled={navigationBusy}
          variant="secondary"
          onClick={onHelpers}
        >
          Все помощники
        </Button>
      </div>
    </Card>
  );
}
