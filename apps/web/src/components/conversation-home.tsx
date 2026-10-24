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
import {
  PersonalPlanPanel,
  PlanStepComposer,
  type PlanMessageSource,
} from "./personal-plan";
import planStyles from "./personal-plan.module.css";
import { accountStyles } from "./account-overview";

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

/** Conversation home and user-selected plan, from Figma 6:14 / 6:24. */
export function ConversationHome(props: JourneyProps) {
  const [tab, setTab] = useState("Диалоги");
  const [showList, setShowList] = useState(false);
  const [planSource, setPlanSource] = useState<PlanMessageSource | null>(null);
  const [planGeneration, setPlanGeneration] = useState(0);
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
  const contextAgent = tab === "Мой план" ? "support" : agent;
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
      setPlanSource(null);
      setTab("Диалоги");
      setShowList(false);
    }
    return !!started;
  };
  const open = async (id: string) => {
    const opened = await props.onOpenConversation?.(id);
    if (opened) {
      setPlanSource(null);
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
            contextAgent === "support"
              ? "/figma/support-assistant.png"
              : `/characters/${contextAgent}-640.webp`
          }
          width={240}
          height={240}
          alt={agentNames[contextAgent]}
        />
        <h2>{agentNames[contextAgent]}</h2>
        <p>{assistantTitle(contextAgent)}</p>
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
      {planSource && (
        <PlanStepComposer
          key={board.user.id + ":" + planSource.messageId}
          userId={board.user.id}
          sessionSignal={props.sessionSignal}
          onAccessDenied={props.onAccessDenied}
          source={planSource}
          onSaved={() => {
            setPlanSource(null);
            setPlanGeneration((current) => current + 1);
            setTab("Мой план");
          }}
          onCancel={(checkPlan) => {
            setPlanSource(null);
            if (checkPlan) {
              setPlanGeneration((current) => current + 1);
              setTab("Мой план");
            }
          }}
        />
      )}
      {tab === "Мой план" ? (
        <div className={"conversation-workspace " + planStyles.workspace}>
          {sidebar}
          <div className="conversation-main">
            <PersonalPlanPanel
              key={board.user.id + ":plan:" + planGeneration}
              userId={board.user.id}
              sessionSignal={props.sessionSignal}
              onAccessDenied={props.onAccessDenied}
              navigationBusy={busy || sending}
              onOpenConversation={open}
              onContinue={() => {
                setTab("Диалоги");
                setShowList(false);
              }}
              onHelpers={() => setTab("Помощники")}
            />
          </div>
          {rail}
        </div>
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
          <div className={accountStyles.profileCard}>
            <span className={accountStyles.eyebrow}>БАЛАНС CITYGO</span>
            <h2>Баланс и пополнение</h2>
            <p>Остаток, пополнение через ЮKassa и последние операции.</p>
            <Button disabled={busy || sending} onClick={props.onBalance}>
              Баланс и пополнение
            </Button>
          </div>
          <div className={accountStyles.profileCard}>
            <span className={accountStyles.eyebrow}>КОНТАКТЫ АККАУНТА</span>
            <h2>Телефон и подарок</h2>
            <p>Подтвердите номер по SMS. Разовый подарок — 500 ₽ CityGo.</p>
            <Button
              variant="secondary"
              disabled={busy || sending}
              onClick={props.onPhone}
            >
              Телефон и подарок
            </Button>
          </div>
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
                    <Button
                      variant="ghost"
                      disabled={busy || sending || !!planSource}
                      onClick={() =>
                        setPlanSource({
                          messageId: message.id,
                          threadId: board.thread!.id,
                          role: message.role,
                          content: message.content,
                        })
                      }
                    >
                      Добавить шаг в план
                    </Button>
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
                  <EmptyAiCreditHint
                    access={board.aiAccess}
                    onBalance={props.onBalance}
                  />
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
                onBalance={props.onBalance}
              />
            )}
          </div>
          {rail}
        </div>
      )}
    </section>
  );
}
