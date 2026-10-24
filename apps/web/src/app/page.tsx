"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createClient,
  createSessionGuard,
  notifyBrowserSessionChange,
  subscribeBrowserSessionChange,
  type SessionTicket,
} from "@citygo/api-client";
import type {
  AgentKey,
  Dashboard,
  ConversationSummary,
} from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import { Journey } from "../components/journey";
import { ConversationHome } from "../components/conversation-home";
import { OwnerReceiptsPanel } from "../components/owner-receipts";
import { MessageFavoritesPanel } from "../components/message-favorites";
import { EmailRegistration } from "../components/email-registration";
import { PasswordRecovery } from "../components/password-recovery";
import { PhoneVerificationPanel } from "../components/phone-verification";
import { AccountOverview, accountStyles } from "../components/account-overview";
import { AiAccessPanel } from "../components/ai-access";
import { chatBalanceTarget } from "../components/chat-readiness";
import { useConversationHistory } from "../components/use-conversation-history";
import {
  pendingEmailRegistration,
  type PendingEmailRegistration,
} from "../components/email-registration-state";
import registrationStyles from "../components/email-registration.module.css";
import recoveryStyles from "../components/password-recovery.module.css";
import {
  readConversationSelection,
  writeConversationSelection,
} from "../components/conversation-selection";

function conversationStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function Home() {
  const [session] = useState(createSessionGuard);
  const [formVersion, setFormVersion] = useState(0);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const refreshVersion = useRef(0);
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"register" | "login" | "recover">(
    "register",
  );
  const [registration, setRegistration] =
    useState<PendingEmailRegistration | null>(null);
  const authPending = useRef(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [conversationView, setConversationView] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const [streamAgent, setStreamAgent] = useState<AgentKey | null>(null);
  const abort = useRef<AbortController | null>(null);
  const selectedConversation = useRef<{ owner: string; id: string } | null>(
    null,
  );
  const visibleThread = useRef<string | null>(null);
  const conversationEpoch = useRef(0);
  const conversationSwitch = useRef(false);
  const conversationDrafts = useRef(new Map<string, string>());
  const [conversations, setConversations] = useState<
    ConversationSummary[] | null
  >(null);
  const [conversationNextCursor, setConversationNextCursor] = useState<
    string | null
  >(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => session.capture().signal,
        onUnauthorized: requireLogin,
      }),
    [session],
  );
  const history = useConversationHistory({
    board,
    sessionSignal: session.capture().signal,
    onAccessDenied: requireLogin,
  });
  function requireLogin() {
    if (session.hasOwner()) notifyBrowserSessionChange();
    clearUserState();
    setNotice("Сессия завершилась. Войдите снова.");
  }
  function clearUserState(owner?: string) {
    session.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setText("");
    setDraft("");
    setPending("");
    setStreamAgent(null);
    setSending(false);
    setBusy(false);
    setError("");
    setNotice("");
    setLoading(false);
    setLogoutUnconfirmed(false);
    setPasswordOpen(false);
    setRegistration(null);
    authPending.current = false;
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setPhoneOpen(false);
    setBalanceOpen(false);
    setConversationView(false);
    selectedConversation.current = null;
    visibleThread.current = null;
    conversationDrafts.current.clear();
    conversationSwitch.current = false;
    conversationEpoch.current++;
    refreshVersion.current++;
    setConversations(null);
    setConversationNextCursor(null);
    setFormVersion((value) => value + 1);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  async function refresh(ticket = session.capture()) {
    ticket.check();
    let version = ++refreshVersion.current;
    let next = await api.dashboard();
    ticket.check();
    if (version !== refreshVersion.current) return false;
    if (session.ownerChanged(next.user.id)) {
      notifyBrowserSessionChange();
      clearUserState(next.user.id);
      // The old owner's continuation remains invalid. Only this new ticket may
      // restore the new owner's non-secret selection, after server authorization.
      ticket = session.capture();
      version = ++refreshVersion.current;
    }
    const preferred =
      selectedConversation.current?.owner === next.user.id
        ? selectedConversation.current.id
        : readConversationSelection(next.user.id, conversationStorage());
    if (preferred && !next.user.mustChangePassword) {
      try {
        const detail = await api.conversation(preferred);
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (detail.userId !== next.user.id) {
          clearUserState();
          return false;
        }
        next = { ...next, thread: detail.thread };
        selectedConversation.current = { owner: next.user.id, id: preferred };
        setConversationView(true);
      } catch (error) {
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (!(
          error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 404
        ))
          throw error;
        selectedConversation.current = null;
        writeConversationSelection(next.user.id, null, conversationStorage());
        // A removed/inaccessible selection cannot carry its draft into the
        // legacy fallback. Never reinterpret unsent text as a different chat.
        setText("");
      }
    }
    ticket.check();
    if (version !== refreshVersion.current) return false;
    visibleThread.current = next.thread?.id ?? null;
    setBoard(next);
    return true;
  }
  function rememberConversation(owner: string, id: string) {
    selectedConversation.current = { owner, id };
    setConversationView(true);
    writeConversationSelection(owner, id, conversationStorage());
  }
  async function beginConversation(agentKey?: AgentKey) {
    if (!board || busy || sending || conversationSwitch.current) return false;
    conversationSwitch.current = true;
    const epoch = ++conversationEpoch.current;
    const version = ++refreshVersion.current;
    if (board.thread) conversationDrafts.current.set(board.thread.id, text);
    let opened = false;
    try {
      const completed = await act(async (ticket) => {
        const started = await api.startConversation(agentKey);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        // Commit the selection only after the authorized history was read.
        // A failed GET must never route the previous thread's draft into this one.
        const detail = await api.conversation(started.id);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        if (detail.userId !== board.user.id) {
          clearUserState();
          return;
        }
        rememberConversation(board.user.id, detail.thread.id);
        visibleThread.current = detail.thread.id;
        setBoard((current) =>
          current?.user.id === board.user.id
            ? { ...current, thread: detail.thread }
            : current,
        );
        setText(conversationDrafts.current.get(detail.thread.id) ?? "");
        setDraft("");
        setPending("");
        setStreamAgent(null);
        opened = true;
      });
      return completed && opened;
    } finally {
      if (epoch === conversationEpoch.current)
        conversationSwitch.current = false;
    }
  }
  async function openConversation(id: string) {
    if (!board || busy || sending || conversationSwitch.current) return false;
    conversationSwitch.current = true;
    const epoch = ++conversationEpoch.current;
    const version = ++refreshVersion.current;
    if (board.thread) conversationDrafts.current.set(board.thread.id, text);
    let opened = false;
    try {
      const completed = await act(async (ticket) => {
        const detail = await api.conversation(id);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        if (detail.userId !== board.user.id) {
          clearUserState();
          return;
        }
        rememberConversation(board.user.id, detail.thread.id);
        visibleThread.current = detail.thread.id;
        setBoard((current) =>
          current?.user.id === board.user.id
            ? { ...current, thread: detail.thread }
            : current,
        );
        setText(conversationDrafts.current.get(id) ?? "");
        setDraft("");
        setPending("");
        setStreamAgent(null);
        opened = true;
      });
      return completed && opened;
    } finally {
      if (epoch === conversationEpoch.current)
        conversationSwitch.current = false;
    }
  }
  function loadConversations(before?: string) {
    if (!board || busy || sending) return;
    void act(async (ticket) => {
      const page = await api.conversations(before);
      ticket.check();
      if (page.userId !== board.user.id) {
        clearUserState();
        return;
      }
      setConversations((current) =>
        before
          ? [...(current ?? []), ...page.conversations].filter(
              (item, index, all) =>
                all.findIndex((other) => other.id === item.id) === index,
            )
          : page.conversations,
      );
      setConversationNextCursor(page.nextCursor);
    });
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(() => clearUserState());
    const onFocus = () => {
      // Detect a changed HttpOnly session after returning from another tab,
      // including browsers with disabled storage. Do not auto-restore a logout.
      if (!session.hasOwner()) return;
      if (conversationSwitch.current || abort.current) {
        // A focus event must still detect a replaced HttpOnly session while
        // streaming, but must not overwrite a pending conversation selection.
        const probe = session.capture();
        void api
          .dashboard()
          .then((next) => {
            probe.check();
            if (session.ownerChanged(next.user.id)) {
              notifyBrowserSessionChange();
              clearUserState(next.user.id);
              void refresh(session.capture()).catch(() => {});
            }
          })
          .catch(() => {});
      } else void refresh(session.capture()).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    const ticket = session.capture();
    void refresh(ticket)
      .catch((e) => {
        if (ticket.active()) setError(e.message);
      })
      .finally(() => {
        if (ticket.active()) setLoading(false);
      });
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      session.reset();
      abort.current?.abort();
    };
  }, []);
  async function act(work: (ticket: SessionTicket) => Promise<void>) {
    const ticket = session.capture();
    setError("");
    setBusy(true);
    try {
      await work(ticket);
      ticket.check();
      return true;
    } catch (e) {
      if (ticket.active())
        setError(
          e instanceof Error ? e.message : "Не удалось выполнить запрос",
        );
      return false;
    } finally {
      if (ticket.active()) setBusy(false);
    }
  }
  function auth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "recover") return;
    if (busy || logoutUnconfirmed || authPending.current) return;
    const data = new FormData(event.currentTarget);
    const authMode = mode;
    const email = String(data.get("email"));
    let password = String(data.get("password"));
    data.delete("password");
    notifyBrowserSessionChange();
    clearUserState();
    authPending.current = true;
    void act(async (ticket) => {
      try {
        if (authMode === "register") {
          const policy = await api.registrationPolicy();
          ticket.check();
          if (policy.emailVerification === "unavailable") {
            throw new Error(
              "Регистрация временно недоступна: отправка писем ещё не подключена. Если аккаунт уже есть, войдите.",
            );
          }
          if (policy.emailVerification === "required") {
            const challenge = await api.beginEmailRegistration(email, password);
            ticket.check();
            setRegistration(
              pendingEmailRegistration(email, challenge, Date.now()),
            );
            return;
          }
        }
        await api.auth(authMode, email, password);
        ticket.check();
        await refresh(ticket);
      } finally {
        password = "";
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  function changeAuthMode(next: "register" | "login" | "recover") {
    // Cancel both the network lifetime and the memory-only pending proof.
    const mustConfirmLogout = logoutUnconfirmed;
    clearUserState();
    setLogoutUnconfirmed(mustConfirmLogout);
    setMode(next);
  }
  function resendRegistration() {
    if (!registration || busy || logoutUnconfirmed || authPending.current)
      return;
    const current = registration;
    authPending.current = true;
    void act(async (ticket) => {
      try {
        const challenge = await api.resendEmailRegistration(
          current.challengeId,
          current.proof,
        );
        ticket.check();
        setRegistration(
          pendingEmailRegistration(current.email, challenge, Date.now()),
        );
        setNotice("Новый код отправлен. Предыдущий код больше не действует.");
      } finally {
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  function confirmRegistration(code: string) {
    if (!registration || busy || logoutUnconfirmed || authPending.current)
      return;
    const current = registration;
    authPending.current = true;
    void act(async (ticket) => {
      try {
        await api.confirmEmailRegistration(
          current.challengeId,
          current.proof,
          code,
        );
        ticket.check();
        notifyBrowserSessionChange();
        clearUserState();
        const confirmed = session.capture();
        setBusy(true);
        try {
          await refresh(confirmed);
        } catch {
          if (confirmed.active())
            setNotice(
              "Email подтверждён, аккаунт создан. Не удалось загрузить кабинет — войдите с вашим паролем.",
            );
        } finally {
          if (confirmed.active()) setBusy(false);
        }
      } finally {
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  async function logout() {
    notifyBrowserSessionChange();
    clearUserState();
    const ticket = session.capture();
    setBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      // Independent revocation request: closing the UI lifetime must not cancel it.
      await createClient("/api", { signal: () => controller.signal }).logout();
      if (ticket.active()) setNotice("Вы вышли из аккаунта.");
    } catch {
      if (ticket.active()) {
        setLogoutUnconfirmed(true);
        setError(
          "Локальные данные очищены. Не удалось подтвердить выход на сервере. Повторите выход перед использованием устройства другим человеком.",
        );
      }
    } finally {
      clearTimeout(timer);
      if (ticket.active()) setBusy(false);
    }
  }
  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void act(async (ticket) => {
      await api.changePassword(
        String(data.get("currentPassword")),
        String(data.get("password")),
      );
      ticket.check();
      // Rotation invalidates every old session, including other browser tabs.
      notifyBrowserSessionChange();
      clearUserState();
      const rotated = session.capture();
      try {
        await refresh(rotated);
        rotated.check();
        setNotice("Пароль изменён. Другие сессии завершены.");
      } catch {
        if (rotated.active())
          setNotice(
            "Пароль изменён. Не удалось загрузить кабинет — войдите снова с новым паролем.",
          );
      }
    });
  }
  async function chat(event: FormEvent) {
    event.preventDefault();
    if (
      !board?.thread ||
      board.thread.closed ||
      !board.aiAccess?.granted ||
      history.detached ||
      !text.trim() ||
      busy ||
      sending ||
      conversationSwitch.current
    )
      return;
    const message = text;
    const threadId = board.thread.id;
    const epoch = conversationEpoch.current;
    const ticket = session.capture();
    setText("");
    setDraft("");
    setPending(message);
    setSending(true);
    setStreamAgent(board.thread.agentKey);
    const controller = new AbortController();
    abort.current = controller;
    const succeeded = await act(async () => {
      try {
        await api.stream(
          threadId,
          message,
          crypto.randomUUID(),
          (event) => {
            if (
              !ticket.active() ||
              epoch !== conversationEpoch.current ||
              visibleThread.current !== threadId
            )
              return;
            if (event.type === "delta") setDraft((value) => value + event.text);
            if (event.type === "handoff") {
              setNotice(event.reason);
              setStreamAgent(event.to);
            }
          },
          controller.signal,
          board.aiAccess.policy?.id,
          board.aiAccess.credit?.reservationMode,
        );
      } catch (e) {
        if (!ticket.active()) return;
        if (!controller.signal.aborted) throw e;
        setNotice("Ответ остановлен. Полученная часть останется в истории.");
      } finally {
        if (ticket.active() && epoch === conversationEpoch.current)
          await refresh(ticket);
      }
    });
    if (!ticket.active() || epoch !== conversationEpoch.current) return;
    if (!succeeded) setText(message);
    setDraft("");
    setPending("");
    setSending(false);
    setStreamAgent(null);
    abort.current = null;
  }
  const Experience =
    board?.profile && !board.thread?.assistantKey && !conversationView
      ? Journey
      : ConversationHome;
  const topups = {
    createTopup: async (input: Parameters<typeof api.createTopup>[0]) => {
      const ticket = session.capture();
      const order = await api.createTopup(input);
      ticket.check();
      return order;
    },
    topupOrder: async (orderId: string) => {
      const ticket = session.capture();
      const order = await api.topupOrder(orderId);
      ticket.check();
      return order;
    },
    topupAttempt: async (requestId: string) => {
      const ticket = session.capture();
      const order = await api.topupAttempt(requestId);
      ticket.check();
      return order;
    },
    reconcileTopup: async (orderId: string) => {
      const ticket = session.capture();
      const order = await api.reconcileTopup(orderId);
      ticket.check();
      return order;
    },
    onCredited: async () => {
      await refresh(session.capture());
    },
  };
  const authViewSignal = session.capture().signal;
  function openBalance() {
    setPhoneOpen(false);
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setBalanceOpen(true);
  }
  function openPhone() {
    setBalanceOpen(false);
    setFavoritesOpen(false);
    setReceiptsOpen(false);
    setPhoneOpen(true);
  }
  function returnToApp() {
    setBalanceOpen(false);
    setPhoneOpen(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>("#citygo-account-overview button")
        ?.focus(),
    );
  }
  useEffect(() => {
    if (!phoneOpen) return;
    const target = document.getElementById("phone-gift-heading");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [phoneOpen]);
  useEffect(() => {
    if (!balanceOpen) return;
    const target =
      document.getElementById(chatBalanceTarget) ??
      document.getElementById("citygo-wallet-view");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [balanceOpen]);
  return (
    <div
      className={
        "shell" +
        (board?.profile ? " shell-journey" : board ? " shell-onboarding" : "") +
        (!board && (mode === "register" || mode === "recover")
          ? " " + registrationStyles.registrationShell
          : "") +
        (!board && mode === "recover" ? " " + recoveryStyles.recoveryShell : "")
      }
    >
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="CityGo — главная">
          <span className="citygo-brand-symbol" aria-hidden="true" />
          <span className="citygo-brand-wordmark" aria-hidden="true" />
        </Link>
        <span className="header-caption">Новый город. Ваша история.</span>
        {board ? (
          <div className="account">
            <Badge>{board.xp} XP</Badge>
            {board.profile &&
              !board.user.mustChangePassword &&
              !passwordOpen && (
                <Button
                  variant="ghost"
                  disabled={busy || sending}
                  onClick={() => {
                    setConversationView(true);
                    setPhoneOpen(false);
                    setBalanceOpen(false);
                    setFavoritesOpen(false);
                    setReceiptsOpen(false);
                  }}
                >
                  Диалоги и помощники
                </Button>
              )}
            {!board.user.mustChangePassword && !passwordOpen && (
              <Button
                variant="ghost"
                disabled={busy || sending}
                onClick={() => {
                  setReceiptsOpen(false);
                  setPhoneOpen(false);
                  setBalanceOpen(false);
                  setFavoritesOpen(true);
                }}
              >
                Избранное
              </Button>
            )}
            {!board.user.mustChangePassword && !passwordOpen && (
              <Button
                variant="ghost"
                disabled={busy || sending}
                onClick={() => {
                  setFavoritesOpen(false);
                  setPhoneOpen(false);
                  setBalanceOpen(false);
                  setReceiptsOpen(true);
                }}
              >
                Мои чеки
              </Button>
            )}
            <Button variant="ghost" onClick={() => setPasswordOpen(true)}>
              Пароль
            </Button>
            <Button variant="ghost" onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        ) : mode === "register" || mode === "recover" ? (
          <div className={registrationStyles.headerActions}>
            <Button variant="secondary" onClick={() => changeAuthMode("login")}>
              Войти
            </Button>
            <Button onClick={() => changeAuthMode("register")}>
              Начать разговор
            </Button>
          </div>
        ) : (
          <Badge>Личный помощник по переезду</Badge>
        )}
      </header>
      <main>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button aria-label="Закрыть сообщение" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {logoutUnconfirmed && (
          <Button disabled={busy} onClick={() => void logout()}>
            Повторить выход на сервере
          </Button>
        )}
        {loading ? (
          <Card>
            <p role="status">Загружаем ваш маршрут…</p>
          </Card>
        ) : !board && mode === "recover" ? (
          <PasswordRecovery
            key={formVersion}
            sessionSignal={authViewSignal}
            disabled={logoutUnconfirmed}
            onBack={() => changeAuthMode("login")}
            onRecovered={() => {
              if (authViewSignal.aborted) return;
              notifyBrowserSessionChange();
              clearUserState();
              setMode("login");
              setNotice(
                "Пароль изменён. Все прежние сессии завершены. Войдите с новым паролем.",
              );
            }}
          />
        ) : !board && mode === "register" ? (
          <EmailRegistration
            key={
              registration
                ? registration.challengeId + ":" + registration.resendAt
                : formVersion
            }
            pending={registration}
            busy={busy}
            disabled={logoutUnconfirmed}
            formVersion={formVersion}
            onRegister={auth}
            onConfirm={confirmRegistration}
            onResend={resendRegistration}
            onBack={() => changeAuthMode(registration ? "register" : "login")}
          />
        ) : !board ? (
          <div className="welcome-grid">
            <section className="welcome">
              <Badge>ПЕРЕЕЗД НАЧИНАЕТСЯ С ВАС</Badge>
              <h1>
                Новый город.
                <br />
                <em>Знакомое чувство дома.</em>
              </h1>
              <p>
                Соберите личный маршрут переезда — от первых планов до ключей от
                квартиры. Рядом будет команда AI-помощников.
              </p>
              <Image
                className="welcome-art"
                src="/characters/housing-640.webp"
                alt="Housing Navigator — помощница CityGo с планом квартиры"
                width={640}
                height={349}
                priority
              />
              <div className="welcome-foot">
                <span>01 · Расскажите о себе</span>
                <span>02 · Получите план</span>
                <span>03 · Двигайтесь по шагам</span>
              </div>
            </section>
            <Card className="auth-card">
              <span className="eyebrow">ВАШ CITYGO</span>
              <h2>
                {mode === "register" ? "Начнём вашу историю" : "С возвращением"}
              </h2>
              <p>Сохраним план, диалоги и каждый завершённый шаг.</p>
              <form key={formVersion} onSubmit={auth}>
                <Field
                  label={
                    mode === "register"
                      ? "Электронная почта"
                      : "Логин или электронная почта"
                  }
                  name="email"
                  type={mode === "register" ? "email" : "text"}
                  autoComplete={mode === "register" ? "email" : "username"}
                  maxLength={254}
                  required
                />
                <Field
                  label="Пароль"
                  name="password"
                  type="password"
                  minLength={mode === "register" ? 6 : 1}
                  maxLength={128}
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  hint={
                    mode === "register"
                      ? "Не менее 6 любых символов"
                      : undefined
                  }
                  required
                />
                <Button disabled={busy || logoutUnconfirmed} type="submit">
                  {busy
                    ? "Подождите…"
                    : mode === "register"
                      ? "Создать аккаунт"
                      : "Войти"}
                </Button>
              </form>
              <Button
                variant="ghost"
                onClick={() => {
                  changeAuthMode(mode === "register" ? "login" : "register");
                }}
              >
                {mode === "register"
                  ? "Уже есть аккаунт? Войти"
                  : "Впервые здесь? Создать аккаунт"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || logoutUnconfirmed}
                onClick={() => changeAuthMode("recover")}
              >
                Не помню пароль
              </Button>
              <small>
                AI помогает подготовиться, но не заменяет проверку жилья и
                консультацию специалиста.
              </small>
            </Card>
          </div>
        ) : board.user.mustChangePassword || passwordOpen ? (
          <Card className="auth-card password-card">
            <h1>Изменить пароль</h1>
            <p>
              {board.user.mustChangePassword
                ? "Временный пароль нужно заменить до работы с AI и админкой."
                : "После изменения все остальные сессии завершатся."}
            </p>
            <form
              key={board.user.id + ":password:" + formVersion}
              onSubmit={changePassword}
            >
              <Field
                label="Текущий пароль"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
              <Field
                label="Новый пароль"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
                hint="Не менее 6 любых символов; отличается от текущего"
                required
              />
              <Button type="submit" disabled={busy}>
                Сохранить новый пароль
              </Button>
            </form>
            {!board.user.mustChangePassword && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setPasswordOpen(false)}
              >
                Назад
              </Button>
            )}
          </Card>
        ) : (
          <>
            <AccountOverview
              access={board.aiAccess}
              disabled={busy || sending}
              onBalance={openBalance}
              onPhone={openPhone}
            />
            <section
              id="citygo-wallet-view"
              tabIndex={-1}
              className={accountStyles.page}
              hidden={!balanceOpen}
              aria-label="Баланс и пополнение"
            >
              <span className={accountStyles.eyebrow}>
                ЛИЧНЫЙ КАБИНЕТ · CITYGO
              </span>
              <h1>Баланс и пополнение</h1>
              <p>
                Ваш баланс для общения с ИИ-помощниками. Пополняйте его через
                ЮKassa или подтвердите телефон для разового подарка.
              </p>
              <Button variant="secondary" onClick={returnToApp}>
                Вернуться в приложение
              </Button>
              <AiAccessPanel
                key={board.user.id + ":balance:" + formVersion}
                access={board.aiAccess}
                userId={board.user.id}
                busy={busy || sending}
                topups={topups}
                balanceOnly
                onPhone={openPhone}
                onConsent={() => {}}
              />
              {!board.aiAccess.credit && (
                <p role="status">
                  Не удалось получить баланс. Обновите страницу; сумма не
                  считается нулевой.
                </p>
              )}
            </section>
            {phoneOpen ? (
              <PhoneVerificationPanel
                key={board.user.id + ":phone:" + formVersion}
                userId={board.user.id}
                sessionSignal={session.capture().signal}
                onAccessDenied={requireLogin}
                onGranted={() =>
                  void refresh(session.capture()).catch(() => {})
                }
                onClose={returnToApp}
              />
            ) : favoritesOpen ? (
              <MessageFavoritesPanel
                key={board.user.id + ":favorites:" + formVersion}
                userId={board.user.id}
                sessionSignal={session.capture().signal}
                onAccessDenied={requireLogin}
                onClose={() => {
                  setFavoritesOpen(false);
                  void refresh(session.capture()).catch(() => {});
                }}
              />
            ) : receiptsOpen ? (
              <section aria-label="Чеки личного кабинета">
                <Button
                  variant="secondary"
                  onClick={() => setReceiptsOpen(false)}
                >
                  Вернуться в приложение
                </Button>
                <OwnerReceiptsPanel
                  key={board.user.id + ":receipts:" + formVersion}
                  userId={board.user.id}
                  sessionSignal={session.capture().signal}
                  onAccessDenied={requireLogin}
                />
              </section>
            ) : null}
            <div
              className={accountStyles.experience}
              hidden={balanceOpen || phoneOpen || favoritesOpen || receiptsOpen}
            >
              <Experience
                key={board.user.id}
                board={history.board ?? board}
                sessionSignal={session.capture().signal}
                onAccessDenied={requireLogin}
                history={history.state}
                onOlderMessages={history.loadOlder}
                onLatestMessages={() => {
                  history.returnToLatest();
                  void refresh(session.capture()).catch(() => {});
                }}
                busy={busy}
                sending={sending}
                draft={draft}
                pending={pending}
                streamAgent={streamAgent}
                text={text}
                onText={setText}
                onChat={chat}
                onStop={() => abort.current?.abort()}
                onPassword={() => setPasswordOpen(true)}
                onBalance={openBalance}
                onPhone={openPhone}
                onFavorites={() => setFavoritesOpen(true)}
                onFavorite={(messageId, saved) =>
                  void act(async (ticket) => {
                    const confirmed = await api.setMessageFavorite(
                      messageId,
                      saved,
                    );
                    ticket.check();
                    history.patchFavorite(confirmed);
                    await refresh(ticket);
                    ticket.check();
                    setNotice(
                      saved
                        ? "Сообщение сохранено в избранное."
                        : "Закладка удалена. Сообщение осталось в диалоге.",
                    );
                  })
                }
                topups={topups}
                onBegin={beginConversation}
                conversations={conversations}
                conversationNextCursor={conversationNextCursor}
                onConversations={loadConversations}
                onOpenConversation={openConversation}
                onConsent={(input) =>
                  void act(async (ticket) => {
                    try {
                      await api.aiConsent(input);
                    } finally {
                      if (ticket.active()) await refresh(ticket);
                    }
                  })
                }
                onStart={(id) =>
                  act(async (ticket) => {
                    await api.start(id);
                    await refresh(ticket);
                    ticket.check();
                    setNotice("");
                  })
                }
                onComplete={(id) =>
                  act(async (ticket) => {
                    const result = await api.complete(id);
                    await refresh(ticket);
                    ticket.check();
                    setNotice(
                      result.awarded
                        ? `+${result.awarded} XP — квест завершён!`
                        : "Этот квест уже завершён",
                    );
                  })
                }
              />
            </div>
          </>
        )}
      </main>
      <footer>
        CityGo · Место для вашего нового начала{" "}
        <span>Web · AI-помощники по переезду</span>
      </footer>
    </div>
  );
}
