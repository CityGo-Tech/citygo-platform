"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, ApiError } from "@citygo/api-client";
import type { Dashboard, Questionnaire } from "@citygo/contracts";
import { Button, Card, Field, Badge, Progress } from "@citygo/ui-web";
import { questChecklist } from "@citygo/content";
import { QuestionnaireForm } from "../components/questionnaire";

const api = createClient();
const names = {
  housing: "Housing Navigator",
  "job-search": "Job Search Mentor",
  "resume-builder": "Resume Builder Expert",
  "digital-mentor": "Digital Mentor",
  support: "Support Assistant",
};
export default function Home() {
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"register" | "login">("register");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [checks, setChecks] = useState<boolean[]>([false, false, false]);
  const abort = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const active =
    board?.quests.find((q) => q.state === "in_progress") ??
    board?.quests.find((q) => q.state === "available");
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
  useEffect(() => setChecks([false, false, false]), [active?.id]);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: "nearest" });
  }, [draft, board?.thread?.messages.length]);
  async function act(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить запрос");
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
        throw new Error("Подтвердите согласие на AI-рекомендации");
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
    if (!board?.thread || !text.trim()) return;
    const message = text;
    setText("");
    setDraft("");
    abort.current = new AbortController();
    await act(async () => {
      try {
        await api.stream(
          board.thread!.id,
          message,
          crypto.randomUUID(),
          (event) => {
            if (event.type === "delta") setDraft((value) => value + event.text);
            if (event.type === "handoff") setNotice(event.reason);
          },
          abort.current!.signal,
        );
      } finally {
        await refresh();
        setDraft("");
      }
    });
  }
  return (
    <div
      className={"shell" + (board && !board.profile ? " shell-onboarding" : "")}
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
          <div className="dashboard">
            <aside className="sidebar">
              <span className="eyebrow">ВАШ МАРШРУТ</span>
              <h2>{board.profile.targetCity}</h2>
              <p>из {board.profile.originCity}</p>
              <nav>
                <a href="#plan" className="selected">
                  ◈ Мой план
                </a>
                <a href="#quest">⌂ Жилищный квест</a>
                <a href="#chat">✧ AI-помощник</a>
              </nav>
              <div className="sidebar-bottom">
                <Progress
                  value={
                    (board.quests.filter((q) => q.state === "completed")
                      .length /
                      board.quests.length) *
                    100
                  }
                  label="Прогресс маршрута"
                />
                <small>
                  Каждый небольшой шаг приближает вас к новому дому.
                </small>
              </div>
            </aside>
            <div className="workspace">
              <section id="plan" className="plan-hero">
                <div>
                  <Badge>ЛИЧНЫЙ ПЛАН ПЕРЕЕЗДА</Badge>
                  <h1>
                    Ваш следующий шаг —<br />
                    почувствовать себя дома.
                  </h1>
                  <p>
                    {board.profile.targetCity} · до{" "}
                    {new Date(
                      board.profile.moveTargetDate + "T12:00:00",
                    ).toLocaleDateString("ru-RU")}{" "}
                    · {board.profile.monthlyBudget.toLocaleString("ru-RU")} ₽ /
                    месяц
                  </p>
                </div>
                <div className="xp-circle">
                  <strong>{board.xp}</strong>
                  <span>ВАШИ XP</span>
                </div>
              </section>
              <div className="work-grid">
                <div>
                  <Card id="quest">
                    <div className="section-title">
                      <span className="eyebrow">
                        {board.xp ? "СЛЕДУЮЩИЙ КВЕСТ" : "ВАШ ПЕРВЫЙ КВЕСТ"}
                      </span>
                      <Badge>+60 XP</Badge>
                    </div>
                    {active ? (
                      <>
                        <h2>{active.title}</h2>
                        <p>
                          Поговорите с AI-помощником, уточните критерии и
                          подтвердите, что готовы двигаться дальше.
                        </p>
                        {active.state === "available" ? (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await api.start(active.id);
                                await refresh();
                              })
                            }
                          >
                            Начать квест
                          </Button>
                        ) : (
                          <>
                            <div className="checklist">
                              {questChecklist(active.slug).map((item, i) => (
                                <label className="check" key={item}>
                                  <input
                                    type="checkbox"
                                    checked={checks[i]}
                                    onChange={(event) =>
                                      setChecks((values) =>
                                        values.map((v, j) =>
                                          j === i ? event.target.checked : v,
                                        ),
                                      )
                                    }
                                  />
                                  <span>{item}</span>
                                </label>
                              ))}
                            </div>
                            <Button
                              disabled={busy || !checks.every(Boolean)}
                              onClick={() =>
                                void act(async () => {
                                  const result = await api.complete(active.id);
                                  setNotice(
                                    result.awarded
                                      ? "+60 XP — квест завершён! Открыт следующий шаг."
                                      : "Этот квест уже завершён",
                                  );
                                  await refresh();
                                })
                              }
                            >
                              Завершить квест · +60 XP
                            </Button>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <h2>Маршрут по жилью завершён</h2>
                        <p>
                          Вы подготовили критерии поиска и план просмотра.
                          Следующие этапы появятся по мере развития CityGo.
                        </p>
                      </>
                    )}
                  </Card>
                  <Card className="route-card">
                    <h3>Ваш маршрут</h3>
                    {board.quests.map((q, i) => (
                      <div className="route-row" key={q.id}>
                        <span className={"route-dot " + q.state}>
                          {q.state === "completed" ? "✓" : i + 1}
                        </span>
                        <div>
                          <strong>{q.title}</strong>
                          <small>
                            {
                              {
                                available: "Можно начинать",
                                in_progress: "В работе",
                                locked: "Откроется после предыдущего шага",
                                completed: "Завершено · +60 XP",
                              }[q.state]
                            }
                          </small>
                        </div>
                      </div>
                    ))}
                  </Card>
                  <Card className="team-card">
                    <h3>Ваша команда</h3>
                    <p>
                      Попросите о работе, резюме или адаптации — диалог перейдёт
                      к нужному помощнику.
                    </p>
                    <div className="team">
                      {Object.entries(names).map(([id, name]) => (
                        <div key={id}>
                          <Image
                            src={"/characters/" + id + "-192.webp"}
                            alt={name}
                            width={56}
                            height={42}
                          />
                          <span>{name}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
                <Card id="chat" className="chat-card">
                  <div className="chat-heading">
                    <Image
                      src={
                        "/characters/" +
                        (board.thread?.agentKey ?? "housing") +
                        "-192.webp"
                      }
                      alt=""
                      width={72}
                      height={54}
                    />
                    <div>
                      <h3>{names[board.thread?.agentKey ?? "housing"]}</h3>
                      <small>AI-помощник · история сохраняется</small>
                    </div>
                  </div>
                  {board.provider === "unconfigured" && (
                    <p className="provider-warning">
                      AI ещё не подключён. Для ответов нужен ключ провайдера на
                      сервере.
                    </p>
                  )}
                  <div
                    className="messages"
                    role="log"
                    aria-label="История чата"
                  >
                    <p className="chat-intro">
                      Начните квест и расскажите, какое жильё ищете. Не
                      отправляйте паспорт, пароли и банковские данные.
                    </p>
                    {board.thread?.messages.map((m) => (
                      <div className={"message " + m.role} key={m.id}>
                        <small>
                          {m.role === "user" ? "Вы" : names[m.agentKey]}
                        </small>
                        <p>{m.content || "Ответ не получен"}</p>
                        {m.status === "interrupted" && (
                          <small>Ответ не завершён</small>
                        )}
                      </div>
                    ))}
                    {draft && (
                      <div className="message assistant">
                        <small>Печатает…</small>
                        <p>{draft}</p>
                      </div>
                    )}
                    <div ref={messagesEnd} />
                  </div>
                  <form onSubmit={chat} className="chat-form">
                    <label className="sr-only" htmlFor="message">
                      Сообщение помощнику
                    </label>
                    <textarea
                      id="message"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Мне нужна квартира рядом с метро…"
                      maxLength={4000}
                      rows={3}
                      disabled={
                        !board.thread ||
                        busy ||
                        board.provider === "unconfigured"
                      }
                    />
                    <div>
                      <small>
                        {!board.thread
                          ? "Сначала начните квест"
                          : "AI может ошибаться. Проверяйте важные факты."}
                      </small>
                      <Button
                        disabled={
                          !board.thread ||
                          busy ||
                          !text.trim() ||
                          board.provider === "unconfigured"
                        }
                        type="submit"
                      >
                        Отправить
                      </Button>
                      {busy && draft && (
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => abort.current?.abort()}
                        >
                          Стоп
                        </Button>
                      )}
                    </div>
                  </form>
                </Card>
              </div>
            </div>
          </div>
        )}
      </main>
      <footer>
        CityGo · Место для вашего нового начала{" "}
        <span>Web MVP · Токены и анкета сверены с Figma</span>
      </footer>
    </div>
  );
}
