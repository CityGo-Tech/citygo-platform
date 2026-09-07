"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, ApiError } from "@citygo/api-client";
import type { AgentKey, Dashboard, Questionnaire } from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import { Journey } from "../components/journey";
import { QuestionnaireForm } from "../components/questionnaire";

const api = createClient();
export default function Home() {
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
  async function refresh() {
    try {
      setBoard(await api.dashboard());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setBoard(null);
      else throw e;
    }
  }
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => abort.current?.abort();
  }, []);
  async function act(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить запрос");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function auth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void act(async () => {
      await api.auth(
        mode,
        String(data.get("email")),
        String(data.get("password")),
      );
      await refresh();
    });
  }
  function questionnaire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void act(async () => {
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
      await refresh();
    });
  }
  async function chat(event: FormEvent) {
    event.preventDefault();
    if (!board?.thread || !board.aiAccess?.granted || !text.trim() || busy)
      return;
    const message = text;
    setText("");
    setDraft("");
    setPending(message);
    setSending(true);
    setStreamAgent(board.thread.agentKey);
    abort.current = new AbortController();
    const succeeded = await act(async () => {
      try {
        await api.stream(
          board.thread!.id,
          message,
          crypto.randomUUID(),
          (event) => {
            if (event.type === "delta") setDraft((value) => value + event.text);
            if (event.type === "handoff") {
              setNotice(event.reason);
              setStreamAgent(event.to);
            }
          },
          abort.current!.signal,
          board.aiAccess.policy?.id,
        );
      } catch (e) {
        if (!abort.current?.signal.aborted) throw e;
        setNotice("Ответ остановлен. Полученная часть останется в истории.");
      } finally {
        await refresh();
      }
    });
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
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.logout();
                  setBoard(null);
                  setNotice("");
                })
              }
            >
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
              <form onSubmit={auth}>
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
                <Button disabled={busy} type="submit">
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
          <QuestionnaireForm busy={busy} onSubmit={questionnaire} />
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
              void act(async () => {
                try {
                  await api.aiConsent(input);
                } finally {
                  await refresh();
                }
              })
            }
            onStart={(id) =>
              act(async () => {
                await api.start(id);
                await refresh();
                setNotice("");
              })
            }
            onComplete={(id) =>
              act(async () => {
                const result = await api.complete(id);
                await refresh();
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
