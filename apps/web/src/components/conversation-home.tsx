"use client";
import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button, Card, Badge, AssistantMessage } from "@citygo/ui-web";
import { AiAccessPanel } from "./ai-access";
import { agentNames, type JourneyProps } from "./journey";
import { FavoriteButton } from "./message-favorites";
import { EmptyAiCreditHint, messageInterruptionLabel } from "./chat-readiness";
import type { AgentKey } from "@citygo/contracts";
import {
  AssistantCatalog,
  ConversationList,
  assistantTitle,
} from "./assistant-conversations";
import {
  ConversationHistoryControls,
  conversationHistoryStyles,
  useHistoryScrollAnchor,
} from "./conversation-history";

const topics = [
  ["Понять и спланировать", "Не понимаю, с чего начать переезд в Москву."],
  ["Найти жильё", "Хочу обсудить поиск жилья в Москве."],
  ["Работа и резюме", "Как подготовиться к поиску работы в Москве?"],
  ["Переезд и вещи", "Как подготовить поездку и перевозку вещей?"],
  [
    "Освоиться в городе",
    "Как разобраться в транспорте и городских сервисах Москвы?",
  ],
  ["Свои люди", "Как найти своё окружение после переезда?"],
] as const;
const greeting =
  "Здравствуйте! Я координатор CityGo. Помогу разложить переезд на понятные шаги. Можно просто рассказать, что сейчас волнует — даже если бюджет и дата ещё неизвестны.";

/** First conversational slice of Figma 6:14. No invented plan or profile. */
export function ConversationHome(props: JourneyProps) {
  const [tab, setTab] = useState("Диалоги");
  const [showList, setShowList] = useState(false);
  const { board, busy, sending } = props;
  const log = useRef<HTMLDivElement>(null);
  const historyScroll = useHistoryScrollAnchor(
    log,
    board.thread?.messages ?? [],
    {
      threadId: board.thread?.id,
      detached: props.history?.detached,
      draft: props.draft,
      pending: props.pending,
    },
  );
  const agent = props.streamAgent ?? board.thread?.agentKey ?? "support";
  const canSend =
    !!board.thread &&
    board.provider !== "unconfigured" &&
    board.aiAccess.granted &&
    !board.thread.closed &&
    !props.history?.detached &&
    !busy;
  const suggest = (text: string) => {
    props.onText(text);
    setTab("Диалоги");
    setShowList(false);
  };
  const begin = async (key?: AgentKey) => {
    const started = await props.onBegin?.(key);
    if (started) {
      setTab("Диалоги");
      setShowList(false);
    }
    return !!started;
  };
  const open = async (id: string) => {
    const opened = await props.onOpenConversation?.(id);
    if (opened) {
      setTab("Диалоги");
      setShowList(false);
    }
    return !!opened;
  };
  const sidebar = (
    <aside className="conversation-topics">
      <Card>
        <span className="eyebrow">ВАШ ПУТЬ В МОСКВУ</span>
        {topics.map(([label, text]) => (
          <Button
            key={label}
            variant="secondary"
            disabled={busy || sending}
            onClick={() => suggest(text)}
          >
            {label}
          </Button>
        ))}
        <div className="conversation-note">
          <strong>В вашем темпе</strong>
          <p>Можно начать с любой задачи. Необязательно знать срок и бюджет.</p>
        </div>
        <Image
          src="/figma/support-assistant.png"
          width={64}
          height={64}
          alt="Координатор переезда CityGo"
        />
      </Card>
    </aside>
  );
  const rail = (
    <aside className="conversation-context">
      <Card>
        <span className="eyebrow">ВАШ AI-ПОМОЩНИК</span>
        <Image
          src={
            agent === "support"
              ? "/figma/support-assistant.png"
              : `/characters/${agent}-640.webp`
          }
          width={240}
          height={240}
          alt={agentNames[agent]}
        />
        <h2>{agentNames[agent]}</h2>
        <p>{assistantTitle(agent)}</p>
        <p>
          Начните с вопроса. Помощник уточнит только нужное по ходу разговора.
        </p>
        <Button
          variant="secondary"
          disabled={busy || sending}
          onClick={() => setTab("Помощники")}
        >
          Сменить помощника
        </Button>
        <small>
          Ответы AI — ориентир, не проверенная сделка и не бронирование.
        </small>
      </Card>
    </aside>
  );
  return (
    <section className="conversation-home">
      <nav aria-label="Личный кабинет CityGo" className="conversation-tabs">
        {["Мой план", "Диалоги", "Помощники", "Профиль"].map((name) => (
          <Button
            key={name}
            variant={tab === name ? "primary" : "secondary"}
            aria-pressed={tab === name}
            disabled={busy || sending}
            onClick={() => {
              setTab(name);
              if (name === "Диалоги") {
                setShowList(true);
                props.onConversations?.();
              }
            }}
          >
            {name}
          </Button>
        ))}
      </nav>
      {tab === "Мой план" ? (
        <Card>
          <h1>Ваш путь в Москву</h1>
          <p>
            План будет складываться из разговора и выбранных вами следующих
            шагов. Пока бюджет, срок и обстоятельства неизвестны — мы их не
            придумываем. Сохранение структурированного плана из диалога появится
            в следующем этапе.
          </p>
          <Button
            onClick={() => {
              setTab("Диалоги");
              setShowList(false);
            }}
          >
            Обсудить следующий шаг
          </Button>
        </Card>
      ) : tab === "Помощники" || (tab === "Диалоги" && showList) ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            {tab === "Помощники" ? (
              <AssistantCatalog busy={busy || sending} onBegin={begin} />
            ) : (
              <ConversationList
                conversations={props.conversations ?? null}
                nextCursor={props.conversationNextCursor ?? null}
                busy={busy || sending}
                onOpen={open}
                onLoad={(before) => props.onConversations?.(before)}
                onHelpers={() => setTab("Помощники")}
                onFavorites={props.onFavorites}
              />
            )}
          </div>
          {rail}
        </div>
      ) : tab === "Профиль" ? (
        <Card>
          <h1>Личный кабинет</h1>
          <p>{board.user.username ?? board.user.email}</p>
          <p>Роль: {board.user.role ?? "user"}</p>
          <Button variant="secondary" onClick={props.onFavorites}>
            Избранные сообщения
          </Button>
          <Button variant="secondary" onClick={props.onPassword}>
            Изменить пароль
          </Button>
          {["admin", "super_admin"].includes(board.user.role ?? "") && (
            <p>
              <Link href="/admin">Открыть админку сервиса</Link>
            </p>
          )}
          <p>
            Бюджет, срок переезда и тип жилья можно уточнить в диалоге, когда
            будете готовы.
          </p>
        </Card>
      ) : (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            <Card>
              <Badge>ДИАЛОГ С ПОМОЩНИКОМ</Badge>
              <h1>
                {board.thread?.assistantKey
                  ? assistantTitle(board.thread.assistantKey)
                  : "Давайте начнём с того, что волнует"}
              </h1>
              <p>
                Можно начать с любого вопроса. Уточним нужное по ходу разговора.
              </p>
              <Button
                variant="ghost"
                disabled={busy || sending}
                onClick={() => {
                  setShowList(true);
                  props.onConversations?.();
                }}
              >
                Все диалоги
              </Button>
              <ConversationHistoryControls
                state={props.history}
                disabled={busy || sending}
                onOlder={() => historyScroll.loadOlder(props.onOlderMessages)}
                onLatest={() =>
                  historyScroll.returnToLatest(props.onLatestMessages)
                }
              />
              <div
                ref={log}
                className={
                  "conversation-messages " +
                  conversationHistoryStyles.viewport +
                  " " +
                  conversationHistoryStyles.chatViewport
                }
                aria-label="История диалога"
                role="log"
                aria-live="polite"
                aria-busy={props.history?.phase === "loading"}
              >
                {!board.thread?.messages.length && (
                  <article className="conversation-message assistant">
                    <strong>AI-ПОМОЩНИК</strong>
                    <AssistantMessage
                      content={
                        board.thread?.assistantKey &&
                        board.thread.assistantKey !== "support"
                          ? `Здравствуйте! Я ${assistantTitle(board.thread.assistantKey).toLowerCase()}. Расскажите, с чем нужна помощь. Можно начать без известного бюджета и срока.`
                          : greeting
                      }
                    />
                  </article>
                )}
                {board.thread?.messages.map((message) => (
                  <article
                    key={message.id}
                    data-history-message={message.id}
                    className={"conversation-message " + message.role}
                  >
                    <strong>
                      {message.role === "user"
                        ? "Вы"
                        : agentNames[message.agentKey]}
                    </strong>
                    {message.role === "user" ? (
                      <p>{message.content}</p>
                    ) : (
                      <AssistantMessage content={message.content} />
                    )}
                    {message.status === "interrupted" && (
                      <small>
                        {messageInterruptionLabel(message, "Ответ прерван")}
                      </small>
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
                {props.pending && (
                  <article className="conversation-message user">
                    <strong>Вы</strong>
                    <p>{props.pending}</p>
                  </article>
                )}
                {props.draft && (
                  <article className="conversation-message assistant">
                    <strong>{agentNames[agent]}</strong>
                    <AssistantMessage content={props.draft} />
                  </article>
                )}
              </div>
              {!board.thread ? (
                <Button disabled={busy} onClick={() => void begin()}>
                  Начать диалог
                </Button>
              ) : board.thread.closed ? (
                <p>
                  Это завершённый разговор. История и избранное доступны; новый
                  вопрос можно задать в открытом диалоге помощника.
                </p>
              ) : (
                <form onSubmit={props.onChat}>
                  <EmptyAiCreditHint access={board.aiAccess} />
                  <label htmlFor="conversation-message">
                    Сообщение помощнику
                  </label>
                  <textarea
                    id="conversation-message"
                    value={props.text}
                    onChange={(e) => props.onText(e.target.value)}
                    maxLength={4000}
                    rows={3}
                    placeholder="Хочу переехать в Москву, но пока не понимаю, с чего начать"
                    disabled={!canSend || sending}
                  />
                  {sending ? (
                    <Button type="button" onClick={props.onStop}>
                      Остановить ответ
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={!canSend || !props.text.trim()}
                    >
                      Отправить
                    </Button>
                  )}
                </form>
              )}
            </Card>
            {board.thread && (
              <AiAccessPanel
                key={`${board.user.id}:${board.aiAccess.policy?.id}:${board.aiAccess.granted}`}
                access={board.aiAccess}
                busy={busy}
                onConsent={props.onConsent}
                userId={board.user.id}
                topups={props.topups}
              />
            )}
          </div>
          {rail}
        </div>
      )}
    </section>
  );
}
