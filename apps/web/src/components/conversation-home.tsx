"use client";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button, Card, Badge, AssistantMessage } from "@citygo/ui-web";
import { AiAccessPanel } from "./ai-access";
import { agentNames, type JourneyProps } from "./journey";

const helpers = [
  [
    "support",
    "Координатор переезда",
    "Помоги понять, с чего начать переезд в Москву.",
  ],
  [
    "housing",
    "Помощник по жилью",
    "Помоги подготовиться к поиску жилья в Москве.",
  ],
  [
    "job-search",
    "Помощник по работе",
    "Помоги составить план поиска работы в Москве.",
  ],
  [
    "resume-builder",
    "Помощник по резюме",
    "Помоги рассказать о моём опыте в резюме.",
  ],
  [
    "digital-mentor",
    "Гид по городской жизни",
    "Помоги разобраться в транспорте и первых шагах в Москве.",
  ],
] as const;
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
  const { board, busy, sending } = props;
  const agent = props.streamAgent ?? board.thread?.agentKey ?? "support";
  const canSend =
    !!board.thread &&
    board.provider !== "unconfigured" &&
    board.aiAccess.granted &&
    !busy;
  const suggest = (text: string) => {
    props.onText(text);
    setTab("Диалоги");
  };
  return (
    <section className="conversation-home">
      <nav aria-label="Личный кабинет CityGo" className="conversation-tabs">
        {["Мой план", "Диалоги", "Помощники", "Профиль"].map((name) => (
          <Button
            key={name}
            variant={tab === name ? "primary" : "secondary"}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
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
          <Button onClick={() => setTab("Диалоги")}>
            Обсудить следующий шаг
          </Button>
        </Card>
      ) : tab === "Помощники" ? (
        <div className="conversation-helper-grid">
          <h1>Команда CityGo</h1>
          {helpers.map(([key, name, suggestion]) => (
            <Card key={key}>
              <Image
                src={`/characters/${key}-192.webp`}
                width={64}
                height={64}
                alt=""
              />
              <h2>{name}</h2>
              <p>{agentNames[key]}</p>
              <Button variant="secondary" onClick={() => suggest(suggestion)}>
                Подготовить вопрос
              </Button>
            </Card>
          ))}
          <Card>
            <Badge>Партнёр · готовится</Badge>
            <h2>Bubble</h2>
            <p>
              Досуг под настроение. API партнёра пока не подключён — сообщения
              ему не отправляются.
            </p>
          </Card>
          <p>
            Выбор карточки подставляет вопрос. Координатор передаст диалог
            специалисту по теме сообщения.
          </p>
        </div>
      ) : tab === "Профиль" ? (
        <Card>
          <h1>Личный кабинет</h1>
          <p>{board.user.username ?? board.user.email}</p>
          <p>Роль: {board.user.role ?? "user"}</p>
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
          <aside className="conversation-topics">
            <Card>
              <span className="eyebrow">ВАШ ПУТЬ В МОСКВУ</span>
              {topics.map(([label, text]) => (
                <Button
                  key={label}
                  variant="secondary"
                  onClick={() => suggest(text)}
                >
                  {label}
                </Button>
              ))}
              <div className="conversation-note">
                <strong>В вашем темпе</strong>
                <p>
                  Можно начать с любой задачи. Необязательно знать срок и
                  бюджет.
                </p>
              </div>
              <Image
                src="/figma/support-assistant.png"
                width={64}
                height={64}
                alt="Координатор переезда CityGo"
              />
            </Card>
          </aside>
          <div className="conversation-main">
            <Card>
              <Badge>ДИАЛОГ С ПОМОЩНИКОМ</Badge>
              <h1>Давайте начнём с того, что волнует</h1>
              <p>
                Можно начать с любого вопроса. Уточним нужное по ходу разговора.
              </p>
              <div
                className="conversation-messages"
                aria-label="История диалога"
                role="log"
                aria-live="polite"
              >
                {!board.thread?.messages.length && (
                  <article className="conversation-message assistant">
                    <strong>AI-ПОМОЩНИК</strong>
                    <AssistantMessage content={greeting} />
                  </article>
                )}
                {board.thread?.messages.map((message) => (
                  <article
                    key={message.id}
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
                      <small>Ответ прерван</small>
                    )}
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
                <Button disabled={busy} onClick={props.onBegin}>
                  Начать диалог
                </Button>
              ) : (
                <form onSubmit={props.onChat}>
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
              <p>
                Начните с вопроса. Помощник уточнит только нужное по ходу
                разговора.
              </p>
              <small>
                Ответы AI — ориентир, не проверенная сделка и не бронирование.
              </small>
            </Card>
          </aside>
        </div>
      )}
    </section>
  );
}
