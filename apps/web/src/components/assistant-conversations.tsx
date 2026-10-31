"use client";
import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import type {
  AgentKey,
  ConversationSummary,
  ConversationFilters,
} from "@citygo/contracts";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";

export const assistantCatalog: {
  key: AgentKey;
  name: string;
  title: string;
  description: string;
}[] = [
  {
    key: "support",
    name: "Support Assistant",
    title: "Координатор переезда",
    description: "От идеи до освоения в городе. Поможет выбрать следующий шаг.",
  },
  {
    key: "housing",
    name: "Housing Navigator",
    title: "Помощник по жилью",
    description: "Приоритеты поиска, районы и подготовка к просмотрам.",
  },
  {
    key: "job-search",
    name: "Job Search Mentor",
    title: "Помощник по работе",
    description: "Стратегия поиска, требования вакансий и подготовка.",
  },
  {
    key: "resume-builder",
    name: "Resume Builder Expert",
    title: "Помощник по резюме",
    description: "Покажет сильные стороны опыта и поможет с черновиком.",
  },
  {
    key: "digital-mentor",
    name: "Digital Mentor",
    title: "Гид по городской жизни",
    description: "Транспорт, цифровые сервисы и первые шаги в Москве.",
  },
];

export function assistantTitle(key: AgentKey) {
  return assistantCatalog.find((item) => item.key === key)!.title;
}

function BubbleCard() {
  return (
    <article
      className="assistant-directory-card assistant-partner"
      aria-label="Bubble"
    >
      <Image
        src="/figma/bubble-mark.png"
        width={64}
        height={64}
        alt="Логотип Bubble"
      />
      <div>
        <h2>Bubble</h2>
        <p className="assistant-specialty">
          Досуг под настроение · Партнёр CityGo
        </p>
        <p>Скоро поможет выбрать, куда сходить в Москве.</p>
        <Button className="assistant-open" variant="secondary" disabled>
          Bubble · скоро
        </Button>
      </div>
    </article>
  );
}

/** Figma 6:27 / 8:327. Artwork and tokens reuse the existing CityGo library. */
export function AssistantCatalog({
  busy,
  onBegin,
}: {
  busy: boolean;
  onBegin: (agent: AgentKey) => Promise<boolean>;
}) {
  return (
    <Card className="assistant-directory" aria-label="Каталог помощников">
      <span className="eyebrow">CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1>Ваша команда AI-помощников</h1>
      <p>Выберите помощника для вашей задачи.</p>
      {assistantCatalog.map((item) => (
        <article
          className="assistant-directory-card"
          aria-label={item.title}
          key={item.key}
        >
          <Image
            className="assistant-catalog-portrait"
            src={`/characters/${item.key}-192.webp`}
            width={88}
            height={88}
            alt=""
          />
          <div>
            <h2>{item.name}</h2>
            <p className="assistant-specialty">{item.title}</p>
            <p>{item.description}</p>
            <Button
              className="assistant-open"
              variant="secondary"
              disabled={busy}
              onClick={() => void onBegin(item.key)}
            >
              Начать разговор
            </Button>
          </div>
        </article>
      ))}
      <BubbleCard />
      <small>Выберите помощника и задайте вопрос.</small>
    </Card>
  );
}

/** Only real server-owned conversations; never use the prototype's demo history. */
export function ConversationList({
  conversations,
  nextCursor,
  busy,
  onOpen,
  onLoad,
  filters,
  onHelpers,
  onFavorites,
}: {
  conversations: ConversationSummary[] | null;
  nextCursor: string | null;
  busy: boolean;
  onOpen: (id: string) => Promise<boolean>;
  filters: ConversationFilters;
  onLoad: (before?: string, filters?: ConversationFilters) => void;
  onHelpers: () => void;
  onFavorites?: () => void;
}) {
  const [search, setSearch] = useState(filters.search ?? "");
  const [assistant, setAssistant] = useState(filters.assistantKey ?? "");
  const [status, setStatus] = useState(filters.status ?? "");
  useEffect(() => {
    setSearch(filters.search ?? "");
    setAssistant(filters.assistantKey ?? "");
    setStatus(filters.status ?? "");
  }, [filters.search, filters.assistantKey, filters.status]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    onLoad(undefined, {
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(assistant ? { assistantKey: assistant as AgentKey } : {}),
      ...(status ? { status: status as "active" | "closed" } : {}),
    });
  };
  return (
    <Card className="assistant-directory" aria-label="Ваши разговоры">
      <span className="eyebrow">CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1>Ваши разговоры</h1>
      <p>Здесь ваши разговоры с помощниками.</p>
      <form
        className="conversation-directory-filters ym-hide-content"
        onSubmit={apply}
      >
        <Field
          label="Найти в переписке"
          className="ym-disable-keys"
          type="search"
          maxLength={160}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={busy}
        />
        <SelectField
          label="Помощник"
          value={assistant}
          disabled={busy}
          onChange={(event) =>
            setAssistant(event.target.value as AgentKey | "")
          }
        >
          <option value="">Все помощники</option>
          {assistantCatalog.map((item) => (
            <option key={item.key} value={item.key}>
              {item.title}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Статус"
          value={status}
          disabled={busy}
          onChange={(event) =>
            setStatus(event.target.value as "active" | "closed" | "")
          }
        >
          <option value="">Все разговоры</option>
          <option value="active">Можно продолжить</option>
          <option value="closed">История</option>
        </SelectField>
        <div className="conversation-directory-actions">
          <Button type="submit" disabled={busy}>
            Найти
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setSearch("");
              setAssistant("");
              setStatus("");
              onLoad(undefined, {});
            }}
          >
            Сбросить
          </Button>
        </div>
      </form>
      {conversations === null ? (
        <p role="status">Загружаем разговоры…</p>
      ) : conversations.length === 0 ? (
        <p>
          {Object.keys(filters).length
            ? "По этим условиям разговоров пока нет."
            : "Выберите помощника, чтобы начать разговор."}
        </p>
      ) : (
        conversations.map((item) => {
          const title = item.assistantKey
            ? assistantTitle(item.assistantKey)
            : "Общий диалог";
          return (
            <article
              className="conversation-directory-card"
              aria-label={item.assistantKey ? `Диалог: ${title}` : title}
              key={item.id}
            >
              <span className="eyebrow">
                {item.closed ? "ИСТОРИЯ" : "ПРОДОЛЖИТЬ"}
              </span>
              <h2>
                {item.assistantKey
                  ? assistantCatalog.find(
                      (agent) => agent.key === item.assistantKey,
                    )!.name
                  : title}
              </h2>
              <p>
                {item.preview ||
                  "Можно начать с первого вопроса — даже если срок и бюджет ещё неизвестны."}
              </p>
              <Button
                className="assistant-open"
                variant="secondary"
                disabled={busy}
                onClick={() => void onOpen(item.id)}
              >
                Открыть разговор
              </Button>
            </article>
          );
        })
      )}
      {nextCursor && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onLoad(nextCursor, filters)}
        >
          Загрузить ещё разговоры
        </Button>
      )}
      <BubbleCard />
      <div className="conversation-directory-actions">
        <Button disabled={busy} onClick={onHelpers}>
          Все помощники
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onFavorites}>
          Найти сохранённое сообщение
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => onLoad(undefined, filters)}
        >
          Обновить разговоры
        </Button>
      </div>
    </Card>
  );
}
