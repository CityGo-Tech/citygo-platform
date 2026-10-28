"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  createSessionGuard,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import type {
  AdminCustomerAccount,
  AdminCustomerAccountsPage,
  AdminCustomerConversationsPage,
  AdminCustomerMessagesPage,
  AdminCustomerActivityPage,
  AdminCustomerFavoritesPage,
  AdminCustomerPlanPage,
  AdminCustomerFunnel,
} from "@citygo/contracts";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import {
  customerAgentNames,
  customerDate,
  customerMoney,
  customerPlanStatus,
  customerRoleNames,
} from "./customer-explorer-state.js";
import {
  CustomerReadDenied,
  readCustomerAsCurrentAdmin,
} from "./customer-explorer-read.js";

type View = "overview" | "dialogs" | "activity" | "plan" | "favorites";
const viewNames: Record<View, string> = {
  overview: "Кабинет",
  dialogs: "Диалоги",
  activity: "Действия",
  plan: "План",
  favorites: "Избранное",
};
const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};
const buttons = { display: "flex", flexWrap: "wrap" as const, gap: 8 };

export function CustomerExplorer({
  viewerId,
  onAccessLost,
  metrikaCounterId,
}: {
  viewerId: string;
  onAccessLost: () => void;
  metrikaCounterId?: number | null;
}) {
  const [guard] = useState(createSessionGuard);
  const [accounts, setAccounts] = useState<AdminCustomerAccountsPage | null>(
    null,
  );
  const [funnel, setFunnel] = useState<AdminCustomerFunnel | null>(null);
  const [detail, setDetail] = useState<AdminCustomerAccount | null>(null);
  const [conversations, setConversations] =
    useState<AdminCustomerConversationsPage | null>(null);
  const [messages, setMessages] = useState<AdminCustomerMessagesPage | null>(
    null,
  );
  const [activity, setActivity] = useState<AdminCustomerActivityPage | null>(
    null,
  );
  const [plan, setPlan] = useState<AdminCustomerPlanPage | null>(null);
  const [favorites, setFavorites] = useState<AdminCustomerFavoritesPage | null>(
    null,
  );
  const [view, setView] = useState<View>("overview");
  const [searchText, setSearchText] = useState("");
  const [loadedSearch, setLoadedSearch] = useState<string | undefined>();
  const [days, setDays] = useState(30);
  const [after, setAfter] = useState<string | undefined>();
  const [previousAccounts, setPreviousAccounts] = useState<
    (string | undefined)[]
  >([]);
  const [messageBefore, setMessageBefore] = useState<string | undefined>();
  const [newerMessagePages, setNewerMessagePages] = useState<
    (string | undefined)[]
  >([]);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef<object | null>(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => guard.capture().signal,
        onUnauthorized: () => deny(),
      }),
    [guard],
  );

  function clearAccount() {
    setDetail(null);
    setConversations(null);
    setMessages(null);
    setActivity(null);
    setPlan(null);
    setFavorites(null);
    setSnapshotAt(null);
    setView("overview");
    setMessageBefore(undefined);
    setNewerMessagePages([]);
  }
  function invalidate() {
    guard.reset();
    running.current = null;
    clearAccount();
    setAccounts(null);
    setFunnel(null);
    setSearchText("");
    setLoadedSearch(undefined);
    setAfter(undefined);
    setPreviousAccounts([]);
    setBusy(false);
    setError("");
  }
  function deny() {
    invalidate();
    onAccessLost();
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(invalidate);
    const hidden = () => {
      if (document.visibilityState === "hidden") invalidate();
    };
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", hidden);
      guard.reset();
      running.current = null;
    };
  }, [guard]);

  async function execute<T>(read: () => Promise<T>, apply: (value: T) => void) {
    if (running.current) return;
    const operation = {};
    running.current = operation;
    const ticket = guard.capture();
    setBusy(true);
    setError("");
    try {
      const value = await readCustomerAsCurrentAdmin({
        viewerId,
        ticket,
        dashboard: api.dashboard,
        read,
      });
      apply(value);
    } catch (failure) {
      if (ticket.active()) {
        if (
          failure instanceof CustomerReadDenied ||
          (failure instanceof ApiError && [401, 403].includes(failure.status))
        )
          deny();
        else
          setError("Не удалось загрузить данные. Обновите страницу просмотра.");
      }
    } finally {
      if (running.current === operation) running.current = null;
      if (ticket.active()) setBusy(false);
    }
  }

  function load(
    search = searchText.trim() || undefined,
    cursor?: string,
    history: (string | undefined)[] = [],
  ) {
    if (running.current) return;
    clearAccount();
    setAccounts(null);
    void execute(
      () =>
        Promise.all([
          api.adminCustomerAccounts({ search, afterUserId: cursor }),
          api.adminCustomerFunnel({ days }),
        ]),
      ([page, metrics]) => {
        setAccounts(page);
        setFunnel(metrics);
        setLoadedSearch(search);
        setAfter(cursor);
        setPreviousAccounts(history);
      },
    );
  }
  function selectAccount(userId: string) {
    if (running.current) return;
    clearAccount();
    void execute(
      () =>
        Promise.all([
          api.adminCustomerAccount(userId),
          api.adminCustomerConversations(userId),
        ]),
      ([account, dialogs]) => {
        setDetail(account);
        setConversations(dialogs);
        setPlan({ userId, ...account.personalPlan });
        setSnapshotAt(new Date().toISOString());
      },
    );
  }
  function loadConversations(before?: string) {
    if (!detail || running.current) return;
    setMessages(null);
    void execute(
      () => api.adminCustomerConversations(detail.account.userId, { before }),
      setConversations,
    );
  }
  function loadMessages(
    conversationId: string,
    before?: string,
    history: (string | undefined)[] = [],
  ) {
    if (!detail || running.current) return;
    setMessages(null);
    setView("dialogs");
    void execute(
      () =>
        api.adminCustomerMessages(detail.account.userId, conversationId, {
          before,
          limit: 25,
        }),
      (page) => {
        setMessages(page);
        setMessageBefore(before);
        setNewerMessagePages(history);
      },
    );
  }
  function loadActivity(before?: string) {
    if (!detail || running.current) return;
    setActivity(null);
    void execute(
      () => api.adminCustomerActivity(detail.account.userId, { before }),
      setActivity,
    );
  }
  function loadPlan(before?: string) {
    if (!detail || running.current) return;
    setPlan(null);
    void execute(
      () => api.adminCustomerPlan(detail.account.userId, { before }),
      setPlan,
    );
  }
  function loadFavorites(before?: string) {
    if (!detail || running.current) return;
    setFavorites(null);
    void execute(
      () => api.adminCustomerFavorites(detail.account.userId, { before }),
      setFavorites,
    );
  }
  function chooseView(next: View) {
    setView(next);
    if (next === "activity" && activity === null) loadActivity();
    if (next === "favorites" && favorites === null) loadFavorites();
    if (next === "plan" && plan === null) loadPlan();
  }

  return (
    <div className="ym-hide-content ym-disable-keys" data-private-customer-view>
      <Card>
        <h2>Пользователи и воронка</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <div style={grid}>
            <Field
              className="ym-disable-keys"
              label="Найти пользователя"
              placeholder="Email, логин или ID"
              maxLength={100}
              value={searchText}
              disabled={busy}
              onChange={(event) => setSearchText(event.target.value)}
            />
            <SelectField
              label="Период показателей"
              value={days}
              disabled={busy}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={7}>7 дней</option>
              <option value={30}>30 дней</option>
              <option value={90}>90 дней</option>
            </SelectField>
          </div>
          <div style={buttons}>
            <Button type="submit" disabled={busy}>
              {accounts
                ? "Обновить пользователей и показатели"
                : "Показать пользователей и показатели"}
            </Button>
            {(accounts || busy || detail) && (
              <Button type="button" variant="secondary" onClick={invalidate}>
                Скрыть данные
              </Button>
            )}
            {metrikaCounterId &&
            Number.isSafeInteger(metrikaCounterId) &&
            metrikaCounterId > 0 ? (
              <a
                href={`https://metrika.yandex.ru/overview?id=${metrikaCounterId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Открыть Метрику ↗
              </a>
            ) : null}
          </div>
        </form>
        {busy && <p role="status">Загрузка данных…</p>}
        {error && <p role="alert">{error}</p>}
        {funnel && <FunnelSummary funnel={funnel} />}
        {accounts && (
          <>
            <h3>Аккаунты{loadedSearch ? ` · ${loadedSearch}` : ""}</h3>
            {accounts.accounts.length ? (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    textAlign: "left",
                    borderSpacing: "8px 12px",
                  }}
                >
                  <thead>
                    <tr>
                      <th>Пользователь</th>
                      <th>Почта и телефон</th>
                      <th>Баланс</th>
                      <th>Последнее действие</th>
                      <th>
                        <span className="sr-only">Просмотр</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.accounts.map((account) => (
                      <tr key={account.userId}>
                        <td>
                          <strong>{account.username ?? account.email}</strong>
                          <br />
                          <small>
                            ID {account.userId} ·{" "}
                            {customerRoleNames[account.role]}
                          </small>
                        </td>
                        <td>
                          {account.email}
                          <br />
                          <small>
                            Почта:{" "}
                            {account.emailVerified
                              ? "подтверждена"
                              : "не подтверждена"}{" "}
                            · Телефон:{" "}
                            {account.phoneVerified
                              ? "подтверждён"
                              : "не подтверждён"}
                          </small>
                        </td>
                        <td>{customerMoney(account.availableMicros)}</td>
                        <td>{customerDate(account.lastActivityAt)}</td>
                        <td>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => selectAccount(account.userId)}
                          >
                            Открыть кабинет
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>Пользователи не найдены.</p>
            )}
            <div style={buttons}>
              {previousAccounts.length > 0 && (
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() =>
                    load(
                      loadedSearch,
                      previousAccounts.at(-1),
                      previousAccounts.slice(0, -1),
                    )
                  }
                >
                  Предыдущие пользователи
                </Button>
              )}
              {accounts.nextAfterUserId && (
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() =>
                    load(loadedSearch, accounts.nextAfterUserId!, [
                      ...previousAccounts,
                      after,
                    ])
                  }
                >
                  Следующие пользователи
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
      {detail && (
        <Card aria-label={`Кабинет пользователя ${detail.account.userId}`}>
          <header>
            <h2>
              {detail.account.username ?? detail.account.email} · ID{" "}
              {detail.account.userId}
            </h2>
            <p>Режим просмотра · Состояние на {customerDate(snapshotAt)}</p>
            <div style={buttons}>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => selectAccount(detail.account.userId)}
              >
                Обновить кабинет
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  guard.reset();
                  running.current = null;
                  setBusy(false);
                  clearAccount();
                }}
              >
                Закрыть кабинет
              </Button>
            </div>
          </header>
          <nav
            aria-label="Разделы кабинета пользователя"
            style={{ ...buttons, marginBlock: 16 }}
          >
            {(Object.keys(viewNames) as View[]).map((key) => (
              <Button
                key={key}
                variant={view === key ? "primary" : "secondary"}
                disabled={busy}
                aria-pressed={view === key}
                onClick={() => chooseView(key)}
              >
                {viewNames[key]}
              </Button>
            ))}
          </nav>
          {view === "overview" && (
            <>
              <dl style={grid}>
                <Info label="Email" value={detail.account.email} />
                <Info
                  label="Почта"
                  value={
                    detail.account.emailVerified
                      ? "Подтверждена"
                      : "Не подтверждена"
                  }
                />
                <Info
                  label="Телефон"
                  value={
                    detail.account.phoneVerified
                      ? "Подтверждён"
                      : "Не подтверждён"
                  }
                />
                <Info
                  label="Подарок 500 ₽"
                  value={detail.account.giftClaimed ? "Получен" : "Не получен"}
                />
                <Info
                  label="Баланс"
                  value={customerMoney(detail.account.availableMicros)}
                />
                <Info
                  label="В обработке"
                  value={customerMoney(detail.account.heldMicros)}
                />
                <Info
                  label="Потрачено"
                  value={customerMoney(detail.account.spentMicros)}
                />
                <Info
                  label="Диалогов"
                  value={String(detail.account.conversationCount)}
                />
                <Info
                  label="Сообщений"
                  value={String(detail.account.messageCount)}
                />
                <Info
                  label="В избранном"
                  value={String(detail.favoritesCount)}
                />
                <Info
                  label="Активных входов"
                  value={String(detail.activeSessions)}
                />
                <Info
                  label="Дата регистрации"
                  value={customerDate(detail.account.createdAt)}
                />
                <Info
                  label="Статус аккаунта"
                  value={
                    detail.account.status === "active"
                      ? "Активен"
                      : detail.account.status === "blocked"
                        ? "Заблокирован"
                        : "Удалён"
                  }
                />
              </dl>
              <h3>Переезд</h3>
              {detail.profile ? (
                <dl style={grid}>
                  <Info
                    label="Откуда"
                    value={detail.profile.originCity ?? "Не указано"}
                  />
                  <Info label="Куда" value={detail.profile.targetCity} />
                  <Info
                    label="Бюджет в месяц"
                    value={detail.profile.monthlyBudget ?? "Не указан"}
                  />
                  <Info
                    label="Дата переезда"
                    value={detail.profile.moveTargetDate ?? "Не указана"}
                  />
                </dl>
              ) : (
                <p>Данные о переезде ещё не сохранены.</p>
              )}
              {detail.analyticsUserId && (
                <details>
                  <summary>Найти визиты в Метрике</summary>
                  <p>Идентификатор пользователя для поиска записей:</p>
                  <code style={{ overflowWrap: "anywhere" }}>
                    {detail.analyticsUserId}
                  </code>
                </details>
              )}
            </>
          )}
          {view === "dialogs" && (
            <>
              <h3>Диалоги пользователя</h3>
              {conversations?.conversations.length ? (
                <ul aria-label="Диалоги пользователя">
                  {conversations.conversations.map((conversation) => (
                    <li key={conversation.id} style={{ marginBottom: 12 }}>
                      <strong>
                        {customerAgentNames[
                          conversation.assistantKey ?? conversation.agentKey
                        ] ?? "Помощник"}{" "}
                        · Диалог {conversation.id}
                      </strong>
                      <p>
                        {conversation.messageCount} сообщений ·{" "}
                        {customerDate(
                          conversation.lastMessageAt ?? conversation.createdAt,
                        )}{" "}
                        ·{" "}
                        {conversation.status === "closed"
                          ? "Завершён"
                          : conversation.status === "handoff"
                            ? "Передан специалисту"
                            : "Открыт"}
                      </p>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => loadMessages(conversation.id)}
                      >
                        Прочитать диалог
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Диалогов пока нет.</p>
              )}
              <div style={buttons}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadConversations()}
                >
                  Последние диалоги
                </Button>
                {conversations?.nextBeforeId && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      loadConversations(conversations.nextBeforeId!)
                    }
                  >
                    Более ранние диалоги
                  </Button>
                )}
              </div>
              {messages && (
                <section
                  aria-label={`Сообщения диалога ${messages.conversationId}`}
                >
                  <h3>Сообщения · Диалог {messages.conversationId}</h3>
                  <div style={buttons}>
                    {messages.nextBeforeId && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          loadMessages(
                            messages.conversationId,
                            messages.nextBeforeId!,
                            [...newerMessagePages, messageBefore],
                          )
                        }
                      >
                        Более ранние сообщения
                      </Button>
                    )}
                    {newerMessagePages.length > 0 && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          loadMessages(
                            messages.conversationId,
                            newerMessagePages.at(-1),
                            newerMessagePages.slice(0, -1),
                          )
                        }
                      >
                        Более поздние сообщения
                      </Button>
                    )}
                    {messageBefore && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => loadMessages(messages.conversationId)}
                      >
                        Последние сообщения
                      </Button>
                    )}
                  </div>
                  {messages.messages.length ? (
                    messages.messages.map((message) => (
                      <article
                        key={message.id}
                        style={{
                          borderTop: "1px solid #dfe3ef",
                          paddingBlock: 16,
                        }}
                      >
                        <strong>
                          {message.role === "user"
                            ? "Пользователь"
                            : "Помощник"}
                        </strong>
                        <small>
                          {" "}
                          · {customerDate(message.createdAt)} · ID {message.id}
                        </small>
                        <p
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            color: "inherit",
                          }}
                        >
                          {message.content}
                        </p>
                      </article>
                    ))
                  ) : (
                    <p>В диалоге пока нет сообщений.</p>
                  )}
                </section>
              )}
            </>
          )}
          {view === "activity" && (
            <>
              <h3>История действий</h3>
              {activity?.events.length ? (
                <ol aria-label="Действия пользователя">
                  {activity.events.map((event) => (
                    <li key={event.id} style={{ marginBottom: 12 }}>
                      <strong>{event.label}</strong> ·{" "}
                      {customerDate(event.occurredAt)}
                      {event.amountMicros !== null && (
                        <span> · {customerMoney(event.amountMicros)}</span>
                      )}
                      {event.conversationId && (
                        <div>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => loadMessages(event.conversationId!)}
                          >
                            Открыть диалог {event.conversationId}
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                !busy && <p>Сохранённых действий пока нет.</p>
              )}
              <div style={buttons}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadActivity()}
                >
                  Последние действия
                </Button>
                {activity?.nextCursor && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => loadActivity(activity.nextCursor!)}
                  >
                    Более ранние действия
                  </Button>
                )}
              </div>
            </>
          )}
          {view === "plan" && (
            <>
              <h3>Личный план</h3>
              {plan?.items.length ? (
                <ul>
                  {plan.items.map((item) => (
                    <li key={item.id}>
                      <strong>{item.title}</strong> ·{" "}
                      {customerPlanStatus[item.status] ?? "Нужно сделать"}
                      <p
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {item.details}
                      </p>
                      <small>Обновлено {customerDate(item.updatedAt)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                !busy && <p>План пока пуст.</p>
              )}
              <div style={buttons}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadPlan()}
                >
                  Последние пункты плана
                </Button>
                {plan?.nextBeforeId && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => loadPlan(plan.nextBeforeId!)}
                  >
                    Более ранние пункты
                  </Button>
                )}
              </div>
            </>
          )}
          {view === "favorites" && (
            <>
              <h3>Избранные сообщения</h3>
              {favorites?.items.length
                ? favorites.items.map((item) => (
                    <article
                      key={item.id}
                      style={{
                        borderTop: "1px solid #dfe3ef",
                        paddingBlock: 16,
                      }}
                    >
                      <strong>
                        {item.role === "user" ? "Пользователь" : "Помощник"}
                      </strong>{" "}
                      · {customerDate(item.createdAt)}
                      <p
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          color: "inherit",
                        }}
                      >
                        {item.content}
                      </p>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => loadMessages(item.conversationId)}
                      >
                        Открыть диалог {item.conversationId}
                      </Button>
                    </article>
                  ))
                : !busy && <p>Избранных сообщений пока нет.</p>}
              <div style={buttons}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadFavorites()}
                >
                  Последние избранные сообщения
                </Button>
                {favorites?.nextBeforeId && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => loadFavorites(favorites.nextBeforeId!)}
                  >
                    Более ранние избранные
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>
        <small>{label}</small>
      </dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
}

function FunnelSummary({ funnel }: { funnel: AdminCustomerFunnel }) {
  const registered =
    funnel.steps.find((step) => step.key === "registered")?.users ?? 0;
  return (
    <section aria-label="Показатели воронки">
      <h3>Воронка за {funnel.days} дней</h3>
      <p>
        Действия пользователей, зарегистрированных за выбранный период. Каждый
        показатель считается отдельно.
      </p>
      <dl style={grid}>
        {funnel.steps.map((step) => (
          <div key={step.key}>
            <dt>{step.label}</dt>
            <dd style={{ margin: 0, fontSize: 24 }}>
              {step.users.toLocaleString("ru-RU")}
              {registered > 0 && (
                <small>
                  {" "}
                  · {((step.users / registered) * 100).toFixed(1)}%
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Активность по дням</summary>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", textAlign: "left", borderSpacing: 8 }}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Активные</th>
                <th>Сообщения пользователей</th>
                <th>Ответы помощников</th>
                <th>Оплачено</th>
              </tr>
            </thead>
            <tbody>
              {funnel.recentActivity.map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>{day.activeUsers}</td>
                  <td>{day.userMessages}</td>
                  <td>{day.assistantMessages}</td>
                  <td>{customerMoney(day.paidMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
