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
import type { AgentKey, Dashboard, Questionnaire } from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import { Journey } from "../components/journey";
import { QuestionnaireForm } from "../components/questionnaire";

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
        onUnauthorized: () => {
          if (session.hasOwner()) notifyBrowserSessionChange();
          clearUserState();
          setNotice("Сессия завершилась. Войдите снова.");
        },
      }),
    [session],
  );
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
  function questionnaire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void act(async (ticket) => {
      if (data.get("aiConsent") !== "on")
        throw new Error("Подтвердите использование анкеты для плана");
      await api.questionnaire({
        originCity: String(data.get("originCity")),
        targetCity: String(data.get("targetCity")),
        monthlyBudget: Number(data.get("monthlyBudget")),
        moveTargetDate: String(data.get("moveTargetDate")),
        household: String(data.get("household")) as Questionnaire["household"],
        aiConsent: true,
      });
      await refresh(ticket);
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
  return (
    <div
      className={
        "shell" +
        (board?.profile ? " shell-journey" : board ? " shell-onboarding" : "")
      }
    >
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="CityGo — главная">
          City<span>Go</span>
          <i />
        </Link>
        <span className="header-caption">Новый город. Ваша история.</span>
        {board ? (
          <div className="account">
            <Badge>{board.xp} XP</Badge>
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
                  label="Электронная почта"
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                />
                <Field
                  label="Пароль"
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  hint="Не менее 12 символов"
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
        ) : !board.profile ? (
          <QuestionnaireForm
            key={board.user.id + ":" + formVersion}
            busy={busy}
            onSubmit={questionnaire}
          />
        ) : (
          <Journey
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
      </main>
      <footer>
        CityGo · Место для вашего нового начала{" "}
        <span>Web MVP · Жилищный маршрут CityGo</span>
      </footer>
    </div>
  );
}
