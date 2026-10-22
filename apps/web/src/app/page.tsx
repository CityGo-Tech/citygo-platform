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
import type { AgentKey, Dashboard } from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import { Journey } from "../components/journey";
import { ConversationHome } from "../components/conversation-home";
import { OwnerReceiptsPanel } from "../components/owner-receipts";

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
  const [mode, setMode] = useState<"register" | "login">("register");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const [streamAgent, setStreamAgent] = useState<AgentKey | null>(null);
  const abort = useRef<AbortController | null>(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => session.capture().signal,
        onUnauthorized: requireLogin,
      }),
    [session],
  );
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
    setReceiptsOpen(false);
    setFormVersion((value) => value + 1);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  async function refresh(ticket = session.capture()) {
    ticket.check();
    const version = ++refreshVersion.current;
    const next = await api.dashboard();
    ticket.check();
    if (version !== refreshVersion.current) return;
    if (session.ownerChanged(next.user.id)) {
      notifyBrowserSessionChange();
      clearUserState(next.user.id);
      setBoard(next);
      ticket.check(); // Do not run the previous owner's continuation.
    }
    setBoard(next);
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(() => clearUserState());
    const onFocus = () => {
      // Detect a changed HttpOnly session after returning from another tab,
      // including browsers with disabled storage. Do not auto-restore a logout.
      if (session.hasOwner()) void refresh(session.capture()).catch(() => {});
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
    if (busy || logoutUnconfirmed) return;
    const data = new FormData(event.currentTarget);
    notifyBrowserSessionChange();
    clearUserState();
    void act(async (ticket) => {
      await api.auth(
        mode,
        String(data.get("email")),
        String(data.get("password")),
      );
      ticket.check();
      await refresh(ticket);
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
    if (!board?.thread || !board.aiAccess?.granted || !text.trim() || busy)
      return;
    const message = text;
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
          board.thread!.id,
          message,
          crypto.randomUUID(),
          (event) => {
            if (!ticket.active()) return;
            if (event.type === "delta") setDraft((value) => value + event.text);
            if (event.type === "handoff") {
              setNotice(event.reason);
              setStreamAgent(event.to);
            }
          },
          controller.signal,
          board.aiAccess.policy?.id,
        );
      } catch (e) {
        if (!ticket.active()) return;
        if (!controller.signal.aborted) throw e;
        setNotice("Ответ остановлен. Полученная часть останется в истории.");
      } finally {
        if (ticket.active()) await refresh(ticket);
      }
    });
    if (!ticket.active()) return;
    if (!succeeded) setText(message);
    setDraft("");
    setPending("");
    setSending(false);
    setStreamAgent(null);
    abort.current = null;
  }
  const Experience = board?.profile ? Journey : ConversationHome;
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
    reconcileTopup: async (orderId: string) => {
      const ticket = session.capture();
      const order = await api.reconcileTopup(orderId);
      ticket.check();
      return order;
    },
    onCredited: () => refresh(session.capture()),
  };
  return (
    <div
      className={
        "shell" +
        (board?.profile ? " shell-journey" : board ? " shell-onboarding" : "")
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
            {!board.user.mustChangePassword && !passwordOpen && (
              <Button
                variant="ghost"
                disabled={busy || sending}
                onClick={() => setReceiptsOpen(true)}
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
                  setMode(mode === "register" ? "login" : "register");
                  setError("");
                }}
              >
                {mode === "register"
                  ? "Уже есть аккаунт? Войти"
                  : "Впервые здесь? Создать аккаунт"}
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
            {receiptsOpen ? (
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
            ) : (
              <Experience
                key={board.user.id}
                board={board}
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
                topups={topups}
                onBegin={() =>
                  void act(async (ticket) => {
                    await api.startConversation();
                    await refresh(ticket);
                  })
                }
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
            )}
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
