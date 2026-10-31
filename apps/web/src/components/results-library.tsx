"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type {
  FavoriteMessage,
  FavoriteMessageFilters,
  PersonalPlanItem,
} from "@citygo/contracts";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import { agentNames } from "./agent-names";
import { FavoriteMessageContext } from "./favorite-message-context";
import {
  createResultsResource,
  resultMessageTitle,
  resultPreview,
  type ResultsState,
  type ResultsPlanFilters,
  type ResultsCategory,
} from "./results-library-state";
import styles from "./results-library.module.css";

type Source = {
  id: string;
  threadId: string;
  kind: "plan" | "favorites";
  owner: string;
  signal: AbortSignal;
};
function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function ResultFilters({
  category,
  plan,
  favorites,
  disabled,
  error,
  onApply,
}: {
  category: ResultsCategory;
  plan: ResultsPlanFilters;
  favorites: FavoriteMessageFilters;
  disabled: boolean;
  error: string;
  onApply: (filters: ResultsPlanFilters | FavoriteMessageFilters) => void;
}) {
  const applied = category === "plan" ? plan : favorites;
  const [search, setSearch] = useState(applied.search ?? "");
  const [status, setStatus] = useState(plan.status ?? "");
  const [assistant, setAssistant] = useState(favorites.assistantKey ?? "");
  const [role, setRole] = useState(favorites.role ?? "");
  return (
    <form
      className={styles.search + " ym-hide-content"}
      aria-label="Поиск результатов"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const query = search.trim();
        onApply({
          ...(query ? { search: query } : {}),
          ...(category === "plan"
            ? status
              ? { status: status as ResultsPlanFilters["status"] }
              : {}
            : {
                ...(assistant
                  ? {
                      assistantKey:
                        assistant as FavoriteMessageFilters["assistantKey"],
                    }
                  : {}),
                ...(role
                  ? { role: role as FavoriteMessageFilters["role"] }
                  : {}),
              }),
        });
      }}
    >
      <Field
        label="Поиск в результатах"
        className="ym-disable-keys"
        type="search"
        value={search}
        maxLength={160}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={
          category === "plan"
            ? "Название или текст шага"
            : "Текст сохранённого сообщения"
        }
      />
      {category === "plan" ? (
        <SelectField
          label="Статус шага"
          value={status}
          disabled={disabled}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="">Все шаги</option>
          <option value="pending">Запланировано</option>
          <option value="completed">Выполнено</option>
        </SelectField>
      ) : (
        <>
          <SelectField
            label="Помощник"
            value={assistant}
            disabled={disabled}
            onChange={(event) =>
              setAssistant(event.target.value as typeof assistant)
            }
          >
            <option value="">Все помощники</option>
            {Object.entries(agentNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Автор сообщения"
            value={role}
            disabled={disabled}
            onChange={(event) => setRole(event.target.value as typeof role)}
          >
            <option value="">Все сообщения</option>
            <option value="user">Вы</option>
            <option value="assistant">Помощник</option>
          </SelectField>
        </>
      )}
      <div className={styles.actions}>
        <Button type="submit" disabled={disabled}>
          Найти
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setSearch("");
            setStatus("");
            setAssistant("");
            setRole("");
            onApply({});
          }}
        >
          Сбросить фильтры
        </Button>
      </div>
      {error && (
        <p role="alert" className={styles.filterError}>
          {error}
        </p>
      )}
    </form>
  );
}
export function ResultsLibrary({
  userId,
  sessionSignal,
  onAccessDenied,
  onOpenConversation,
  onPlan,
  onFavorites,
  onContinue,
  navigationBusy = false,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onOpenConversation?: (threadId: string) => Promise<boolean>;
  onPlan: () => void;
  onFavorites?: () => void;
  onContinue: () => void;
  navigationBusy?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    state: ResultsState;
  } | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [detail, setDetail] = useState<{
    owner: string;
    signal: AbortSignal;
    category: ResultsCategory;
    id: string;
  } | null>(null);
  const resource = useRef<ReturnType<typeof createResultsResource> | null>(
    null,
  );
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const sourceButton = useRef<HTMLButtonElement | null>(null);
  const listScroll = useRef(0);
  const previewTitle = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = (requestSignal: AbortSignal) =>
      createClient("/api", { signal: () => requestSignal });
    const value = createResultsResource({
      userId,
      sessionSignal: signal,
      client: {
        plan: (before, requestSignal, filters) =>
          api(requestSignal).personalPlan(
            before,
            filters.status,
            filters.search,
          ),
        summary: (requestSignal) => api(requestSignal).personalPlanSummary(),
        favorites: (before, requestSignal, filters) =>
          api(requestSignal).favoriteMessages(before, filters),
      },
      publish: (state) =>
        setSnapshot({ owner: userId, signal: sessionSignal, state }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = value;
    void value.load();
    return () => {
      value.dispose();
      controller.abort();
      if (resource.current === value) resource.current = null;
    };
  }, [userId, sessionSignal]);
  const current =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  const category = current?.category ?? "plan";
  const page = current?.[category];
  const busy = !page || page.phase === "loading" || page.phase === "idle";
  const selected =
    current && source?.owner === userId && source.signal === sessionSignal
      ? source
      : null;
  const expanded =
    current &&
    detail?.owner === userId &&
    detail.signal === sessionSignal &&
    detail.category === category
      ? category === "plan"
        ? current.plan.items.find((item) => item.id === detail.id)
        : current.favorites.items.find((item) => item.id === detail.id)
      : null;
  useEffect(() => {
    if (expanded && !sessionSignal.aborted) previewTitle.current?.focus();
  }, [expanded?.id, category, userId, sessionSignal]);
  if (sessionSignal.aborted || current?.closed) return null;
  const returnToList = () => {
    setSource(null);
    setDetail(null);
    requestAnimationFrame(() => {
      if (sessionSignal.aborted) return;
      sourceButton.current?.focus({ preventScroll: true });
      window.scrollTo({ top: listScroll.current, behavior: "instant" });
    });
  };
  const previewAction = (id: string) => (
    <Button
      variant="secondary"
      disabled={busy || navigationBusy}
      onClick={(event) => {
        if (
          sessionSignal.aborted ||
          !current ||
          current.closed ||
          busy ||
          navigationBusy
        )
          return;
        sourceButton.current = event.currentTarget;
        listScroll.current = window.scrollY;
        setSource(null);
        setDetail({ id, category, owner: userId, signal: sessionSignal });
      }}
    >
      Открыть полностью
    </Button>
  );
  const openSource = (
    event: React.MouseEvent<HTMLButtonElement>,
    value: Pick<Source, "id" | "threadId" | "kind">,
  ) => {
    if (
      sessionSignal.aborted ||
      navigationBusy ||
      busy ||
      !current ||
      current.closed
    )
      return;
    sourceButton.current = event.currentTarget;
    listScroll.current = window.scrollY;
    setDetail(null);
    setSource({ ...value, owner: userId, signal: sessionSignal });
  };
  const sourceAction = (value: Pick<Source, "id" | "threadId" | "kind">) => (
    <Button
      variant="secondary"
      disabled={busy || navigationBusy}
      onClick={(event) => openSource(event, value)}
    >
      Открыть источник
    </Button>
  );
  const planCard = (item: PersonalPlanItem) => (
    <article
      key={item.id}
      className={styles.item + " ym-hide-content"}
      aria-label={"Шаг плана: " + item.title}
    >
      <span className={styles.meta}>
        ШАГ ПЛАНА ·{" "}
        {item.status === "completed" ? "ВЫПОЛНЕНО" : "ЗАПЛАНИРОВАНО"}
      </span>
      <h2>{item.title}</h2>
      <p className={styles.preview}>
        {item.details
          ? resultPreview(item.details)
          : "Ваш сохранённый шаг. Подробности и статус доступны в моём плане."}
      </p>
      <small>
        Сохранён {new Date(item.createdAt).toLocaleDateString("ru-RU")}
      </small>
      <div className={styles.actions}>
        {previewAction(item.id)}
        {item.source &&
          sourceAction({
            id: item.source.messageId,
            threadId: item.source.threadId,
            kind: "plan",
          })}
        <Button
          variant="ghost"
          disabled={navigationBusy}
          onClick={() => {
            if (
              sessionSignal.aborted ||
              navigationBusy ||
              !current ||
              current.closed
            )
              return;
            downloadText(
              item.title + (item.details ? "\n\n" + item.details : ""),
              "citygo-plan-" + item.id + ".txt",
            );
          }}
        >
          Скачать .txt
        </Button>
      </div>
    </article>
  );
  const favoriteCard = (item: FavoriteMessage) => (
    <article
      key={item.id}
      className={styles.item + " ym-hide-content"}
      aria-label={"Избранное сообщение " + item.id}
    >
      <span className={styles.meta}>
        {item.role === "user" ? "ВЫ" : agentNames[item.agentKey]} · ИЗБРАННОЕ
      </span>
      <h2>{resultMessageTitle(item.content)}</h2>
      <p className={styles.preview}>{resultPreview(item.content)}</p>
      {item.status === "interrupted" && <small>Ответ прерван</small>}
      <div className={styles.actions}>
        {previewAction(item.id)}
        {sourceAction({
          id: item.id,
          threadId: item.threadId,
          kind: "favorites",
        })}
        <Button
          variant="ghost"
          disabled={navigationBusy}
          onClick={() => {
            if (
              sessionSignal.aborted ||
              navigationBusy ||
              !current ||
              current.closed
            )
              return;
            downloadText(item.content, "citygo-message-" + item.id + ".txt");
          }}
        >
          Скачать .txt
        </Button>
      </div>
    </article>
  );
  return (
    <>
      {selected && (
        <div className="ym-hide-content">
          <FavoriteMessageContext
            key={userId + ":" + selected.threadId + ":" + selected.id}
            userId={userId}
            source={selected}
            sessionSignal={sessionSignal}
            onAccessDenied={onAccessDenied}
            onOpenConversation={onOpenConversation}
            labels={{
              eyebrow: "ИЗ РЕЗУЛЬТАТОВ",
              intro: "Исходное сообщение и история перед ним.",
              back: "← В результаты",
              selected:
                selected.kind === "plan"
                  ? "Источник шага"
                  : "Сохранённое сообщение",
              unavailable:
                "Исходное сообщение недоступно. Вернитесь к результатам.",
            }}
            onBack={returnToList}
          />
        </div>
      )}
      {expanded && (
        <Card
          className={styles.panel + " ym-hide-content"}
          aria-label="Полный результат"
        >
          <Button
            variant="ghost"
            disabled={navigationBusy}
            onClick={returnToList}
          >
            ← В результаты
          </Button>
          <span className={styles.meta}>
            {category === "plan" ? "ШАГ ПЛАНА" : "ИЗБРАННОЕ СООБЩЕНИЕ"}
          </span>
          <h1 ref={previewTitle} tabIndex={-1}>
            {"title" in expanded
              ? expanded.title
              : resultMessageTitle(expanded.content)}
          </h1>
          <div
            className={styles.fullText}
            tabIndex={0}
            role="region"
            aria-label="Полный текст результата"
          >
            {"details" in expanded
              ? expanded.details || "Подробности пока не добавлены."
              : expanded.content}
          </div>
        </Card>
      )}
      <div hidden={selected !== null || Boolean(expanded)}>
        <Card
          className={styles.panel}
          aria-label="Полезное из разговоров"
          aria-busy={busy}
        >
          <span className={styles.meta}>CITYGO · ВАШ ПЕРЕЕЗД</span>
          <h1>Полезное из разговоров</h1>
          <p className={styles.intro}>
            Сохранённые планы и черновики — отдельно от ленты сообщений.
          </p>
          <nav className={styles.filters} aria-label="Категории результатов">
            <Button
              variant={category === "plan" ? "primary" : "secondary"}
              aria-pressed={category === "plan"}
              disabled={navigationBusy}
              onClick={() => void resource.current?.select("plan")}
            >
              Шаги плана{current?.summary ? " · " + current.summary.total : ""}
            </Button>
            <Button
              variant={category === "favorites" ? "primary" : "secondary"}
              aria-pressed={category === "favorites"}
              disabled={navigationBusy}
              onClick={() => void resource.current?.select("favorites")}
            >
              Избранные сообщения
            </Button>
          </nav>
          {current && (
            <ResultFilters
              key={category}
              category={category}
              plan={current.planFilters}
              favorites={current.favoriteFilters}
              disabled={navigationBusy}
              error={current.filterError}
              onApply={(filters) => {
                setDetail(null);
                setSource(null);
                if (category === "plan")
                  void resource.current?.filterPlan(
                    filters as ResultsPlanFilters,
                  );
                else
                  void resource.current?.filterFavorites(
                    filters as FavoriteMessageFilters,
                  );
              }}
            />
          )}
          {category === "plan" && current?.summary && (
            <p className={styles.summary}>
              Выполнено {current.summary.completed} из {current.summary.total}.
              Статус и текст шагов можно изменить в «Моём плане».
            </p>
          )}
          {page?.error && (
            <div className={styles.error} role="alert">
              <p>{page.error}</p>
              <Button
                variant="secondary"
                disabled={busy || navigationBusy}
                onClick={() => void resource.current?.load()}
              >
                Повторить загрузку
              </Button>
            </div>
          )}
          {busy && <p role="status">Загружаем результаты…</p>}
          {!busy && !page?.error && !page?.items.length && (
            <div className={styles.empty}>
              <h2>
                {Object.keys(
                  category === "plan"
                    ? (current?.planFilters ?? {})
                    : (current?.favoriteFilters ?? {}),
                ).length
                  ? "Ничего не найдено"
                  : category === "plan"
                    ? "Сохраните первый шаг"
                    : "Сохраните важное сообщение"}
              </h2>
              <p>
                {Object.keys(
                  category === "plan"
                    ? (current?.planFilters ?? {})
                    : (current?.favoriteFilters ?? {}),
                ).length
                  ? "Измените запрос или сбросьте фильтры."
                  : category === "plan"
                    ? "Добавьте шаг из сообщения в диалоге. Сохранённые шаги появятся здесь и в «Моём плане»."
                    : "Нажмите «В избранное» под сообщением или ответом помощника. Здесь появятся ваши сохранённые сообщения."}
              </p>
              <Button disabled={navigationBusy} onClick={onContinue}>
                Открыть диалоги
              </Button>
            </div>
          )}
          <div className={styles.list}>
            {category === "plan"
              ? current?.plan.items.map(planCard)
              : current?.favorites.items.map(favoriteCard)}
          </div>
          {page?.nextBefore && (
            <Button
              variant="secondary"
              disabled={busy || navigationBusy}
              onClick={() => void resource.current?.loadMore()}
            >
              Показать ещё
            </Button>
          )}
          <div className={styles.bottomActions}>
            <Button disabled={navigationBusy} onClick={onContinue}>
              Обсудить результаты
            </Button>
            {category === "plan" ? (
              <Button
                variant="secondary"
                disabled={navigationBusy}
                onClick={onPlan}
              >
                Открыть мой план
              </Button>
            ) : (
              onFavorites && (
                <Button
                  variant="secondary"
                  disabled={navigationBusy}
                  onClick={onFavorites}
                >
                  Управлять избранным
                </Button>
              )
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
