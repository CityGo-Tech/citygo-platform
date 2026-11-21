"use client";

import { useEffect, useId, useRef } from "react";
import type { HousingWorkspaceCriteria } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { selectHousingShortlist } from "./housing-shortlist-data";
import {
  housingShortlistDemoTime,
  housingShortlistOfferPool,
  housingShortlistPrice,
  housingShortlistSource,
  housingShortlistTime,
} from "./housing-shortlist-fixture";
import styles from "./housing-starter-plan.module.css";

export function HousingShortlist({
  criteria,
  revision,
  blocked,
  loadFailed,
  outdated,
  onBack,
  onOpenChecklist,
}: {
  criteria: HousingWorkspaceCriteria;
  revision: number;
  blocked: boolean;
  loadFailed: boolean;
  outdated: boolean;
  onBack: () => void;
  onOpenChecklist: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => heading.current?.focus(), []);

  const offers = selectHousingShortlist(housingShortlistOfferPool, criteria);
  return (
    <Card
      className={styles.panel + " ym-hide-content"}
      aria-labelledby={headingId}
    >
      <div className={styles.header}>
        <p className={styles.eyebrow}>Помощник по жилью</p>
        <h1 id={headingId} ref={heading} tabIndex={-1}>
          Короткий список жилья
        </h1>
        <p className={styles.intro}>
          Учебные объявления. Даты в примере имитируют наблюдение у источника.
          Доступность жилья из них не следует.
        </p>
      </div>
      {outdated ? (
        <p role="status">
          План изменился. Вернитесь к плану и откройте список заново.
        </p>
      ) : loadFailed ? (
        <p role="status">
          Не удалось проверить версию. Вернитесь к плану и попробуйте снова.
        </p>
      ) : blocked ? (
        <p role="status">Проверяем сохранённую версию плана…</p>
      ) : (
        <>
          <div className={styles.summary}>
            <p>Стартовый план · версия {revision}</p>
            {criteria.commute && (
              <p>Маршрут до вашего ориентира нужно проверить отдельно.</p>
            )}
            <p>
              Время примера ·{" "}
              <time dateTime={housingShortlistDemoTime}>
                {housingShortlistTime(housingShortlistDemoTime)}
              </time>
            </p>
          </div>
          {!offers.length ? (
            <p role="status">
              {criteria.city
                ? "В выгрузке нет вариантов по этим условиям."
                : "Укажите город в сохранённом плане, чтобы подобрать варианты."}
            </p>
          ) : (
            <ul className={styles.steps} aria-label="Варианты жилья">
              {offers.map(({ offer, matches }) => (
                <li key={offer.originalId}>
                  <h2>{offer.title}</h2>
                  <p>
                    {offer.city}, {offer.district} ·{" "}
                    {housingShortlistPrice(offer.rentRub)}
                  </p>
                  <p>Источник · {housingShortlistSource}</p>
                  <p>
                    Последний раз видели ·{" "}
                    <time dateTime={offer.lastSeenAt}>
                      {housingShortlistTime(offer.lastSeenAt)}
                    </time>
                  </p>
                  <p>
                    Совпало ·{" "}
                    {matches
                      .map((match) =>
                        match === "city" ? "Город" : "В пределах бюджета",
                      )
                      .join(" · ")}
                  </p>
                  <a
                    href={`/housing-catalog-demo/${offer.originalId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cg-button cg-button-secondary"
                  >
                    Открыть оригинал
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Button type="button" onClick={onOpenChecklist}>
            Перейти к чек-листу
          </Button>
        </>
      )}
      <Button type="button" variant="secondary" onClick={onBack}>
        Вернуться к плану
      </Button>
    </Card>
  );
}
