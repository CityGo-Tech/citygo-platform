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
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  createClient,
  createSessionGuard,
  createSessionStorage,
  createSessionLogout,
  type SessionTicket,
} from "@citygo/api-client";
import { questionnaireSchema, type Dashboard } from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";
import { Button, Card, Field } from "@citygo/ui-native";
import { questChecklist } from "@citygo/content";
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
  const [storageBlocked, setStorageBlocked] = useState(false);
  const base = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
  const api = useMemo(
    () =>
      createClient(base, {
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [mode, setMode] = useState<"login" | "register">("login");
  const [household, setHousehold] = useState<"solo" | "couple" | "family">(
    "solo",
  );
  const [origin, setOrigin] = useState(""),
    [target, setTarget] = useState(""),
    [budget, setBudget] = useState(""),
    [date, setDate] = useState(""),
    [consent, setConsent] = useState(false);
  const [text, setText] = useState(""),
    [draft, setDraft] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  function clearUserState(owner?: string) {
    lifetime.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setEmail("");
    setPassword("");
    setOrigin("");
    setTarget("");
    setBudget("");
    setDate("");
    setHousehold("solo");
    setConsent(false);
    setConfirmed(false);
    setText("");
    setDraft("");
    setNotice("");
    setError("");
    setBusy(false);
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
  }
  async function endSession(revoke: boolean) {
    const oldToken = session.current;
    session.current = null;
    clearUserState();
    const ticket = lifetime.capture();
    setBusy(true);
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
      if (ticket.active()) setBusy(false);
    }
  }
  function authenticate() {
    if (busy || storageBlocked) return;
    const input = { mode, email, password };
    session.current = null;
    clearUserState();
    void act(async (ticket) => {
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
    };
  }, []);
  const quest =
    board?.quests.find((q) => q.state === "in_progress") ??
    board?.quests.find((q) => q.state === "available");
  useEffect(() => setConfirmed(false), [quest?.id]);
  async function act(work: (ticket: SessionTicket) => Promise<void>) {
    const ticket = lifetime.capture();
    setError("");
    setBusy(true);
    try {
      await work(ticket);
    } catch (e) {
      if (ticket.active())
        setError(e instanceof Error ? e.message : "Ошибка запроса");
    } finally {
      if (ticket.active()) setBusy(false);
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
                  label="Электронная почта"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                />
                <Field
                  label="Пароль · от 12 символов"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
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
                  onPress={() =>
                    setMode(mode === "login" ? "register" : "login")
                  }
                />
              </Card>
            ) : !board.profile ? (
              <Card>
                <Text style={styles.title}>Куда отправимся?</Text>
                <Field label="Откуда" value={origin} onChangeText={setOrigin} />
                <Field
                  label="Город назначения"
                  value={target}
                  onChangeText={setTarget}
                />
                <Field
                  label="Бюджет аренды, ₽"
                  value={budget}
                  onChangeText={setBudget}
                  keyboardType="number-pad"
                />
                <Field
                  label="Дата переезда · ГГГГ-ММ-ДД"
                  value={date}
                  onChangeText={setDate}
                />
                <Text>Кто переезжает</Text>
                {(["solo", "couple", "family"] as const).map((value) => (
                  <Button
                    key={value}
                    title={
                      (household === value ? "✓ " : "") +
                      {
                        solo: "Один / одна",
                        couple: "Вдвоём",
                        family: "С семьёй",
                      }[value]
                    }
                    onPress={() => setHousehold(value)}
                  />
                ))}
                <View style={styles.row}>
                  <Switch
                    accessibilityLabel="Использование анкеты для плана"
                    value={consent}
                    onValueChange={setConsent}
                  />
                  <Text style={styles.flex}>
                    Разрешаю CityGo использовать анкету для плана. Передача
                    AI-получателю подтверждается отдельно перед чатом.
                  </Text>
                </View>
                <Button
                  title="Получить план"
                  disabled={busy || !consent}
                  onPress={() =>
                    void act(async (ticket) => {
                      const parsed = questionnaireSchema.safeParse({
                        originCity: origin,
                        targetCity: target,
                        monthlyBudget: Number(budget),
                        moveTargetDate: date,
                        household,
                        aiConsent: consent,
                      });
                      if (!parsed.success)
                        throw new Error(
                          "Проверьте города, бюджет от 5000 ₽ и будущую дату ГГГГ-ММ-ДД",
                        );
                      await api.questionnaire(parsed.data);
                      await refresh(ticket);
                    })
                  }
                />
              </Card>
            ) : (
              <>
                <Card>
                  <Text style={styles.title}>
                    Ваш переезд в {board.profile.targetCity}
                  </Text>
                  <Text>
                    {board.profile.monthlyBudget.toLocaleString("ru-RU")} ₽ /
                    месяц · {board.profile.moveTargetDate}
                  </Text>
                  {board.quests.map((q) => (
                    <Text key={q.id}>
                      {q.state === "completed" ? "✓" : "○"} {q.title}
                    </Text>
                  ))}
                </Card>
                {quest && (
                  <Card>
                    <Text style={styles.title}>{quest.title}</Text>
                    <Text>Награда: +60 XP</Text>
                    {quest.state === "available" ? (
                      <Button
                        title="Начать квест"
                        disabled={busy}
                        onPress={() =>
                          void act(async (ticket) => {
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
                          />
                          <Text style={styles.flex}>
                            Обсудил(а) критерии и готов(а) двигаться дальше
                          </Text>
                        </View>
                        <Button
                          title="Завершить · +60 XP"
                          disabled={busy || !confirmed}
                          onPress={() =>
                            void act(async (ticket) => {
                              const result = await api.complete(quest.id);
                              ticket.check();
                              setNotice(
                                result.awarded
                                  ? "+60 XP — следующий шаг открыт"
                                  : "Награда уже получена",
                              );
                              await refresh(ticket);
                            })
                          }
                        />
                      </>
                    )}
                  </Card>
                )}
                <Card>
                  <Text style={styles.title}>
                    {board.thread?.agentKey ?? "Housing Navigator"} · AI
                  </Text>
                  <Text>
                    Не отправляйте документы и платёжные данные. Ответы AI нужно
                    проверять.
                  </Text>
                  {board.provider === "unconfigured" && (
                    <Text>AI пока не подключён на сервере.</Text>
                  )}
                  <Text style={styles.title}>Передача данных AI</Text>
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
                            void act(async (ticket) => {
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
                      void act(async (ticket) => {
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
                      {m.status === "interrupted" && <Text>Ответ прерван</Text>}
                    </View>
                  ))}
                  {!!draft && <Text>{draft}</Text>}
                  <Field
                    label="Сообщение помощнику"
                    value={text}
                    onChangeText={setText}
                    multiline
                    maxLength={4000}
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
                      void act(async (ticket) => {
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
                          );
                        } catch (e) {
                          // A stale consent or quota rejection must not discard
                          // the user's draft; resubmission remains explicit.
                          if (ticket.active() && !controller.signal.aborted)
                            setText(message);
                          throw e;
                        } finally {
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
                  {busy && (
                    <Button
                      title="Прервать ответ"
                      onPress={() => abort.current?.abort()}
                    />
                  )}
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
