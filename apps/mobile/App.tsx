import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Switch,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  createClient,
  createSessionGuard,
  createSessionStorage,
  createSessionLogout,
  type SessionTicket,
} from "@citygo/api-client";
import {
  changePasswordSchema,
  credentialsSchema,
  loginSchema,
  formatMoneyMicros,
  formatSignedMoneyMicros,
  type Dashboard,
} from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";
import { Button, Card, Field } from "@citygo/ui-native";
import { questChecklist } from "@citygo/content";
import {
  hasEmptyChargeBalance,
  messageInterruptionLabel,
} from "./src/chat-readiness";
import {
  allQuestsCompleted,
  canStopChat,
  completeQuest,
  completionNotice,
  createOperations,
  operationLabel,
  type CompletionReceipt,
  type OperationKind,
  type OperationTicket,
  type PendingOperation,
} from "./src/flow";
const tokenStore = createSessionStorage({
  get: () => SecureStore.getItemAsync("citygo.session"),
  set: (token) => SecureStore.setItemAsync("citygo.session", token),
  remove: () => SecureStore.deleteItemAsync("citygo.session"),
});
export default function App() {
  const session = useRef<string | null>(null);
  const [lifetime] = useState(createSessionGuard);
  const [logoutAttempt] = useState(() => createSessionLogout(tokenStore));
  const refreshVersion = useRef(0);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [operations] = useState(() => createOperations(setPending));
  const busy = pending !== null;
  const [completion, setCompletion] = useState<CompletionReceipt | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const base = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
  const api = useMemo(
    () =>
      createClient(base, {
        fetch: expoFetch,
        native: true,
        token: () => session.current,
        signal: () => lifetime.capture().signal,
        onUnauthorized: () => {
          void endSession(false);
        },
      }),
    [base, lifetime],
  );
  const [board, setBoard] = useState<Dashboard | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [mode, setMode] = useState<"login" | "register">("login");
  const [showPasswordChange, setShowPasswordChange] = useState(false),
    [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [changingPassword, setChangingPassword] = useState(false);
  const [text, setText] = useState(""),
    [draft, setDraft] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  const contentScroll = useRef<ScrollView | null>(null);
  const balanceSection = useRef<View | null>(null);
  const scrollOffset = useRef(0);
  function showBalance() {
    const scroll = contentScroll.current;
    const target = balanceSection.current;
    const viewport = scroll?.getNativeScrollRef();
    if (!scroll || !target || !viewport) return;
    viewport.measureInWindow((_x, viewportY) => {
      target.measureInWindow((_targetX, targetY) => {
        scroll.scrollTo({
          y: Math.max(0, scrollOffset.current + targetY - viewportY),
          animated: true,
        });
      });
    });
  }
  function clearUserState(owner?: string) {
    lifetime.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setEmail("");
    setPassword("");
    setShowPasswordChange(false);
    setCurrentPassword("");
    setNewPassword("");
    setChangingPassword(false);
    setConfirmed(false);
    setText("");
    setDraft("");
    setNotice("");
    setCompletion(null);
    setError("");
    operations.reset();
    setReady(true);
  }
  async function refresh(ticket = lifetime.capture()) {
    ticket.check();
    const version = ++refreshVersion.current;
    const next = await api.dashboard();
    ticket.check();
    if (version !== refreshVersion.current) return;
    if (lifetime.ownerChanged(next.user.id)) {
      clearUserState(next.user.id);
      setBoard(next);
      ticket.check();
    }
    setBoard(next);
    setCompletion((receipt) =>
      receipt ? { ...receipt, quests: next.quests } : null,
    );
    return next;
  }
  async function endSession(revoke: boolean) {
    const oldToken = session.current;
    session.current = null;
    clearUserState();
    const ticket = lifetime.capture();
    const operation = operations.begin("logout")!;
    setStorageBlocked(true);
    try {
      // Always remove the device credential, even when the server is offline.
      const result = await logoutAttempt.run(
        revoke && oldToken
          ? async () => {
              // This callback may run after retrying failed local deletion.
              // Keep the original credential/intent, not the previous UI ticket.
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 10000);
              try {
                await createClient(base, {
                  fetch: expoFetch,
                  native: true,
                  token: () => oldToken,
                  signal: () => controller.signal,
                }).logout();
              } finally {
                clearTimeout(timer);
              }
            }
          : undefined,
      );
      ticket.check();
      setStorageBlocked(false);
      setNotice(
        !result.revocationRequested
          ? "Сессия завершилась. Войдите снова."
          : result.serverRevoked
            ? "Вы вышли из аккаунта."
            : "Локальный выход выполнен. Отзыв сессии на сервере не подтверждён: нет связи или сервер недоступен.",
      );
    } catch {
      if (ticket.active())
        setError(
          "Не удалось удалить сохранённую сессию с устройства. Повторите очистку перед новым входом.",
        );
    } finally {
      operation.finish();
    }
  }
  function authenticate() {
    if (operations.current() || storageBlocked) return;
    const parsed = (
      mode === "login" ? loginSchema : credentialsSchema
    ).safeParse({ email, password });
    if (!parsed.success) {
      setError(
        mode === "login"
          ? "Введите логин или электронную почту и пароль."
          : "Укажите электронную почту и пароль от 6 до 128 любых символов.",
      );
      return;
    }
    const input = { mode, ...parsed.data };
    session.current = null;
    clearUserState();
    void act("auth", async (ticket) => {
      // A failed initial restore may leave A's credential on disk while the
      // sign-in form is visible. Clear it before attempting a different login.
      try {
        await tokenStore.clear();
      } catch {
        if (ticket.active()) setStorageBlocked(true);
        throw new Error(
          "Не удалось удалить сохранённую сессию с устройства. Повторите очистку перед новым входом.",
        );
      }
      ticket.check();
      const result = await api.auth(input.mode, input.email, input.password);
      if (!result.token) throw new Error("Сервер не вернул сессию");
      await tokenStore.save(result.token, ticket);
      ticket.check();
      session.current = result.token;
      await refresh(ticket);
    });
  }
  function changePassword() {
    if (operations.current() || storageBlocked || !board) return;
    const input = changePasswordSchema.safeParse({
      currentPassword,
      password: newPassword,
    });
    if (!input.success) {
      setError(
        "Введите текущий пароль и новый пароль от 6 до 128 любых символов.",
      );
      return;
    }
    const owner = board.user.id;
    void act("auth", async (ticket) => {
      setChangingPassword(true);
      try {
        const result = await api.changePassword(
          input.data.currentPassword,
          input.data.password,
        );
        ticket.check();
        if (!result.token || result.user.id !== owner) {
          await endSession(false);
          return;
        }
        try {
          // The server rotated this credential. Serialize its write with logout;
          // a stale ticket must never publish or restore another account's token.
          await tokenStore.save(result.token, ticket);
          ticket.check();
        } catch {
          if (!ticket.active()) return;
          await endSession(false);
          setError(
            "Пароль изменён, но не удалось сохранить новую сессию. После очистки устройства войдите с новым паролем.",
          );
          return;
        }
        session.current = result.token;
        setBoard((current) =>
          current?.user.id === owner
            ? { ...current, user: result.user }
            : current,
        );
        setCurrentPassword("");
        setNewPassword("");
        setShowPasswordChange(false);
        await refresh(ticket);
        ticket.check();
        setNotice("Пароль изменён. Остальные сессии аккаунта завершены.");
      } finally {
        if (ticket.active()) setChangingPassword(false);
      }
    });
  }
  useEffect(() => {
    const ticket = lifetime.capture();
    void (async () => {
      const token = await tokenStore.load(ticket);
      ticket.check();
      session.current = token;
      if (token) await refresh(ticket);
    })()
      .catch((e) => {
        if (ticket.active()) setError(e.message);
      })
      .finally(() => {
        if (ticket.active()) setReady(true);
      });
    return () => {
      lifetime.reset();
      abort.current?.abort();
      operations.reset();
    };
  }, []);
  const quest =
    board?.quests.find((q) => q.state === "in_progress") ??
    board?.quests.find((q) => q.state === "available");
  useEffect(() => setConfirmed(false), [quest?.id]);
  async function act(
    kind: OperationKind,
    work: (ticket: SessionTicket, operation: OperationTicket) => Promise<void>,
  ) {
    const operation = operations.begin(kind);
    if (!operation) return;
    const ticket = lifetime.capture();
    setError("");
    setNotice("");
    try {
      await work(ticket, operation);
    } catch (e) {
      if (ticket.active())
        setError(e instanceof Error ? e.message : "Ошибка запроса");
    } finally {
      operation.finish();
    }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <StatusBar barStyle="dark-content" />
          <ScrollView
            ref={contentScroll}
            onScroll={(event) => {
              scrollOffset.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.header}>
              <Text style={styles.logo}>CityGo</Text>
              <Text>{board ? board.xp + " XP" : "Ваш новый город"}</Text>
            </View>
            {!!error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            {!!notice && <Text>{notice}</Text>}
            {completion && (
              <Text accessibilityLiveRegion="polite">
                {completionNotice(completion)}
              </Text>
            )}
            {pending && (
              <Text accessibilityLiveRegion="polite">
                {changingPassword
                  ? "Меняем пароль…"
                  : pending.kind === "start" && !board?.thread
                    ? "Открываем диалог…"
                    : operationLabel(pending)}
              </Text>
            )}
            {storageBlocked && (
              <Button
                title="Повторить очистку сессии"
                disabled={busy}
                onPress={() => void endSession(false)}
              />
            )}
            {!ready ? (
              <Text>Загрузка…</Text>
            ) : !board ? (
              <Card>
                <Text style={styles.title}>
                  {mode === "login" ? "С возвращением" : "Начнём переезд"}
                </Text>
                <Field
                  label={
                    mode === "login"
                      ? "Логин или электронная почта"
                      : "Электронная почта"
                  }
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType={mode === "login" ? "default" : "email-address"}
                  autoComplete={mode === "login" ? "username" : "email"}
                  maxLength={254}
                  editable={!busy && !storageBlocked}
                />
                <Field
                  label={
                    mode === "login" ? "Пароль" : "Пароль · от 6 любых символов"
                  }
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  maxLength={128}
                  editable={!busy && !storageBlocked}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                />
                <Button
                  title={mode === "login" ? "Войти" : "Создать аккаунт"}
                  disabled={busy || storageBlocked}
                  onPress={authenticate}
                />
                <Button
                  title={
                    mode === "login"
                      ? "Создать новый аккаунт"
                      : "Уже есть аккаунт"
                  }
                  disabled={busy || storageBlocked}
                  onPress={() =>
                    setMode(mode === "login" ? "register" : "login")
                  }
                />
              </Card>
            ) : board.user.mustChangePassword || showPasswordChange ? (
              <Card>
                <Text style={styles.title}>Смена пароля</Text>
                <Text>
                  {board.user.mustChangePassword
                    ? "Перед продолжением замените временный пароль. Пока он не изменён, чат и администрирование недоступны."
                    : "После смены пароля остальные сессии аккаунта завершатся."}
                </Text>
                <Field
                  label="Текущий пароль"
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  maxLength={128}
                  editable={!busy}
                />
                <Field
                  label="Новый пароль · от 6 любых символов"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry
                  autoComplete="new-password"
                  maxLength={128}
                  editable={!busy}
                />
                <Button
                  title="Сохранить новый пароль"
                  disabled={busy || storageBlocked}
                  onPress={changePassword}
                />
                {!board.user.mustChangePassword && (
                  <Button
                    title="Отмена"
                    disabled={busy}
                    onPress={() => {
                      setShowPasswordChange(false);
                      setCurrentPassword("");
                      setNewPassword("");
                    }}
                  />
                )}
              </Card>
            ) : (
              <>
                <Card>
                  <Text style={styles.title}>
                    {board.profile
                      ? `Ваш переезд в ${board.profile.targetCity}`
                      : "Начните с разговора"}
                  </Text>
                  {board.profile ? (
                    <Text>
                      {board.profile.monthlyBudget.toLocaleString("ru-RU")} ₽ /
                      месяц · {board.profile.moveTargetDate}
                    </Text>
                  ) : (
                    <Text>
                      Помощник уточнит вашу ситуацию постепенно и поможет с
                      первым шагом. Если бюджет, дата или район пока неизвестны
                      — это нормально. Обязательной анкеты нет.
                    </Text>
                  )}
                  {board.quests.map((q) => (
                    <Text key={q.id}>
                      {q.state === "completed" ? "✓" : "○"} {q.title}
                    </Text>
                  ))}
                  <Button
                    title="Обновить состояние"
                    disabled={busy}
                    onPress={() =>
                      void act("refresh", async (ticket) => {
                        await refresh(ticket);
                      })
                    }
                  />
                  {!board.thread && (
                    <Button
                      title="Начать диалог"
                      disabled={busy}
                      onPress={() =>
                        void act("start", async (ticket) => {
                          await api.startConversation();
                          await refresh(ticket);
                        })
                      }
                    />
                  )}
                </Card>
                {allQuestsCompleted(board.quests) && (
                  <Card>
                    <Text style={styles.title}>Все квесты плана завершены</Text>
                    <Text>
                      Прогресс сохранён. История чата остаётся доступной; новых
                      квестов в текущем плане пока нет.
                    </Text>
                  </Card>
                )}
                {quest && (
                  <Card>
                    <Text style={styles.title}>{quest.title}</Text>
                    <Text>Награда: +{quest.xpReward} XP</Text>
                    {quest.state === "available" ? (
                      <Button
                        title="Начать квест"
                        disabled={busy}
                        onPress={() =>
                          void act("start", async (ticket) => {
                            setCompletion(null);
                            await api.start(quest.id);
                            await refresh(ticket);
                          })
                        }
                      />
                    ) : (
                      <>
                        {questChecklist(quest.slug).map((item) => (
                          <Text key={item}>• {item}</Text>
                        ))}
                        <View style={styles.row}>
                          <Switch
                            accessibilityLabel="Критерии обсуждены"
                            value={confirmed}
                            onValueChange={setConfirmed}
                            disabled={busy || completion?.questId === quest.id}
                          />
                          <Text style={styles.flex}>
                            Обсудил(а) критерии и готов(а) двигаться дальше
                          </Text>
                        </View>
                        <Button
                          title={`Завершить · +${quest.xpReward} XP`}
                          disabled={
                            busy ||
                            !confirmed ||
                            completion?.questId === quest.id
                          }
                          onPress={() =>
                            void act("complete", (ticket) =>
                              completeQuest({
                                questId: quest.id,
                                complete: api.complete,
                                refresh,
                                ticket,
                                received: (receipt) => {
                                  setCompletion(receipt);
                                  setConfirmed(false);
                                },
                              }),
                            )
                          }
                        />
                      </>
                    )}
                  </Card>
                )}
                <Card>
                  <Text style={styles.title}>
                    {board.thread?.agentKey ?? "Помощник CityGo"} · AI
                  </Text>
                  <Text>
                    Не отправляйте документы и платёжные данные. Ответы AI нужно
                    проверять.
                  </Text>
                  {board.provider === "unconfigured" && (
                    <Text>AI пока не подключён на сервере.</Text>
                  )}
                  <Text style={styles.title}>Передача данных AI</Text>
                  {board.aiAccess?.credit && (
                    <View
                      ref={balanceSection}
                      collapsable={false}
                      testID="citygo-balance"
                    >
                      <Text style={styles.title}>
                        {board.aiAccess.credit.chargingStatus ===
                        "routerai_citygo_10x"
                          ? "Баланс CityGo"
                          : "Бесплатный баланс AI"}{" "}
                        · аккаунт {board.user.id}
                      </Text>
                      <Text>
                        {board.aiAccess.credit.bonusGranted
                          ? "Разовые 500 ₽ начислены. Ежедневного восстановления нет."
                          : board.aiAccess.credit.chargingStatus ===
                              "routerai_citygo_10x"
                            ? "Подарок 500 ₽ CityGo выдаётся после подтверждения телефона. Подтверждение пока не подключено."
                            : "Разовый бонус 500 ₽ ещё не выдан. Обратитесь к владельцу пилота."}
                      </Text>
                      <Text>
                        Доступно:{" "}
                        {formatSignedMoneyMicros(
                          board.aiAccess.credit.availableMicros,
                        )}{" "}
                        ₽. В резерве:{" "}
                        {formatMoneyMicros(board.aiAccess.credit.heldMicros)} ₽.
                        Учтено списаний:{" "}
                        {formatMoneyMicros(board.aiAccess.credit.spentMicros)}{" "}
                        ₽.
                      </Text>
                      {board.aiAccess.credit.reservationMode ===
                        "fixed5_overdraft" && (
                        <Text>
                          Перед платным запросом резервируется 5 ₽ CityGo. Это
                          не итоговая цена: спишется полная подтверждённая
                          стоимость модели ×10. Если средств не хватит, баланс
                          станет отрицательным. Новые платные запросы доступны
                          после пополнения до 5 ₽ свободного баланса; пополнение
                          сначала погашает задолженность.
                        </Text>
                      )}
                      {(board.aiAccess.credit.outstandingDebtMicros ?? 0) >
                        0 && (
                        <Text>
                          Задолженность:{" "}
                          {formatSignedMoneyMicros(
                            board.aiAccess.credit.outstandingDebtMicros!,
                          )}{" "}
                          ₽ CityGo. Она будет погашена из следующих пополнений.
                        </Text>
                      )}
                      <Text>
                        {board.aiAccess.credit.chargingStatus ===
                        "routerai_citygo_10x"
                          ? "Расход модели 1 ₽ соответствует списанию 10 ₽ CityGo. Оплата 100 ₽ пополняет баланс на 100 ₽ CityGo. Неизвестная стоимость остаётся в резерве до сверки."
                          : board.aiAccess.credit.chargingStatus ===
                              "routerai_at_cost"
                            ? "Ответы RouterAI — по подтверждённой стоимости без наценки. Неизвестная стоимость остаётся в резерве до сверки. Доли микрорубля округляются вниз."
                            : "Автоматическое списание за ответы пока не подключено."}{" "}
                        {board.aiAccess.credit.topUpAvailable
                          ? "Для пополнения воспользуйтесь веб-кабинетом CityGo. В мобильном приложении оплата пока не подключена."
                          : "Пополнение пока недоступно."}{" "}
                        Баланс не включает ИИ.
                      </Text>
                      {board.aiAccess.credit.pending?.map((item) => (
                        <Text key={item.holdId}>
                          Резерв на сверке {item.holdId}:{" "}
                          {formatMoneyMicros(item.amountMicros)} ₽.
                        </Text>
                      ))}
                    </View>
                  )}
                  {board.aiAccess?.policy ? (
                    <>
                      <Text>
                        Получатель: {board.aiAccess.policy.recipient}. Модель:{" "}
                        {board.aiAccess.policy.model}.
                      </Text>
                      <Text>{board.aiAccess.policy.routing}</Text>
                      <Text>{board.aiAccess.policy.data}</Text>
                      <Text>
                        До {board.aiAccess.dailyLimit} принятых запросов в сутки
                        (UTC). Возможен общий лимит сервиса. Автоматического
                        переключения нет.
                      </Text>
                      {board.aiAccess.granted ? (
                        <Text>Передача разрешена.</Text>
                      ) : (
                        <Button
                          title="Разрешить передачу этому AI-получателю"
                          disabled={busy}
                          onPress={() =>
                            void act("consent", async (ticket) => {
                              try {
                                await api.aiConsent({
                                  action: "granted",
                                  policyId: board.aiAccess.policy!.id,
                                });
                              } finally {
                                if (ticket.active()) await refresh(ticket);
                              }
                            })
                          }
                        />
                      )}
                    </>
                  ) : (
                    <Text>
                      Условия подключения недоступны. Обновите приложение перед
                      отправкой сообщения.
                    </Text>
                  )}
                  <Text>
                    Отзыв блокирует новые запросы. Уже принятый запрос может
                    завершиться; переданные данные нельзя вернуть. План и
                    история остаются доступны.
                  </Text>
                  <Button
                    title="Отозвать разрешение AI"
                    disabled={busy}
                    onPress={() =>
                      void act("consent", async (ticket) => {
                        try {
                          await api.aiConsent({ action: "revoked" });
                        } finally {
                          if (ticket.active()) await refresh(ticket);
                        }
                      })
                    }
                  />
                  {board.thread?.messages.map((m) => (
                    <View key={m.id} style={styles.message}>
                      <Text style={{ fontWeight: "700" }}>
                        {m.role === "user" ? "Вы" : m.agentKey}
                      </Text>
                      <Text>{m.content || "Ответ не получен"}</Text>
                      {m.status === "interrupted" && (
                        <Text>{messageInterruptionLabel(m)}</Text>
                      )}
                    </View>
                  ))}
                  {!!draft && <Text>{draft}</Text>}
                  {hasEmptyChargeBalance(board.aiAccess) && (
                    <View>
                      <Text>
                        {board.aiAccess.credit?.reservationMode ===
                        "fixed5_overdraft"
                          ? "Для нового платного ответа ИИ нужно не менее 5 ₽ CityGo доступного баланса. Пополнение сначала погашает задолженность. Проверку резерва выполняет сервер."
                          : "На балансе недостаточно доступных средств для платного ответа ИИ. Необходимый резерв проверяется сервером."}
                      </Text>
                      <Text
                        accessibilityRole="link"
                        onPress={showBalance}
                        style={{ textDecorationLine: "underline" }}
                      >
                        Баланс и пополнение
                      </Text>
                    </View>
                  )}
                  <Field
                    label="Сообщение помощнику"
                    value={text}
                    onChangeText={setText}
                    multiline
                    maxLength={4000}
                    editable={!busy}
                  />
                  <Button
                    title="Отправить"
                    disabled={
                      busy ||
                      !text.trim() ||
                      !board.thread ||
                      !board.aiAccess?.granted ||
                      board.provider === "unconfigured"
                    }
                    onPress={() =>
                      void act("chat", async (ticket, operation) => {
                        const message = text;
                        setText("");
                        setDraft("");
                        const controller = new AbortController();
                        abort.current = controller;
                        try {
                          await api.stream(
                            board.thread!.id,
                            message,
                            randomUUID(),
                            (event) => {
                              if (!ticket.active()) return;
                              if (event.type === "delta")
                                setDraft((v) => v + event.text);
                              if (event.type === "handoff")
                                setNotice(event.reason);
                            },
                            controller.signal,
                            board.aiAccess.policy?.id,
                            board.aiAccess.credit?.reservationMode,
                          );
                        } catch (e) {
                          // A stale consent or quota rejection must not discard
                          // the user's draft; resubmission remains explicit.
                          if (!ticket.active()) return;
                          if (!controller.signal.aborted) {
                            setText(message);
                            throw e;
                          }
                          setNotice("Ответ остановлен.");
                        } finally {
                          operation.refreshing();
                          try {
                            if (ticket.active()) await refresh(ticket);
                          } finally {
                            if (ticket.active()) {
                              setDraft("");
                              abort.current = null;
                            }
                          }
                        }
                      })
                    }
                  />
                  {canStopChat(pending) && (
                    <Button
                      title="Прервать ответ"
                      onPress={() =>
                        operations.stopChat(() => abort.current?.abort())
                      }
                    />
                  )}
                </Card>
                <Card>
                  <Text style={styles.title}>Профиль</Text>
                  <Text>{board.user.username ?? board.user.email}</Text>
                  <Text>Роль: {board.user.role ?? "не указана сервером"}</Text>
                  <Button
                    title="Изменить пароль"
                    disabled={busy}
                    onPress={() => {
                      setShowPasswordChange(true);
                      setCurrentPassword("");
                      setNewPassword("");
                    }}
                  />
                </Card>
              </>
            )}
            {board && (
              <Button title="Выйти" onPress={() => void endSession(true)} />
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.color.background },
  content: { padding: 20, paddingTop: 20, paddingBottom: 50, gap: 20 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  logo: { fontSize: 30, fontWeight: "800", color: tokens.color.primaryStrong },
  title: { fontSize: 23, fontWeight: "700", color: tokens.color.foreground },
  error: { color: tokens.color.danger },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  flex: { flex: 1 },
  message: {
    backgroundColor: "#edf0fc",
    padding: 14,
    borderRadius: 12,
    gap: 7,
  },
});
