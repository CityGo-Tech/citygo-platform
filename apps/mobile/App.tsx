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
  Linking,
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
  ApiError,
  captureAiModeSelection,
  isAiModeAvailable,
  type AiModeConsentView,
  type SessionTicket,
} from "@citygo/api-client";
import {
  changePasswordSchema,
  credentialsSchema,
  loginSchema,
  formatMoneyMicros,
  formatSignedMoneyMicros,
  type Dashboard,
  type AiModeId,
} from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";
import { Button, Card, Field } from "@citygo/ui-native";
import { questChecklist } from "@citygo/content";
import { MobilePasswordRecovery } from "./src/password-recovery";
import { MobileAiModeSelector } from "./src/ai-mode-selector";
import { MobileAiModeConsentModal } from "./src/ai-mode-consent-modal";
import { createMobileAiModeConsent } from "./src/ai-mode-consent";
import { MobileServiceConsents } from "./src/service-consents";
import {
  changeServiceConsent,
  createServiceConsentForm,
  currentServiceConsentForm,
  registrationConsentMatchesPolicy,
  serviceConsentChoice,
  type ServiceConsentForm,
} from "./src/service-consent-state";
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
const webAppUrl = "https://app.xn--c1ajazlh.xn--p1ai";
export default function App() {
  const session = useRef<string | null>(null);
  const [lifetime] = useState(createSessionGuard);
  const [logoutAttempt] = useState(() => createSessionLogout(tokenStore));
  const refreshVersion = useRef(0);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [operations] = useState(() => createOperations(setPending));
  const [modeConsentView, setModeConsentView] = useState<AiModeConsentView>({
    phase: "closed",
  });
  const modeConsentOpen = useRef(false);
  const modeConsent = useRef<ReturnType<
    typeof createMobileAiModeConsent
  > | null>(null);
  const busy = pending !== null || modeConsentView.phase !== "closed";
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
  const [selectedAiMode, setSelectedAiMode] = useState<AiModeId>("balanced");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [consentForm, setConsentForm] = useState<ServiceConsentForm | null>(
    null,
  );
  const [consentLoading, setConsentLoading] = useState(false),
    [consentLoadError, setConsentLoadError] = useState(""),
    [consentReload, setConsentReload] = useState(0);
  const [registrationAvailability, setRegistrationAvailability] = useState<
    "loading" | "disabled" | "required" | "unavailable"
  >("loading");
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
    modeConsent.current?.cancel();
    lifetime.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setSelectedAiMode("balanced");
    setEmail("");
    setPassword("");
    setMode("login");
    setConsentForm(null);
    setConsentLoading(false);
    setConsentLoadError("");
    setRegistrationAvailability("loading");
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
    if (mode === "recover") return;
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
    const consents =
      mode === "register"
        ? serviceConsentChoice(consentForm, consentScope)
        : undefined;
    if (mode === "register" && !consents) {
      setError(
        "Прочитайте условия и подтвердите согласие на обработку данных.",
      );
      return;
    }
    // Capture this exact version and explicit choice before clearing the view.
    const input = { mode, ...parsed.data, consents: consents ?? undefined };
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
      if (input.mode === "register") {
        const policy = await api.registrationPolicy();
        ticket.check();
        if (policy.emailVerification !== "disabled") {
          setPassword("");
          setMode("register");
          throw new Error(
            policy.emailVerification === "required"
              ? "Для регистрации с подтверждением почты откройте веб-версию CityGo. Затем войдите здесь с созданным аккаунтом."
              : "Регистрация временно недоступна: отправка писем ещё не подключена. Если аккаунт уже есть, войдите.",
          );
        }
        if (
          !registrationConsentMatchesPolicy(
            input.consents,
            policy.consentPolicy,
          )
        ) {
          setMode("register");
          setEmail(input.email);
          setConsentForm(null);
          setConsentReload((version) => version + 1);
          throw new Error(
            "Условия регистрации изменились. Прочитайте актуальные условия и подтвердите согласие заново.",
          );
        }
      }
      let result;
      try {
        result = await api.auth(
          input.mode,
          input.email,
          input.password,
          input.consents,
        );
      } catch (failure) {
        if (ticket.active() && input.mode === "register") {
          setMode("register");
          setEmail(input.email);
        }
        throw failure;
      }
      if (!result.token) throw new Error("Сервер не вернул сессию");
      await tokenStore.save(result.token, ticket);
      ticket.check();
      session.current = result.token;
      await refresh(ticket);
    });
  }
  function acceptServiceConsents() {
    if (operations.current() || storageBlocked || !board) return;
    const choice = serviceConsentChoice(consentForm, consentScope);
    if (!choice) return;
    void act("refresh", async (ticket) => {
      await api.setAccountConsents(choice);
      ticket.check();
      await refresh(ticket);
      ticket.check();
      setConsentForm(null);
      setNotice("Согласия сохранены.");
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
        setConsentForm(null);
        setConsentReload((version) => version + 1);
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
    // The selection owns a synchronous gate too: React may not have rendered
    // disabled controls yet when a second press arrives.
    if (modeConsentOpen.current) return;
    const operation = operations.begin(kind);
    if (!operation) return;
    const ticket = lifetime.capture();
    setError("");
    setNotice("");
    try {
      await work(ticket, operation);
    } catch (e) {
      if (ticket.active()) {
        if (
          e instanceof ApiError &&
          (e.serverCode === "SERVICE_CONSENT_REQUIRED" ||
            e.serverCode === "AI_POLICY_CHANGED")
        ) {
          setConsentForm(null);
          setConsentReload((version) => version + 1);
          setBoard((current) =>
            current
              ? {
                  ...current,
                  user: { ...current.user, serviceConsentRequired: true },
                }
              : null,
          );
          try {
            await refresh(ticket);
          } catch {
            /* Keep the original rejection; the next refresh can retry. */
          }
        }
        if (ticket.active()) {
          if (
            e instanceof ApiError &&
            e.serverCode === "SERVICE_CONSENT_POLICY_CHANGED"
          ) {
            setConsentForm(null);
            setConsentReload((version) => version + 1);
          }
          setError(e instanceof Error ? e.message : "Ошибка запроса");
        }
      }
    } finally {
      operation.finish();
    }
  }
  const recoverySession = lifetime.capture();
  const modeConsentCallbacks = useRef({ refresh });
  modeConsentCallbacks.current = { refresh };
  useEffect(() => {
    const owner = board?.user.id;
    const token = session.current;
    if (
      !owner ||
      !token ||
      storageBlocked ||
      showPasswordChange ||
      board?.user.mustChangePassword ||
      board?.user.serviceConsentRequired
    )
      return;
    const ticket = lifetime.capture();
    const current = createMobileAiModeConsent({
      base,
      token,
      userId: owner,
      ticket,
      fetch: expoFetch,
      refresh: (scope) => modeConsentCallbacks.current.refresh(scope),
      select: setSelectedAiMode,
      onAccessDenied: () => void endSession(false),
      publish: (view) => {
        modeConsentOpen.current = view.phase !== "closed";
        setModeConsentView(view);
      },
    });
    modeConsent.current = current;
    return () => {
      if (modeConsent.current === current) modeConsent.current = null;
      current.dispose();
    };
  }, [
    base,
    board?.user.id,
    board?.user.mustChangePassword,
    board?.user.serviceConsentRequired,
    showPasswordChange,
    storageBlocked,
    recoverySession.signal,
  ]);
  function selectAiMode(value: AiModeId) {
    if (
      operations.current() ||
      modeConsentOpen.current ||
      storageBlocked ||
      !board ||
      board.user.mustChangePassword ||
      board.user.serviceConsentRequired
    )
      return;
    const option = board.aiAccess.modes?.options.find(
      (entry) => entry.id === value,
    );
    if (!option?.available) return;
    if (option.consentRequired) void modeConsent.current?.open(value);
    else setSelectedAiMode(value);
  }
  function openModeConsentLegal() {
    if (modeConsentView.phase !== "ready" && modeConsentView.phase !== "saving")
      return;
    const ticket = lifetime.capture();
    const url = new URL(modeConsentView.consent.policy.personalData.url, base);
    if (!["https:", "http:"].includes(url.protocol)) return;
    void Linking.openURL(url.href).catch(() => {
      if (ticket.active()) setError("Не удалось открыть условия.");
    });
  }
  const consentScope = board?.user.serviceConsentRequired
    ? { context: board.user.id, signal: recoverySession.signal }
    : !board && mode === "register"
      ? { context: "register", signal: recoverySession.signal }
      : null;
  const activeConsentForm = currentServiceConsentForm(
    consentForm,
    consentScope,
  );
  const consentChoice = serviceConsentChoice(consentForm, consentScope);
  useEffect(() => {
    const context = consentScope?.context;
    const signal = recoverySession.signal;
    setConsentForm(null);
    setConsentLoadError("");
    setConsentLoading(!!context);
    if (!context || signal.aborted) return;
    if (context === "register") setRegistrationAvailability("loading");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const active = () => !signal.aborted && !controller.signal.aborted;
    const policyApi = createClient(base, {
      native: true,
      fetch: expoFetch,
      signal: () => controller.signal,
      ...(context === "register" ? {} : { token: () => session.current }),
    });
    void (async () => {
      if (context === "register") {
        const registration = await policyApi.registrationPolicy();
        if (!active()) return;
        setRegistrationAvailability(registration.emailVerification);
        if (registration.emailVerification !== "disabled") return;
        setConsentForm(
          createServiceConsentForm(registration.consentPolicy, {
            context,
            signal,
          }),
        );
        return;
      }
      const { policy } = await policyApi.accountConsents();
      if (active())
        setConsentForm(createServiceConsentForm(policy, { context, signal }));
    })()
      .catch(() => {
        if (active())
          setConsentLoadError(
            "Не удалось загрузить актуальные условия. Проверьте связь и повторите.",
          );
      })
      .finally(() => {
        if (active()) setConsentLoading(false);
      });
    return () => {
      signal.removeEventListener("abort", cancel);
      controller.abort();
    };
  }, [base, consentScope?.context, recoverySession.signal, consentReload]);
  function updateConsent(
    purpose: "personalData" | "marketing",
    granted: boolean,
  ) {
    setConsentForm((current) => {
      const form = currentServiceConsentForm(current, consentScope);
      return form ? changeServiceConsent(form, purpose, granted) : current;
    });
  }
  function retryConsentPolicy() {
    setConsentForm(null);
    setConsentReload((version) => version + 1);
  }
  function openWebApp() {
    const ticket = lifetime.capture();
    void Linking.openURL(webAppUrl).catch(() => {
      if (ticket.active())
        setError("Не удалось открыть веб-версию CityGo. Повторите попытку.");
    });
  }
  const consentFields = activeConsentForm ? (
    <MobileServiceConsents
      key={`${activeConsentForm.context}:${activeConsentForm.policy.version}`}
      form={activeConsentForm}
      disabled={busy || storageBlocked}
      onChange={updateConsent}
    />
  ) : consentLoading || !consentLoadError ? (
    <Text>Загружаем актуальные условия…</Text>
  ) : (
    <View style={{ gap: 10 }}>
      <Text accessibilityRole="alert">
        {consentLoadError || "Актуальные условия пока недоступны."}
      </Text>
      <Button
        title="Повторить загрузку условий"
        disabled={busy || storageBlocked}
        onPress={retryConsentPolicy}
      />
    </View>
  );
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <StatusBar barStyle="dark-content" />
          <MobileAiModeConsentModal
            view={modeConsentView}
            onConfirm={(checked) => void modeConsent.current?.confirm(checked)}
            onCancel={() => modeConsent.current?.cancel()}
            onRetry={() => {
              if (modeConsentView.phase !== "closed")
                void modeConsent.current?.open(modeConsentView.mode);
            }}
            onLegal={openModeConsentLegal}
          />
          <ScrollView
            ref={contentScroll}
            onScroll={(event) => {
              scrollOffset.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={[
              styles.content,
              !board && mode === "recover" && styles.recoveryContent,
            ]}
            keyboardShouldPersistTaps="handled"
          >
            {!(mode === "recover" && !board) && (
              <View style={styles.header}>
                <Text style={styles.logo}>CityGo</Text>
                <Text>{board ? board.xp + " XP" : "Ваш новый город"}</Text>
              </View>
            )}
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
                  : pending.kind === "refresh" &&
                      board?.user.serviceConsentRequired
                    ? "Сохраняем согласия…"
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
            ) : !board && mode === "recover" ? (
              <MobilePasswordRecovery
                base={base}
                sessionSignal={recoverySession.signal}
                disabled={storageBlocked || busy}
                onBack={() => clearUserState()}
                onRecovered={async () => {
                  recoverySession.check();
                  try {
                    // Guard is checked INSIDE the serialized SecureStore queue.
                    await tokenStore.clear(recoverySession);
                    recoverySession.check();
                  } catch (failure) {
                    if (recoverySession.active()) setStorageBlocked(true);
                    throw failure;
                  }
                  session.current = null;
                  clearUserState();
                  setNotice(
                    "Пароль изменён. Все прежние сессии завершены. Войдите с новым паролем.",
                  );
                }}
              />
            ) : !board ? (
              <Card>
                <Text style={styles.title}>
                  {mode === "login" ? "С возвращением" : "Начнём переезд"}
                </Text>
                {mode === "register" &&
                registrationAvailability !== "disabled" ? (
                  <>
                    <Text>
                      {registrationAvailability === "required"
                        ? "Для регистрации с подтверждением почты откройте веб-версию CityGo. Затем войдите здесь с созданным аккаунтом."
                        : registrationAvailability === "unavailable"
                          ? "Регистрация временно недоступна: отправка писем ещё не подключена. Если аккаунт уже есть, войдите."
                          : consentLoading || !consentLoadError
                            ? "Проверяем способ регистрации…"
                            : consentLoadError ||
                              "Не удалось проверить способ регистрации."}
                    </Text>
                    {registrationAvailability === "required" ? (
                      <Button
                        title="Открыть веб-версию CityGo"
                        disabled={busy || storageBlocked}
                        onPress={openWebApp}
                      />
                    ) : (
                      !consentLoading &&
                      (registrationAvailability === "unavailable" ||
                        !!consentLoadError) && (
                        <Button
                          title="Проверить регистрацию ещё раз"
                          disabled={busy || storageBlocked}
                          onPress={retryConsentPolicy}
                        />
                      )
                    )}
                  </>
                ) : (
                  <>
                    <Field
                      label={
                        mode === "login"
                          ? "Логин или электронная почта"
                          : "Электронная почта"
                      }
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      keyboardType={
                        mode === "login" ? "default" : "email-address"
                      }
                      autoComplete={mode === "login" ? "username" : "email"}
                      maxLength={254}
                      editable={!busy && !storageBlocked}
                    />
                    <Field
                      label={
                        mode === "login"
                          ? "Пароль"
                          : "Пароль · от 6 любых символов"
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
                    {mode === "register" && consentFields}
                    <Button
                      title={mode === "login" ? "Войти" : "Создать аккаунт"}
                      disabled={
                        busy ||
                        storageBlocked ||
                        (mode === "register" && !consentChoice)
                      }
                      onPress={authenticate}
                    />
                  </>
                )}
                <Button
                  title={
                    mode === "login"
                      ? "Создать новый аккаунт"
                      : "Уже есть аккаунт"
                  }
                  disabled={busy || storageBlocked}
                  onPress={() => {
                    const next = mode === "login" ? "register" : "login";
                    clearUserState();
                    setMode(next);
                  }}
                />
                <Button
                  title="Не помню пароль"
                  disabled={busy || storageBlocked}
                  onPress={() => {
                    clearUserState();
                    setMode("recover");
                  }}
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
            ) : board.user.serviceConsentRequired ? (
              <Card>
                <Text style={styles.title}>Перед продолжением</Text>
                <Text>
                  Для продолжения примите актуальные условия обработки данных.
                  Рекламная рассылка необязательна.
                </Text>
                {consentFields}
                <Button
                  title="Принять и продолжить"
                  disabled={busy || storageBlocked || !consentChoice}
                  onPress={acceptServiceConsents}
                />
                <Button
                  title="Изменить пароль"
                  disabled={busy || storageBlocked}
                  onPress={() => {
                    setShowPasswordChange(true);
                    setCurrentPassword("");
                    setNewPassword("");
                  }}
                />
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
                  {!isAiModeAvailable(
                    board.aiAccess.modes,
                    selectedAiMode,
                    board.provider !== "unconfigured",
                  ) && (
                    <Text>
                      {board.aiAccess.modes
                        ? "Выбранный режим временно недоступен."
                        : "Помощники временно недоступны."}
                    </Text>
                  )}
                  {board.aiAccess?.credit && (
                    <View
                      ref={balanceSection}
                      collapsable={false}
                      testID="citygo-balance"
                    >
                      <Text style={styles.title}>Баланс CityGo</Text>
                      <Text>
                        {board.aiAccess.credit.bonusGranted
                          ? "Подарок 500 ₽ уже начислен."
                          : "Проверить телефон и статус подарка 500 ₽ можно в веб-кабинете CityGo."}
                      </Text>
                      <Text>
                        Доступно:{" "}
                        {formatSignedMoneyMicros(
                          board.aiAccess.credit.availableMicros,
                        )}{" "}
                        ₽. Потрачено:{" "}
                        {formatMoneyMicros(board.aiAccess.credit.spentMicros)}{" "}
                        ₽.
                      </Text>
                      {board.aiAccess.credit.reservationMode ===
                        "fixed5_overdraft" && (
                        <Text>
                          Ответы помощников оплачиваются с баланса. Если
                          стоимость ответа превысит остаток, баланс может стать
                          отрицательным.
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
                        {board.aiAccess.credit.topUpAvailable
                          ? "Для пополнения воспользуйтесь веб-кабинетом CityGo. В мобильном приложении оплата пока не подключена."
                          : "Пополнение пока недоступно."}
                      </Text>
                      {!!board.aiAccess.credit.pending?.length && (
                        <Text>
                          Некоторые операции ещё обрабатываются. Баланс
                          обновится после проверки.
                        </Text>
                      )}
                    </View>
                  )}
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
                        Недостаточно средств для нового ответа. Пополните баланс
                        CityGo.
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
                  <MobileAiModeSelector
                    key={board.user.id}
                    modes={board.aiAccess.modes}
                    selected={selectedAiMode}
                    disabled={busy}
                    onSelect={selectAiMode}
                  />
                  <Button
                    title="Отправить"
                    disabled={
                      busy ||
                      !text.trim() ||
                      !board.thread ||
                      !board.aiAccess?.granted ||
                      !isAiModeAvailable(
                        board.aiAccess.modes,
                        selectedAiMode,
                        board.provider !== "unconfigured",
                      )
                    }
                    onPress={() =>
                      void act("chat", async (ticket, operation) => {
                        const message = text;
                        const mode = captureAiModeSelection(
                          board.aiAccess.modes,
                          selectedAiMode,
                        );
                        const requestId = randomUUID();
                        setText("");
                        setDraft("");
                        const controller = new AbortController();
                        abort.current = controller;
                        try {
                          await api.stream(
                            board.thread!.id,
                            message,
                            requestId,
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
                            mode,
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
  recoveryContent: { padding: 0, paddingTop: 0, gap: 0 },
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
