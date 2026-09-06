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
import { createClient, ApiError } from "@citygo/api-client";
import { questionnaireSchema, type Dashboard } from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";
import { Button, Card, Field } from "@citygo/ui-native";
import { housingChecklist } from "@citygo/content";
export default function App() {
  const session = useRef<string | null>(null);
  const base = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
  const api = useMemo(
    () => createClient(base, { native: true, token: () => session.current }),
    [base],
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
  async function refresh() {
    try {
      setBoard(await api.dashboard());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        session.current = null;
        await SecureStore.deleteItemAsync("citygo.session");
        setBoard(null);
      } else throw e;
    }
  }
  useEffect(() => {
    void (async () => {
      session.current = await SecureStore.getItemAsync("citygo.session");
      if (session.current) await refresh();
    })()
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
    return () => abort.current?.abort();
  }, []);
  const quest =
    board?.quests.find((q) => q.state === "in_progress") ??
    board?.quests.find((q) => q.state === "available");
  useEffect(() => setConfirmed(false), [quest?.id]);
  async function act(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка запроса");
    } finally {
      setBusy(false);
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
                  disabled={busy}
                  onPress={() =>
                    void act(async () => {
                      const result = await api.auth(mode, email, password);
                      if (!result.token)
                        throw new Error("Сервер не вернул сессию");
                      session.current = result.token;
                      await SecureStore.setItemAsync(
                        "citygo.session",
                        result.token,
                      );
                      setPassword("");
                      await refresh();
                    })
                  }
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
                    accessibilityLabel="Согласие на обработку анкеты AI"
                    value={consent}
                    onValueChange={setConsent}
                  />
                  <Text style={styles.flex}>
                    Разрешаю передавать город, бюджет, дату и состав семьи
                    AI-провайдеру.
                  </Text>
                </View>
                <Button
                  title="Получить план"
                  disabled={busy || !consent}
                  onPress={() =>
                    void act(async () => {
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
                      await refresh();
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
                          void act(async () => {
                            await api.start(quest.id);
                            await refresh();
                          })
                        }
                      />
                    ) : (
                      <>
                        {housingChecklist.map((item) => (
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
                            void act(async () => {
                              const result = await api.complete(quest.id);
                              setNotice(
                                result.awarded
                                  ? "+60 XP — следующий шаг открыт"
                                  : "Награда уже получена",
                              );
                              await refresh();
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
                      board.provider === "unconfigured"
                    }
                    onPress={() =>
                      void act(async () => {
                        const message = text;
                        setText("");
                        setDraft("");
                        abort.current = new AbortController();
                        try {
                          await api.stream(
                            board.thread!.id,
                            message,
                            randomUUID(),
                            (event) => {
                              if (event.type === "delta")
                                setDraft((v) => v + event.text);
                              if (event.type === "handoff")
                                setNotice(event.reason);
                            },
                            abort.current.signal,
                          );
                        } finally {
                          await refresh();
                          setDraft("");
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
              <Button
                title="Выйти"
                disabled={busy}
                onPress={() =>
                  void act(async () => {
                    await api.logout();
                    session.current = null;
                    await SecureStore.deleteItemAsync("citygo.session");
                    setBoard(null);
                  })
                }
              />
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
