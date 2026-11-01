"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type {
  CreatePersonalPlanItem,
  PersonalPlanItem,
  UpdatePersonalPlanItem,
} from "@citygo/contracts";
import { Button, Card, Field, Progress } from "@citygo/ui-web";
import styles from "./personal-plan.module.css";
import { PlanItemChecklist } from "./plan-checklist";
import { PlanExportAction } from "./plan-export";
import { PlanItemHistory } from "./plan-history";
import {
  createPersonalPlanResource,
  type PersonalPlanFilter,
  type PersonalPlanState,
} from "./personal-plan-state";
import { FavoriteMessageContext } from "./favorite-message-context";

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
        className="ym-disable-keys"
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
          className="ym-disable-keys"
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
  source: PlanMessageSource | null;
  onSaved: () => void;
  onCancel: (checkPlan: boolean) => void;
}) {
  const [fields, setFields] = useState<StepFields>({
    title: source?.content.trim().split(/\r?\n/)[0]!.slice(0, 120) ?? "",
    details: source?.content.slice(0, 4000) ?? "",
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
          sourceMessageId: source?.messageId ?? null,
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
          (result.item.source?.messageId ?? null) !==
            (source?.messageId ?? null) ||
          result.item.source?.threadId !== source?.threadId ||
          result.item.source?.role !== source?.role
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
  }, [
    userId,
    sessionSignal,
    source?.messageId,
    source?.threadId,
    source?.role,
  ]);

  if (sessionSignal.aborted) return null;
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void submit?.();
  };
  return (
    <section
      className={styles.composer + " ym-hide-content"}
      aria-label="Добавление шага в план"
      aria-busy={busy}
    >
      <h2 ref={heading} tabIndex={-1}>
        Добавить шаг в план
      </h2>
      <p>
        {source
          ? "Выберите действие и уточните формулировку перед сохранением."
          : "Запишите действие, которое хотите сделать."}
      </p>
      {source && source.content.length > 4000 && (
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
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    state: PersonalPlanState;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchInput, setSearchInput] = useState({
    owner: userId,
    signal: sessionSignal,
    value: "",
  });
  const searchDraft =
    searchInput.owner === userId && searchInput.signal === sessionSignal
      ? searchInput.value
      : "";
  const setSearchDraft = (value: string) =>
    setSearchInput({ owner: userId, signal: sessionSignal, value });
  const [editing, setEditingState] = useState<PersonalPlanItem | null>(null);
  const editingRef = useRef<PersonalPlanItem | null>(null);
  const setEditing = (value: PersonalPlanItem | null) => {
    editingRef.current = value;
    setEditingState(value);
  };
  const [fields, setFields] = useState<StepFields>({ title: "", details: "" });
  const [removing, setRemovingState] = useState<PersonalPlanItem | null>(null);
  const removingRef = useRef<PersonalPlanItem | null>(null);
  const setRemoving = (value: PersonalPlanItem | null) => {
    removingRef.current = value;
    setRemovingState(value);
  };
  const checklistScope = useRef({
    owner: userId,
    signal: sessionSignal,
    items: new Set<string>(),
  });
  const [, updateChecklistActivity] = useState(0);
  if (
    checklistScope.current.owner !== userId ||
    checklistScope.current.signal !== sessionSignal
  )
    checklistScope.current = {
      owner: userId,
      signal: sessionSignal,
      items: new Set<string>(),
    };
  const scope = checklistScope.current;
  function checklistActivity(itemId: string, active: boolean) {
    if (scope !== checklistScope.current || sessionSignal.aborted) return;
    const wasActive = scope.items.has(itemId);
    if (active) scope.items.add(itemId);
    else scope.items.delete(itemId);
    if (wasActive !== active) updateChecklistActivity((value) => value + 1);
  }
  const [source, setSource] = useState<PersonalPlanItem | null>(null);
  const [history, setHistory] = useState<PersonalPlanItem | null>(null);
  const lastHistory = useRef<string | null>(null);
  const resource = useRef<ReturnType<typeof createPersonalPlanResource> | null>(
    null,
  );
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const editorTitle = useRef<HTMLHeadingElement>(null);
  const lastSource = useRef<string | null>(null);

  useEffect(() => {
    setCreating(false);
    setSearchDraft("");
    setEditing(null);
    setRemoving(null);
    setSource(null);
    setHistory(null);
    lastHistory.current = null;
    lastSource.current = null;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = (requestSignal: AbortSignal) =>
      createClient("/api", { signal: () => requestSignal });
    const current = createPersonalPlanResource({
      userId,
      sessionSignal: signal,
      client: {
        page: (before, status, requestSignal, search) =>
          api(requestSignal).personalPlan(before, status, search),
        summary: (requestSignal) => api(requestSignal).personalPlanSummary(),
        update: (item, value, requestSignal) =>
          api(requestSignal).updatePersonalPlanItem(item.id, value),
        remove: (item, requestSignal) =>
          api(requestSignal).removePersonalPlanItem(item.id, item.revision),
      },
      publish: (state) =>
        setSnapshot({ owner: userId, signal: sessionSignal, state }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = current;
    void current.load();
    return () => {
      current.dispose();
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal]);

  const current =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  const items = current?.items ?? [];
  const summary = current?.summary ?? null;
  const nextBefore = current?.nextBefore ?? null;
  const filter = current?.filter ?? "all";
  const search = current?.search ?? "";
  const busy = !current || current.phase === "loading" || current.mutating;
  const error = current?.error ?? "";
  const needsRefresh = current?.needsRefresh ?? false;
  const actions = current ? resource.current : null;
  const interactionActive = !!editing || !!removing || scope.items.size > 0;
  const listControlsDisabled =
    navigationBusy ||
    !actions ||
    !!current?.mutating ||
    needsRefresh ||
    interactionActive;
  function listChangeBlocked() {
    const latest = actions?.snapshot();
    return (
      sessionSignal.aborted ||
      navigationBusy ||
      !latest ||
      latest.phase === "closed" ||
      latest.mutating ||
      latest.needsRefresh ||
      !!editingRef.current ||
      !!removingRef.current ||
      scope.items.size > 0
    );
  }
  const refresh = () => {
    if (
      sessionSignal.aborted ||
      navigationBusy ||
      !actions ||
      actions.snapshot().mutating ||
      editingRef.current ||
      removingRef.current ||
      scope.items.size > 0
    )
      return;
    void actions.load();
  };
  const selectFilter = (value: PersonalPlanFilter) => {
    if (listChangeBlocked()) return;
    void actions?.select(value);
  };
  const resetSearch = () => {
    if (listChangeBlocked()) return;
    setSearchDraft("");
    void actions?.select("all", "");
  };
  const update = async (
    item: PersonalPlanItem,
    value: UpdatePersonalPlanItem,
  ) => {
    if (await actions?.update(item, value)) {
      setEditing(null);
      setRemoving(null);
    }
  };
  const remove = async (item: PersonalPlanItem) => {
    if (await actions?.remove(item)) setRemoving(null);
  };

  useEffect(() => {
    if (source || !lastSource.current) return;
    const id = lastSource.current;
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-plan-source]"),
    ].find((element) => element.dataset.planSource === id);
    button?.focus({ preventScroll: true });
    lastSource.current = null;
  }, [source]);

  useEffect(() => {
    if (editing) editorTitle.current?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => {
    if (history || !lastHistory.current) return;
    const id = lastHistory.current;
    [...document.querySelectorAll<HTMLButtonElement>("[data-plan-history]")]
      .find((element) => element.dataset.planHistory === id)
      ?.focus({ preventScroll: true });
    lastHistory.current = null;
  }, [history]);
  if (sessionSignal.aborted || current?.phase === "closed") return null;
  const disabled = busy || needsRefresh || navigationBusy || !actions;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!current || !editing || disabled || !fields.title.trim()) return;
    void update(editing, {
      expectedRevision: editing.revision,
      title: fields.title.trim(),
      details: fields.details.trim(),
      status: editing.status,
    });
  };
  if (history && current)
    return (
      <PlanItemHistory
        key={userId + ":" + history.id}
        userId={userId}
        itemId={history.id}
        sessionSignal={sessionSignal}
        onBack={() => {
          setHistory(null);
          void actions?.load();
        }}
        onRestored={() => {
          void actions?.load();
        }}
        onAccessDenied={onAccessDenied}
      />
    );
  if (source?.source && current)
    return (
      <FavoriteMessageContext
        key={userId + ":" + source.source.messageId}
        userId={userId}
        source={{
          id: source.source.messageId,
          threadId: source.source.threadId,
        }}
        sessionSignal={sessionSignal}
        onBack={() => setSource(null)}
        onAccessDenied={onAccessDenied}
        onOpenConversation={onOpenConversation}
        labels={{
          eyebrow: "ИЗ МОЕГО ПЛАНА",
          intro: "Исходное сообщение и история перед ним.",
          back: "← В мой план",
          selected: "Источник шага",
          selectedAria: "Исходное сообщение шага",
          returnToSource: "К исходному сообщению",
          unavailable: "Исходное сообщение недоступно. Вернитесь к плану.",
        }}
      />
    );
  if (creating && current)
    return (
      <Card className={styles.panel}>
        <PlanStepComposer
          userId={userId}
          sessionSignal={sessionSignal}
          onAccessDenied={onAccessDenied}
          source={null}
          onSaved={() => {
            setCreating(false);
            if (filter === "all" && !search) void actions?.load();
            else {
              setSearchDraft("");
              void actions?.select("all", "");
            }
          }}
          onCancel={(checkPlan) => {
            setCreating(false);
            if (checkPlan) void actions?.load();
          }}
        />
      </Card>
    );
  return (
    <Card
      className={styles.panel}
      aria-label="Мой план переезда"
      aria-busy={busy}
    >
      <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1>Ваш переезд — понятными шагами</h1>
      <p className={styles.intro}>
        Сохраняйте собственные шаги или выбирайте их из разговоров. Уточняйте
        план в своём темпе, даже если бюджет и дата ещё неизвестны.
      </p>
      <div className={styles.toolbar}>
        <span className={styles.meta}>МОЙ ПЛАН</span>
        <Button
          disabled={disabled || interactionActive}
          onClick={() => {
            if (listChangeBlocked()) return;
            setCreating(true);
          }}
        >
          Добавить шаг
        </Button>
        <Button
          variant="ghost"
          disabled={busy || navigationBusy || interactionActive}
          onClick={refresh}
        >
          Обновить план
        </Button>
      </div>
      <PlanExportAction
        userId={userId}
        sessionSignal={sessionSignal}
        disabled={busy || listControlsDisabled}
        onAccessDenied={onAccessDenied}
      />
      {summary && (
        <div className={styles.progress}>
          <Progress
            value={
              summary.total ? (summary.completed / summary.total) * 100 : 0
            }
            label={`Выполнено ${summary.completed} из ${summary.total}`}
          />
        </div>
      )}
      <form
        className={styles.search + " ym-hide-content"}
        role="search"
        aria-label="Поиск в моём плане"
        onSubmit={(event) => {
          event.preventDefault();
          if (listChangeBlocked()) return;
          void actions?.select(filter, searchDraft);
        }}
      >
        <Field
          label="Найти шаг"
          className="ym-disable-keys"
          type="search"
          maxLength={160}
          value={searchDraft}
          disabled={listControlsDisabled}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <div className={styles.actions}>
          <Button type="submit" disabled={listControlsDisabled}>
            Найти
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={listControlsDisabled}
            onClick={resetSearch}
          >
            Сбросить
          </Button>
        </div>
      </form>
      <nav className={styles.filters} aria-label="Статус шагов плана">
        {(
          [
            ["all", "Все", summary?.total],
            ["pending", "В работе", summary?.pending],
            ["completed", "Выполнено", summary?.completed],
          ] as const
        ).map(([value, label, count]) => (
          <Button
            key={value}
            type="button"
            variant={filter === value ? "primary" : "secondary"}
            aria-pressed={filter === value}
            disabled={listControlsDisabled}
            onClick={() => selectFilter(value)}
          >
            {label} <span className={styles.count}>{count ?? "—"}</span>
          </Button>
        ))}
      </nav>
      {error && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy || interactionActive}
            onClick={refresh}
          >
            Обновить список
          </Button>
        </div>
      )}
      {busy && <p role="status">Обновляем план…</p>}
      {!busy &&
        !error &&
        !items.length &&
        !nextBefore &&
        summary?.total === 0 && (
          <div className={styles.empty}>
            <span className={styles.meta}>ПЕРВЫЙ ШАГ</span>
            <h2>Начнём с того, что важно вам</h2>
            <p>
              Добавьте свой шаг кнопкой выше или в диалоге нажмите «Добавить шаг
              в план» под сообщением или ответом помощника. Проверьте и
              подтвердите формулировку — шаг сохранится здесь.
            </p>
            <Button onClick={onContinue}>Открыть диалог</Button>
          </div>
        )}
      {!busy &&
        !error &&
        !items.length &&
        summary !== null &&
        summary.total > 0 && (
          <div className={styles.empty}>
            <h2>
              {search
                ? "Шаги не найдены"
                : filter === "completed"
                  ? "Выполненных шагов пока нет"
                  : "Нет шагов в работе"}
            </h2>
            <p>
              {search
                ? "Измените поиск или сбросьте условия."
                : filter === "completed"
                  ? "Отметьте готовый шаг — он появится здесь."
                  : "Вы завершили все сохранённые шаги."}
            </p>
            <Button
              variant="secondary"
              disabled={listControlsDisabled}
              onClick={resetSearch}
            >
              Показать все шаги
            </Button>
          </div>
        )}
      <ol className={styles.list} aria-label="Сохранённые шаги">
        {items.map((item) => (
          <li key={item.id}>
            <article
              className={styles.item + " ym-hide-content"}
              aria-label={"Шаг: " + item.title}
              data-plan-id={item.id}
            >
              <span className={styles.meta}>
                {item.status === "completed" ? "✓ ВЫПОЛНЕНО" : "В РАБОТЕ"}
              </span>
              <h2>{item.title}</h2>
              {item.details && <p className={styles.details}>{item.details}</p>}
              <PlanItemChecklist
                userId={userId}
                itemId={item.id}
                sessionSignal={sessionSignal}
                disabled={disabled}
                onAccessDenied={onAccessDenied}
                onInteractionChange={(active) =>
                  checklistActivity(item.id, active)
                }
                onSaved={() => {
                  void actions?.load();
                }}
              />
              <small>
                {item.source
                  ? item.source.role === "user"
                    ? "Из вашего сообщения"
                    : "Из ответа помощника"
                  : "Ваш шаг"}{" "}
                · {new Date(item.createdAt).toLocaleDateString("ru-RU")}
              </small>
              {current && editing?.id === item.id ? (
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
              ) : current && removing?.id === item.id ? (
                <div className={styles.confirmRemove}>
                  <p>
                    Удалить этот шаг? Сообщение и исходный диалог останутся.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      disabled={disabled}
                      onClick={() => void remove(item)}
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
                      void update(item, {
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
                variant="ghost"
                disabled={busy || navigationBusy || interactionActive}
                data-plan-history={item.id}
                onClick={() => {
                  if (listChangeBlocked()) return;
                  lastHistory.current = item.id;
                  setHistory(item);
                }}
              >
                Что изменилось
              </Button>
              {item.source && (
                <Button
                  className={styles.source}
                  variant="ghost"
                  disabled={busy || navigationBusy || interactionActive}
                  data-plan-source={item.id}
                  onClick={() => {
                    if (listChangeBlocked()) return;
                    lastSource.current = item.id;
                    setSource(item);
                  }}
                >
                  Открыть исходное сообщение
                </Button>
              )}
            </article>
          </li>
        ))}
      </ol>
      {nextBefore && (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => void actions?.loadMore()}
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
