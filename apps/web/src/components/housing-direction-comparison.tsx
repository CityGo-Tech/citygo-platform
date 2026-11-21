"use client";

import { useEffect, useId, useRef } from "react";
import type { HousingWorkspaceCriteria } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import styles from "./housing-starter-plan.module.css";

type DirectionChange = "route" | "payment";

const directions = [
  {
    title: "Ближе к месту работы",
    details:
      "Если есть ориентир, проверьте маршрут в нужное время и сравните полный расход на жильё.",
  },
  {
    title: "Вдоль удобной линии транспорта",
    details:
      "Сопоставьте несколько районов, число пересадок и последний участок пути до нужного места.",
  },
  {
    title: "Временный старт",
    details:
      "Сравните стоимость короткого проживания отдельно от постоянной аренды. Учтите первый платёж и возможные расходы на переезд между ними.",
  },
] as const;

const budgetFormat = new Intl.NumberFormat("ru-RU");

export function HousingDirectionComparison({
  plan,
  changes,
  stale: staleRevision = false,
  blocked,
  onBack,
  onReview,
  onOpenChecklist,
  onTransport,
}: {
  plan: { revision: number; criteria: HousingWorkspaceCriteria };
  changes: readonly DirectionChange[];
  stale?: boolean;
  blocked: boolean;
  onBack: () => void;
  onReview: () => void;
  onOpenChecklist: () => void;
  onTransport?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const { city, commute, budgetRub } = plan.criteria;
  const routeChanged = changes.includes("route");
  const paymentChanged = changes.includes("payment");
  const stale = staleRevision || routeChanged || paymentChanged;

  return (
    <Card
      className={styles.panel + " ym-hide-content"}
      aria-labelledby={headingId}
    >
      <div className={styles.header}>
        <p className={styles.eyebrow}>Помощник по жилью</p>
        <h1 id={headingId} ref={heading} tabIndex={-1}>
          Сравним направления, а не обещания
        </h1>
        <p className={styles.intro}>
          Проверьте реальные маршруты и актуальные предложения перед выбором.
        </p>
      </div>

      <div className={styles.summary}>
        <p>Стартовый план · версия {plan.revision}</p>
        {city && <p>Город поиска: {city}</p>}
        <p>
          {commute
            ? "Ориентир для поездок: " + commute
            : "Маршрут пока неизвестен"}
        </p>
        <p>
          {budgetRub === null
            ? "Бюджет пока неизвестен"
            : "Бюджет: " + budgetFormat.format(budgetRub) + " ₽/мес."}
        </p>
      </div>

      {stale && (
        <aside className={styles.orientation} role="status">
          {!routeChanged && !paymentChanged && (
            <p>Доступна новая версия плана.</p>
          )}
          {routeChanged && (
            <p>Изменились условия поездок. Пересмотрите маршруты.</p>
          )}
          {paymentChanged && <p>Изменился бюджет. Пересмотрите расходы.</p>}
          <Button
            type="button"
            variant="secondary"
            disabled={blocked}
            onClick={onReview}
          >
            Посмотреть изменения
          </Button>
        </aside>
      )}

      <ul className={styles.steps} aria-label="Направления поиска жилья">
        {directions.map(({ title, details }) => (
          <li key={title}>
            <h2>{title}</h2>
            <p>{details}</p>
          </li>
        ))}
      </ul>

      <div className={styles.stack}>
        <Button
          type="button"
          disabled={blocked || stale}
          onClick={onOpenChecklist}
        >
          Перейти к чек-листу
        </Button>
        <Button type="button" variant="secondary" onClick={onBack}>
          Вернуться к плану
        </Button>
        {onTransport && (
          <Button
            type="button"
            variant="secondary"
            disabled={blocked}
            onClick={onTransport}
          >
            Попросить помощь по транспорту
          </Button>
        )}
      </div>
    </Card>
  );
}
