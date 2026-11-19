"use client";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { Button, Card, Field } from "@citygo/ui-web";
import { PlanStepComposer } from "./personal-plan";
import { housingFirstPaymentDetails } from "./housing-first-payment";
import styles from "./housing-starter-plan.module.css";

const situations = [
  { value: "searching", label: "Работу пока ищу" },
  { value: "oriented", label: "Есть ориентир по работе" },
  { value: "direct", label: "Сразу покажите стартовый план" },
] as const;
type Situation = (typeof situations)[number]["value"];
type Stage = "question" | "criteria" | "preview" | "save";

const title = "Стартовый план поиска жилья";

export function housingPlanContent(input: {
  situation: Situation;
  commute: string;
  budgetRub: number | null;
}) {
  const { situation, commute, budgetRub } = input;
  const budget =
    budgetRub === null
      ? ""
      : new Intl.NumberFormat("ru-RU").format(budgetRub) + " ₽/мес.";
  const comparison = commute
    ? `Сравните дорогу до ориентира «${commute}» в нужное вам время, тип жилья и условия проживания.`
    : situation === "searching"
      ? "Пока работа в поиске, сравните несколько транспортных направлений, тип жилья и условия проживания."
      : "Сравните несколько транспортных направлений, тип жилья и условия проживания. Уточните регулярный маршрут, когда появится ориентир.";
  return {
    summary: [
      budget ? "Бюджет " + budget : "Бюджет пока открыт",
      commute ? "Ориентир «" + commute + "»" : "Район пока открыт",
    ].join(" · "),
    steps: [
      { title: "Сравнивать по одинаковым критериям", details: comparison },
      {
        title: "Проверять предложения",
        details:
          "Когда появится дата заселения, сопоставьте на неё несколько объявлений. Перед просмотром уточните у арендодателя актуальность и полную сумму платежей.",
      },
      {
        title: "Готовиться к разговору",
        details:
          "Спросите, что входит в ежемесячный платёж, на каких условиях возвращают залог и кто подписывает договор. Подготовьте вопросы для просмотра.",
      },
    ],
  };
}

export function HousingPlanSteps({
  summary,
  steps,
}: ReturnType<typeof housingPlanContent>) {
  return (
    <>
      <p className={styles.summary}>{summary}</p>
      <aside className={styles.orientation}>
        <p className={styles.eyebrow}>Первый ориентир</p>
        <h2>Полный расход — не только аренда</h2>
        <p>{housingFirstPaymentDetails}</p>
      </aside>
      <ol className={styles.steps} aria-label="Шаги поиска">
        {steps.map((step, index) => (
          <li key={step.title}>
            <h2>
              {index + 1} · {step.title}
            </h2>
            <p>{step.details}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

export function HousingPlanLaunch({
  disabled,
  launchRef,
  onStart,
}: {
  disabled: boolean;
  launchRef: Ref<HTMLElement>;
  onStart: () => void;
}) {
  return (
    <aside
      ref={launchRef}
      className={styles.launch}
      aria-label="План поиска жилья"
    >
      <p>Можно начать поиск, даже если район и бюджет пока неизвестны.</p>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={onStart}
      >
        Составить план поиска жилья
      </Button>
    </aside>
  );
}

export function HousingStarterPlan({
  userId,
  sessionSignal,
  onAccessDenied,
  onExit,
  onOpenSavedPlan,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onExit: () => void;
  onOpenSavedPlan: () => void;
}) {
  const [stage, setStage] = useState<Stage>("question");
  const [situation, setSituation] = useState<Situation>("direct");
  const [commuteDraft, setCommuteDraft] = useState("");
  const [budgetDraft, setBudgetDraft] = useState("");
  const [criteria, setCriteria] = useState({ commute: "", budget: "" });
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    heading.current?.focus();
  }, [stage]);

  const plan = housingPlanContent({
    situation,
    commute: criteria.commute,
    budgetRub: criteria.budget ? Number(criteria.budget) : null,
  });
  const initialFields = {
    title,
    details: [
      plan.summary,
      "Полный расход — не только аренда. " + housingFirstPaymentDetails,
      ...plan.steps.map(
        (step, i) => i + 1 + ". " + step.title + "\n" + step.details,
      ),
    ].join("\n\n"),
  };
  const choose = (selection: Situation) => {
    setSituation(selection);
    setStage(selection === "oriented" ? "criteria" : "preview");
  };

  if (stage === "save") {
    return (
      <PlanStepComposer
        userId={userId}
        sessionSignal={sessionSignal}
        onAccessDenied={onAccessDenied}
        source={null}
        initialFields={initialFields}
        onSaved={onOpenSavedPlan}
        onCancel={(checkPlan) => {
          if (checkPlan) onOpenSavedPlan();
          else setStage("preview");
        }}
      />
    );
  }

  return (
    <Card
      className={styles.panel + " ym-hide-content"}
      aria-labelledby={headingId}
    >
      <div className={styles.header}>
        <Button type="button" variant="ghost" onClick={onExit}>
          К диалогу
        </Button>
        <p className={styles.eyebrow}>Помощник по жилью</p>
        <h1 id={headingId} ref={heading} tabIndex={-1}>
          {stage === "question"
            ? "Есть ли место, куда нужно будет регулярно ездить, или пока его нет?"
            : stage === "criteria"
              ? "Уточните ориентиры"
              : "Ваш стартовый план поиска"}
        </h1>
      </div>
      {stage === "question" && (
        <div className={styles.stack}>
          {situations.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              variant="secondary"
              onClick={() => choose(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {stage === "criteria" && (
        <form
          className={styles.stack}
          onSubmit={(event) => {
            event.preventDefault();
            setCriteria({ commute: commuteDraft.trim(), budget: budgetDraft });
            setStage("preview");
          }}
        >
          <Field
            label="Ориентир для регулярных поездок"
            hint="Например, район или станция метро. Можно оставить пустым."
            className="ym-disable-keys"
            value={commuteDraft}
            maxLength={100}
            onChange={(event) => setCommuteDraft(event.target.value)}
          />
          <Field
            label="Бюджет на жильё в месяц, ₽"
            hint="Можно указать позже."
            className="ym-disable-keys"
            value={budgetDraft}
            type="number"
            inputMode="numeric"
            min={1}
            max={99999999}
            step={1}
            onChange={(event) => setBudgetDraft(event.target.value)}
          />
          <Button type="submit">Открыть план поиска</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setStage("question")}
          >
            Назад
          </Button>
        </form>
      )}
      {stage === "preview" && (
        <>
          <p className={styles.intro}>
            План действий для поиска жилья. Актуальность объявлений проверяйте у
            арендодателя.
          </p>
          <HousingPlanSteps {...plan} />
          <div className={styles.stack}>
            <Button type="button" onClick={() => setStage("save")}>
              Сохранить ориентир
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStage("criteria")}
            >
              Уточнить ориентиры
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
