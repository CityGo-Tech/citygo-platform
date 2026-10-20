"use client";
import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AgentKey,
  AiConsentInput,
  Dashboard,
  Quest,
} from "@citygo/contracts";
import {
  AssistantMessage,
  Badge,
  Button,
  Card,
  Progress,
} from "@citygo/ui-web";
import { questChecklist } from "@citygo/content";
import { AiAccessPanel } from "./ai-access";
import type { TopupActions } from "./test-topup";
import { FavoriteButton } from "./message-favorites";

import { agentNames } from "./agent-names";
export { agentNames } from "./agent-names";
const stateLabels: Record<Quest["state"], string> = {
  locked: "Откроется после предыдущего шага",
  available: "Можно начинать",
  in_progress: "В работе",
  completed: "Завершено",
};
export type JourneyProps = {
  board: Dashboard;
  busy: boolean;
  sending: boolean;
  draft: string;
  pending: string;
  streamAgent: AgentKey | null;
  text: string;
  onText: (value: string) => void;
  onChat: (event: FormEvent) => void;
  onStop: () => void;
  onConsent: (input: AiConsentInput) => void;
  onStart: (id: string) => Promise<boolean>;
  onComplete: (id: string) => Promise<boolean>;
  onBegin?: () => void;
  onPassword?: () => void;
  onFavorites?: () => void;
  onFavorite?: (messageId: string, saved: boolean) => void;
  topups?: TopupActions;
};

function Avatar({
  agent = "housing",
  large = false,
}: {
  agent?: AgentKey;
  large?: boolean;
}) {
  return (
    <Image
      className={large ? "journey-portrait" : "journey-avatar"}
      src={
        agent === "housing"
          ? "/figma/housing-navigator.png"
          : "/characters/" + agent + (large ? "-640.webp" : "-192.webp")
      }
      alt=""
      width={large ? 240 : 80}
      height={large ? 180 : 80}
      sizes={large ? "240px" : "80px"}
    />
  );
}

function RouteMap({ quests }: { quests: Quest[] }) {
  return (
    <ol className="journey-route" aria-label="Карта пути">
      {quests.map((quest, index) => (
        <li className={quest.state} key={quest.id}>
          <span className="journey-route-marker" aria-hidden="true">
            {quest.state === "completed" ? "✓" : index + 1}
          </span>
          <strong>{quest.title}</strong>
          <small>{stateLabels[quest.state]}</small>
        </li>
      ))}
    </ol>
  );
}

export function Journey(props: JourneyProps) {
  const { board, busy, sending, text, onText, draft, pending } = props;
  const [hash, setHash] = useState("#plan");
  const [checks, setChecks] = useState<boolean[]>([false, false, false]);
  const heading = useRef<HTMLHeadingElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const active =
    board.quests.find((q) => q.state === "in_progress") ??
    board.quests.find((q) => q.state === "available");
  const completed = board.quests.find(
    (q) => q.id === hash.slice("#complete/".length) && q.state === "completed",
  );
  const view =
    hash.startsWith("#complete/") && completed
      ? "complete"
      : hash === "#chat"
        ? "chat"
        : "plan";
  const agent = props.streamAgent ?? board.thread?.agentKey ?? "housing";
  const doneCount = board.quests.filter((q) => q.state === "completed").length;
  const canChat =
    !!board.thread &&
    board.provider !== "unconfigured" &&
    !!board.aiAccess?.granted &&
    !busy;
  const checkedCount = checks.filter(Boolean).length;

  useEffect(() => {
    const update = () => setHash(window.location.hash || "#plan");
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => setChecks([false, false, false]), [active?.id]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (hash === "#agents")
      document
        .getElementById("journey-agents")
        ?.scrollIntoView({ block: "start" });
  }, [view, hash]);
  useEffect(() => {
    // Scroll only the conversation, never pull the whole page away from the checklist.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [draft, board.thread?.messages.length, view, pending]);

  function navigate(target: string) {
    window.location.hash = target;
    setHash("#" + target);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  async function start() {
    if (!active) return;
    if (active.state === "in_progress" || (await props.onStart(active.id)))
      navigate("chat");
  }
  async function complete() {
    if (!active) return;
    const id = active.id;
    if (await props.onComplete(id)) navigate("complete/" + id);
  }
  function suggest(value: string) {
    onText(value);
    composer.current?.focus();
  }
  const questList = (
    <ol className="journey-quest-list" aria-label="Квесты переезда">
      {board.quests.map((quest, index) => (
        <li className={quest.state} key={quest.id}>
          <span className="journey-route-marker" aria-hidden="true">
            {quest.state === "completed" ? "✓" : index + 1}
          </span>
          <div>
            <strong>{quest.title}</strong>
            <small>{stateLabels[quest.state]}</small>
          </div>
          <span className="journey-reward">+{quest.xpReward} XP</span>
          {view === "plan" && quest.id === active?.id && (
            <div className="journey-mobile-quest-action">
              <Button disabled={busy} onClick={() => void start()}>
                {quest.state === "in_progress"
                  ? "Продолжить квест"
                  : "Начать квест"}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );

  return (
    <div className={"journey journey-" + view}>
      <nav className="journey-nav" aria-label="Навигация по переезду">
        <a
          href="#plan"
          aria-current={
            view === "plan" && hash !== "#agents" ? "page" : undefined
          }
        >
          Мой план
        </a>
        <a href="#chat" aria-current={view === "chat" ? "page" : undefined}>
          Чат
        </a>
        <a
          href="#agents"
          aria-current={hash === "#agents" ? "page" : undefined}
        >
          Агенты
        </a>
      </nav>

      {view === "plan" && (
        <>
          <header className="journey-plan-heading">
            <div>
              <h1 tabIndex={-1} ref={heading}>
                Ваш план переезда
              </h1>
              <p>
                {board.profile?.originCity} → {board.profile?.targetCity} ·{" "}
                {board.profile?.monthlyBudget.toLocaleString("ru-RU")} ₽ / месяц
              </p>
            </div>
            <Badge>
              Завершено {doneCount} из {board.quests.length}
            </Badge>
          </header>
          <div className="journey-plan-grid">
            <aside>
              {questList}
              <Progress
                value={(doneCount / board.quests.length) * 100}
                label="Прогресс маршрута"
              />
            </aside>
            <Card className="journey-detail" id="quest">
              <header className="journey-detail-heading">
                <Badge>{active ? "КВЕСТ: ЖИЛЬЁ" : "МАРШРУТ ЗАВЕРШЁН"}</Badge>
                <h2>{active?.title ?? "Вы готовы к следующему шагу"}</h2>
                <p>
                  Надёжное жильё начинается с ясных критериев. Подготовьтесь к
                  поиску и просмотру вместе с AI-помощником.
                </p>
                {active && (
                  <small>
                    Жилищный маршрут · +{active.xpReward} XP за квест
                  </small>
                )}
              </header>
              <div className="journey-detail-body">
                <div className="journey-navigator">
                  <div className="journey-agent-heading">
                    <Avatar />
                    <div>
                      <h3>Housing Navigator</h3>
                      <p>AI-помощник по поиску и аренде жилья</p>
                    </div>
                  </div>
                  {active ? (
                    <ul>
                      {questChecklist(active.slug).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      Критерии поиска и план просмотра обсуждены. Новые
                      направления появятся позже.
                    </p>
                  )}
                </div>
                <div className="journey-actions">
                  {active && (
                    <Button
                      className="journey-desktop-start"
                      disabled={busy}
                      onClick={() => void start()}
                    >
                      {active.state === "in_progress"
                        ? "Продолжить квест"
                        : "Начать квест"}
                    </Button>
                  )}
                  {board.thread && (
                    <Button
                      variant="secondary"
                      onClick={() => navigate("chat")}
                    >
                      Открыть историю чата
                    </Button>
                  )}
                </div>
                <section
                  id="journey-agents"
                  aria-labelledby="journey-team-title"
                >
                  <h3 id="journey-team-title">Команда агентов</h3>
                  <p>
                    Попросите о работе, резюме или адаптации в чате — диалог
                    перейдёт к нужному AI-помощнику.
                  </p>
                  <div className="journey-team">
                    {(Object.keys(agentNames) as AgentKey[]).map((key) => (
                      <div key={key}>
                        <Avatar agent={key} />
                        <span>{agentNames[key]}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </Card>
          </div>
          <section className="journey-map-section">
            <h2>Карта пути</h2>
            <RouteMap quests={board.quests} />
          </section>
        </>
      )}

      {view === "chat" && (
        <div className="journey-chat-grid">
          <Card className="journey-chat-sidebar">
            <h2>Карта квеста</h2>
            <Badge>
              {doneCount} из {board.quests.length} завершено
            </Badge>
            {questList}
            <div className="journey-support">
              <small>SUPPORT ASSISTANT</small>
              <div className="journey-agent-heading">
                <Avatar agent="support" />
                <strong>Помощник CityGo</strong>
              </div>
              <Button
                variant="secondary"
                disabled={!canChat}
                onClick={() =>
                  suggest(
                    "Нужна поддержка по переезду. Помоги разобраться, с чего начать.",
                  )
                }
              >
                Задать вопрос
              </Button>
              <small>
                Подготовит сообщение. Отправьте его, когда будете готовы.
              </small>
            </div>
          </Card>
          <section
            className="journey-conversation"
            aria-label="Диалог с AI-помощником"
          >
            <header className="journey-chat-heading">
              <Avatar agent={agent} />
              <div>
                <h1 tabIndex={-1} ref={heading}>
                  {agentNames[agent]}
                </h1>
                <small>
                  {sending
                    ? "Готовит ответ…"
                    : "AI-помощник · история сохраняется"}
                </small>
              </div>
              <Badge>КВЕСТ: ЖИЛЬЁ</Badge>
            </header>
            {board.provider === "unconfigured" && (
              <p className="provider-warning" role="note">
                AI ещё не подключён. Для ответов нужен ключ провайдера на
                сервере.
              </p>
            )}
            <AiAccessPanel
              userId={board.user.id}
              key={`${board.user.id}:${board.aiAccess?.policy?.id}:${board.aiAccess?.granted}`}
              access={
                board.aiAccess ?? {
                  policy: null,
                  granted: false,
                  dailyLimit: 0,
                }
              }
              busy={busy}
              onConsent={props.onConsent}
              topups={props.topups}
            />
            {!board.thread && (
              <Card>
                <p>Начните жилищный квест, чтобы открыть диалог.</p>
                <Button disabled={busy || !active} onClick={() => void start()}>
                  Начать квест
                </Button>
              </Card>
            )}
            <div
              ref={log}
              className="journey-messages"
              role="log"
              aria-label="История чата"
              aria-live="polite"
              aria-relevant="additions text"
            >
              <p className="journey-chat-intro">
                Расскажите, какое жильё ищете. Не отправляйте паспорт, пароли и
                банковские данные.
              </p>
              {board.thread?.messages.map((message) => (
                <article
                  className={"journey-message " + message.role}
                  key={message.id}
                >
                  <small>
                    {message.role === "user"
                      ? "Вы"
                      : agentNames[message.agentKey]}
                  </small>
                  {message.role === "assistant" ? (
                    <AssistantMessage
                      content={message.content || "Ответ не получен"}
                    />
                  ) : (
                    <p>{message.content || "Ответ не получен"}</p>
                  )}
                  {message.status === "interrupted" && (
                    <small>Ответ не завершён</small>
                  )}
                  <FavoriteButton
                    saved={message.favorite}
                    disabled={busy || sending}
                    onClick={() =>
                      props.onFavorite?.(message.id, !message.favorite)
                    }
                  />
                </article>
              ))}
              {sending && pending && (
                <article className="journey-message user">
                  <small>Вы · отправляется</small>
                  <p>{pending}</p>
                </article>
              )}
              {sending && (
                <article className="journey-message assistant">
                  <small>{agentNames[agent]} · печатает…</small>
                  <AssistantMessage content={draft || "Готовлю ответ…"} />
                </article>
              )}
            </div>
            {board.thread && (
              <div className="journey-quick-replies">
                <span>Быстрый ответ</span>
                <div>
                  {(agent === "housing"
                    ? ["До 30 минут в пути", "Важнее инфраструктура"]
                    : ["Вернёмся к поиску квартиры"]
                  ).map((reply) => (
                    <Button
                      key={reply}
                      variant={text === reply ? "primary" : "secondary"}
                      aria-pressed={text === reply}
                      disabled={!canChat}
                      onClick={() => suggest(reply)}
                    >
                      {reply}
                    </Button>
                  ))}
                </div>
                <small>
                  Выберите подсказку, при необходимости измените и отправьте
                  сообщение.
                </small>
              </div>
            )}
            <form onSubmit={props.onChat} className="journey-composer">
              <label className="sr-only" htmlFor="journey-message">
                Сообщение помощнику
              </label>
              <textarea
                ref={composer}
                id="journey-message"
                value={text}
                onChange={(event) => onText(event.target.value)}
                placeholder="Напишите сообщение…"
                maxLength={4000}
                rows={2}
                disabled={!canChat}
              />
              <Button disabled={!canChat || !text.trim()} type="submit">
                Отправить
              </Button>
              {sending && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={props.onStop}
                >
                  Стоп
                </Button>
              )}
              <small>AI может ошибаться. Проверяйте важные факты.</small>
            </form>
          </section>
          <Card className="journey-agent-panel" id="quest">
            <span className="eyebrow">ВАШ АГЕНТ</span>
            <figure>
              <Avatar agent={agent} large />
              <figcaption>
                <strong>{agentNames[agent]}</strong>
                <small>AI-помощник</small>
              </figcaption>
            </figure>
            <h2>{active?.title ?? "Жилищный маршрут завершён"}</h2>
            {active?.state === "in_progress" ? (
              <>
                <Progress
                  value={(checkedCount / 3) * 100}
                  label={`Готово ${checkedCount} из 3 критериев`}
                />
                <fieldset className="journey-checklist" disabled={busy}>
                  <legend>Подтвердите результат</legend>
                  {questChecklist(active.slug).map((item, index) => (
                    <label className="check" key={item}>
                      <input
                        type="checkbox"
                        checked={checks[index]}
                        onChange={(event) =>
                          setChecks((values) =>
                            values.map((value, i) =>
                              i === index ? event.target.checked : value,
                            ),
                          )
                        }
                      />
                      <span>{item}</span>
                    </label>
                  ))}
                </fieldset>
                <p className="journey-completion-hint" id="completion-hint">
                  Сначала обсудите этот квест с Housing Navigator, затем
                  подтвердите все критерии. Завершение проверяется сервером.
                </p>
                <Button
                  className="journey-finish"
                  aria-describedby="completion-hint"
                  disabled={busy || !checks.every(Boolean)}
                  onClick={() => void complete()}
                >
                  Завершить квест · +{active.xpReward} XP
                </Button>
                <small>Результат сохранится в плане</small>
              </>
            ) : (
              <>
                <p>
                  {active
                    ? "Начните следующий квест, когда будете готовы."
                    : "История диалога остаётся доступной."}
                </p>
                <Button variant="secondary" onClick={() => navigate("plan")}>
                  Вернуться к карте
                </Button>
              </>
            )}
          </Card>
        </div>
      )}

      {view === "complete" && completed && (
        <>
          <section
            className="journey-success"
            aria-labelledby="journey-complete-title"
          >
            <span className="journey-success-mark" aria-hidden="true">
              ✓
            </span>
            <div>
              <Badge tone="success">КВЕСТ ЗАВЕРШЁН</Badge>
              <h1 ref={heading} tabIndex={-1} id="journey-complete-title">
                {completed.slug === "housing-viewing"
                  ? "План просмотра готов"
                  : "Жильё: первый маршрут готов"}
              </h1>
              <p>{completed.title}. Результат и история диалога сохранены.</p>
              <strong className="journey-success-xp">
                +{completed.xpReward} XP
              </strong>
            </div>
            <Avatar large />
          </section>
          <div className="journey-complete-grid">
            <Card>
              <h2>Обновлённая карта</h2>
              <p>
                Завершено {doneCount} из {board.quests.length} квестов · всего{" "}
                {board.xp} XP
              </p>
              <RouteMap quests={board.quests} />
            </Card>
            <Card className="journey-next">
              <Badge>
                {active ? "СЛЕДУЮЩИЙ КВЕСТ" : "ВСЕ КВЕСТЫ ЗАВЕРШЕНЫ"}
              </Badge>
              <h2>{active?.title ?? "Жилищный маршрут завершён"}</h2>
              <p>Housing Navigator</p>
              {active ? (
                <>
                  <ul>
                    {questChecklist(active.slug).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <Button
                    className="journey-next-button"
                    disabled={busy}
                    onClick={() => void start()}
                  >
                    К следующему квесту
                  </Button>
                </>
              ) : (
                <p>
                  Вы подготовили критерии поиска и план просмотра. Следующие
                  направления появятся позже.
                </p>
              )}
              <Button variant="secondary" onClick={() => navigate("plan")}>
                Вернуться к карте
              </Button>
              <Button variant="ghost" onClick={() => navigate("chat")}>
                Открыть историю чата
              </Button>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
