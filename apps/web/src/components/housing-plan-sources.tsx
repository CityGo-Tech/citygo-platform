"use client";

import {
  publicWebUrl,
  type KnowledgeLookupResult,
  type KnowledgeMatch,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { useEffect, useId, useRef } from "react";
import planStyles from "./housing-starter-plan.module.css";
import styles from "./housing-plan-sources.module.css";

export type HousingPlanKnowledgeState =
  KnowledgeLookupResult | { status: "loading" } | { status: "unavailable" };

const dateLabel = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "long",
  timeZone: "UTC",
});

const guidance = {
  miss: {
    title: "Подтверждённого источника пока нет",
    detail:
      "Сравните полный первый платёж по нескольким предложениям и уточните его у арендодателя.",
  },
  stale: {
    title: "Срок проверки источника истёк",
    detail: "Перепроверьте состав первого платежа перед просмотром жилья.",
  },
  conflict: {
    title: "Источники противоречат друг другу",
    detail:
      "Уточните спорные условия в актуальном объявлении или у арендодателя.",
  },
  superseded: {
    title: "У источника появилась новая версия",
    detail: "Уточните, какие платежи действуют для выбранного жилья.",
  },
  withdrawn: {
    title: "Источник отозван",
    detail:
      "Уточните состав первого платежа в актуальном объявлении или у арендодателя.",
  },
  unreliable: {
    title: "Источник требует дополнительной проверки",
    detail: "Уточните у арендодателя состав платежа и условия договора.",
  },
  unavailable: {
    title: "Не удалось проверить источник",
    detail:
      "Используйте план поиска и уточните состав первого платежа у арендодателя.",
  },
} as const;

function guidanceFor(
  state: Exclude<HousingPlanKnowledgeState, { status: "loading" }>,
) {
  if (state.status === "stale" && state.reason === "superseded_source")
    return guidance.superseded;
  if (state.status === "miss" && state.reason === "withdrawn")
    return guidance.withdrawn;
  if (
    state.status === "conflict" &&
    state.reason !== "ambiguous_claims" &&
    state.reason !== "version_conflict"
  )
    return guidance.unreliable;
  return guidance[state.status === "hit" ? "unavailable" : state.status];
}

function linkedFact(match: KnowledgeMatch) {
  const evidence = [];
  for (const source of match.evidence) {
    const href = publicWebUrl(source.url);
    if (!href) return null;
    evidence.push({ ...source, href });
  }
  return { ...match, evidence };
}

export function HousingPlanFact({
  state,
}: {
  state: HousingPlanKnowledgeState;
}) {
  if (state.status === "loading")
    return <p role="status">Проверяем сведения в базе знаний…</p>;

  const matches = state.status === "hit" ? state.matches.map(linkedFact) : null;
  if (matches?.every((match) => match !== null)) {
    return (
      <div className={styles.details + " ym-hide-content"}>
        <strong>Проверенный внешний факт</strong>
        {matches.map(({ fact, statement, evidence }) => (
          <div key={fact.id + ":" + fact.revision} className={styles.details}>
            <p>{statement}</p>
            <ul className={styles.evidence}>
              {evidence.map(
                ({ source, publisher, title, href, reviewedAt }) => (
                  <li key={source.id + ":" + source.revision}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                    >
                      {publisher} · {title}
                    </a>
                    <span className={styles.date}>
                      Дата проверки{" "}
                      <time dateTime={reviewedAt}>
                        {dateLabel.format(new Date(reviewedAt))}
                      </time>
                    </span>
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  const message = guidanceFor(state);
  return (
    <div className={styles.details} role="status">
      <strong>{message.title}</strong>
      <p>{message.detail}</p>
    </div>
  );
}

type HousingPlanSourcesProps = {
  state: HousingPlanKnowledgeState;
  context: { commute: string; budget: string; situation?: string };
  assessment: string;
  onBack: () => void;
  onCorrect: () => void;
};

export function HousingPlanSources({
  state,
  context,
  assessment,
  onBack,
  onCorrect,
}: HousingPlanSourcesProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const { commute, budget, situation } = context;
  const work =
    situation === "searching"
      ? "Работу пока ищу"
      : situation === "oriented"
        ? "Есть ориентир по работе"
        : situation === "direct"
          ? ""
          : (situation ?? "").trim();

  return (
    <Card
      className={planStyles.panel + " ym-hide-content"}
      aria-labelledby={headingId}
    >
      <div className={planStyles.header}>
        <h1 id={headingId} ref={heading} tabIndex={-1}>
          На что опирается рекомендация
        </h1>
      </div>
      <div className={planStyles.stack + " " + styles.rows}>
        <section className={planStyles.orientation}>
          <h2>Ваш контекст</h2>
          {commute.trim() || budget.trim() || work ? (
            <dl className={styles.context}>
              {work && (
                <div>
                  <dt>Работа</dt>
                  <dd>{work}</dd>
                </div>
              )}
              {commute.trim() && (
                <div>
                  <dt>Ориентир для поездок</dt>
                  <dd>{commute}</dd>
                </div>
              )}
              {budget.trim() && (
                <div>
                  <dt>Бюджет</dt>
                  <dd>{budget}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p>Ориентир для поездок и бюджет пока не указаны.</p>
          )}
        </section>
        <section className={planStyles.orientation}>
          <h2>Оценка помощника</h2>
          <p>{assessment}</p>
        </section>
        <section className={planStyles.orientation}>
          <h2>Внешние источники</h2>
          <HousingPlanFact state={state} />
          <p className={planStyles.intro}>
            Цены аренды и доступность жилья проверяйте по актуальному объявлению
            и у арендодателя.
          </p>
        </section>
      </div>
      <div className={styles.actions}>
        <Button type="button" onClick={onBack}>
          Вернуться к плану
        </Button>
        <Button type="button" variant="secondary" onClick={onCorrect}>
          Исправить контекст
        </Button>
      </div>
    </Card>
  );
}
