"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type { HousingWorkspace } from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import { housingFirstPaymentDetails } from "./housing-first-payment";
import { housingPlanContent, HousingPlanSteps } from "./housing-starter-plan";
import { HousingDirectionComparison } from "./housing-direction-comparison";
import { HousingShortlist } from "./housing-shortlist";
import { isHousingShortlistLoopback } from "./housing-shortlist-data";
import styles from "./housing-starter-plan.module.css";

type Plan = NonNullable<HousingWorkspace["plan"]>;
type Criteria = Plan["criteria"];
type Checklist = NonNullable<HousingWorkspace["checklist"]>;
type ChecklistDraft = Pick<
  Checklist,
  "planRevision" | "selected" | "paymentChecked"
> & {
  expectedRevision: number;
};
type PlanDraft = {
  expectedRevision: number;
  threadId: string;
  criteria: Omit<Criteria, "budgetRub"> & { budget: string };
};
type ChecklistReview = { expectedRevision: number; planRevision: number };
type CityGoClient = ReturnType<typeof createClient>;
type Mutation =
  | { kind: "plan"; input: Parameters<CityGoClient["saveHousingPlan"]>[0] }
  | {
      kind: "checklist";
      input: Parameters<CityGoClient["saveHousingChecklist"]>[0];
    }
  | {
      kind: "confirmation";
      input: Parameters<CityGoClient["confirmHousingChecklist"]>[0];
    };

const viewingItems = [
  { id: "payment", title: "Платежи", details: housingFirstPaymentDetails },
  {
    id: "contract",
    title: "Договор и документы",
    details:
      "Уточните, кто сдаёт жильё, какие документы это подтверждают и что указано в договоре.",
  },
  {
    id: "inspection",
    title: "Состояние квартиры",
    details:
      "Проверьте воду, отопление, технику, связь и зафиксируйте состояние жилья.",
  },
] as const satisfies ReadonlyArray<{
  id: Checklist["selected"][number];
  title: string;
  details: string;
}>;

function editorCriteria(criteria: Criteria): PlanDraft["criteria"] {
  const { budgetRub, ...known } = criteria;
  return { ...known, budget: budgetRub === null ? "" : String(budgetRub) };
}

function savedDraft(
  checklist: Checklist | null,
  planRevision: number,
): ChecklistDraft {
  return {
    expectedRevision: checklist?.revision ?? 0,
    planRevision,
    selected: checklist?.selected ?? [],
    paymentChecked:
      checklist?.paymentChecked === true &&
      (checklist.planRevision === planRevision ||
        !checklist.paymentNeedsReview),
  };
}

function revisionOf(value: HousingWorkspace, mutation: Mutation) {
  return (
    (mutation.kind === "plan" ? value.plan : value.checklist)?.revision ?? 0
  );
}

function confirms(value: HousingWorkspace, mutation: Mutation) {
  if (mutation.kind === "confirmation") {
    const result = value.checklist;
    return (
      !!result &&
      !result.paymentNeedsReview &&
      ((result.confirmedFromRevision === mutation.input.expectedRevision &&
        result.revision === mutation.input.expectedRevision + 1 &&
        result.requestId === mutation.input.requestId) ||
        (result.confirmedFromRevision !== undefined &&
          result.revision === mutation.input.expectedRevision))
    );
  }
  const result = value[mutation.kind];
  return (
    result?.requestId === mutation.input.requestId &&
    result.revision === mutation.input.expectedRevision + 1
  );
}

function checklistPlanChanged(value: HousingWorkspace, mutation: Mutation) {
  return (
    mutation.kind !== "plan" &&
    mutation.input.planRevision !== value.plan?.revision
  );
}

function comparisonChanges(shown: Criteria, current: Criteria) {
  const changed: Array<"route" | "payment"> = [];
  if (
    shown.city !== current.city ||
    shown.commute !== current.commute ||
    shown.situation !== current.situation
  )
    changed.push("route");
  if (shown.budgetRub !== current.budgetRub) changed.push("payment");
  return changed;
}

type Controller = {
  load: (quiet?: boolean) => Promise<void>;
  save: (mutation: Mutation) => Promise<void>;
};

export function HousingWorkspaceView({
  userId,
  threadId,
  sessionSignal,
  onAccessDenied,
  onExit,
  onOpenSource,
  onChooseAssistant,
  initialView = "plan",
  allowLocalShortlist = false,
  initialCriteria,
  defaultCity,
}: {
  userId: string;
  threadId?: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onExit: () => void;
  onOpenSource?: (threadId: string) => void;
  onChooseAssistant?: () => void;
  initialView?: "plan" | "checklist";
  allowLocalShortlist?: boolean;
  initialCriteria?: { commute: string; budgetRub: number | null };
  defaultCity?: string;
}) {
  const [view, setView] = useState<
    "plan" | "checklist" | "comparison" | "shortlist"
  >(initialView);
  const [shortlist, setShortlist] = useState<Plan | null>(null);
  const [localShortlist, setLocalShortlist] = useState(false);
  useEffect(() => {
    setLocalShortlist(
      allowLocalShortlist &&
        isHousingShortlistLoopback(window.location.host) &&
        new URLSearchParams(window.location.search).get(
          "housingCatalogDemo",
        ) === "1",
    );
  }, [allowLocalShortlist]);
  const [comparison, setComparison] = useState<Plan | null>(null);
  const [review, setReview] = useState<ChecklistReview | null>(null);
  const [snapshot, setSnapshot] = useState<HousingWorkspace | null>(null);
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [checklistDraft, setChecklistDraft] = useState<ChecklistDraft | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState<Mutation | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const control = useRef<Controller | null>(null);
  const accessDenied = useRef(onAccessDenied);
  accessDenied.current = onAccessDenied;
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (review) confirmationHeading.current?.focus();
  }, [review]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    let running = false;
    let pending: Mutation | null = null;
    let lastSnapshot: HousingWorkspace | null = null;

    function accept(value: HousingWorkspace): boolean {
      if (signal.aborted) return false;
      if (value.userId !== userId) {
        controller.abort();
        accessDenied.current();
        return false;
      }
      setSnapshot(value);
      lastSnapshot = value;
      return true;
    }
    function complete(mutation: Mutation) {
      pending = null;
      setUncertain(null);
      setCanRetry(false);
      setError("");
      if (mutation.kind === "plan") {
        setPlanDraft(null);
        setPreview(false);
        setNotice("Стартовый план сохранён.");
      } else {
        setChecklistDraft(null);
        setReview(null);
        if (mutation.kind === "checklist") setNotice("Чек-лист сохранён.");
      }
    }
    function recover(value: HousingWorkspace) {
      if (!pending) return;
      if (confirms(value, pending)) {
        complete(pending);
      } else if (
        revisionOf(value, pending) !== pending.input.expectedRevision ||
        checklistPlanChanged(value, pending)
      ) {
        pending = null;
        setUncertain(null);
        setCanRetry(false);
        setError(
          "Появилась более свежая версия. Проверьте сохранённые данные.",
        );
      } else {
        setCanRetry(true);
        setError(
          "Сервер пока не подтвердил сохранение. Можно повторить ту же команду.",
        );
      }
    }
    function denied(cause: unknown) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        controller.abort();
        accessDenied.current();
        return true;
      }
      return false;
    }

    async function load(quiet = false) {
      if (signal.aborted || running) return;
      running = true;
      setBusy(true);
      try {
        const previous = lastSnapshot;
        const value = await api.housingWorkspace();
        if (!accept(value)) return;
        if (pending) recover(value);
        else {
          if (!quiet) setError("");
          if (
            previous &&
            ((value.plan?.revision ?? 0) > (previous.plan?.revision ?? 0) ||
              (value.checklist?.revision ?? 0) >
                (previous.checklist?.revision ?? 0))
          ) {
            setNotice("В другой вкладке появилась более свежая версия.");
          }
        }
      } catch (cause) {
        if (signal.aborted || denied(cause)) return;
        if (!quiet)
          setError(
            "Не удалось загрузить сохранённые данные. Попробуйте ещё раз.",
          );
      } finally {
        running = false;
        if (!signal.aborted) setBusy(false);
      }
    }

    async function save(mutation: Mutation) {
      if (signal.aborted || running || (pending && pending !== mutation))
        return;
      running = true;
      setBusy(true);
      setError("");
      setNotice("");
      setCanRetry(false);
      try {
        const value =
          mutation.kind === "plan"
            ? await api.saveHousingPlan(mutation.input)
            : mutation.kind === "checklist"
              ? await api.saveHousingChecklist(mutation.input)
              : await api.confirmHousingChecklist(mutation.input);
        if (!accept(value)) return;
        if (!confirms(value, mutation)) {
          pending = mutation;
          setUncertain(mutation);
          recover(value);
        } else {
          complete(mutation);
        }
      } catch (cause) {
        if (signal.aborted || denied(cause)) return;
        if (
          cause instanceof ApiError &&
          [400, 404, 413, 422].includes(cause.status)
        ) {
          pending = null;
          setUncertain(null);
          setError(
            cause.status === 404
              ? "Исходная задача недоступна. Откройте диалог с помощником по жилью."
              : "Проверьте введённые данные перед сохранением.",
          );
          return;
        }
        pending = mutation;
        setUncertain(mutation);
        setError(
          cause instanceof ApiError && cause.status === 409
            ? "Результат изменился. Проверьте сохранённую версию."
            : "Не удалось подтвердить сохранение. Проверьте, что сохранилось.",
        );
      } finally {
        running = false;
        if (!signal.aborted) setBusy(false);
      }
    }

    control.current = { load, save };
    void load();
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      control.current = null;
    };
  }, [userId, sessionSignal]);

  const current =
    snapshot?.userId === userId && !sessionSignal.aborted ? snapshot : null;
  const plan = current?.plan ?? null;
  const checklist = current?.checklist ?? null;
  const source = plan?.threadId ?? threadId;
  const openingCriteria: Criteria = {
    city: defaultCity?.trim() ?? "",
    situation: initialCriteria?.commute ? "oriented" : "direct",
    commute: initialCriteria?.commute ?? "",
    budgetRub: initialCriteria?.budgetRub ?? null,
  };
  const planForm =
    planDraft ??
    (source
      ? {
          expectedRevision: plan?.revision ?? 0,
          threadId: source,
          criteria: editorCriteria(plan?.criteria ?? openingCriteria),
        }
      : null);
  const criteria = planForm?.criteria;
  const planOutdated =
    !!planDraft && planDraft.expectedRevision !== (plan?.revision ?? 0);
  const checklistStale =
    !!checklist && checklist.planRevision !== plan?.revision;
  const paymentNeedsReview = checklist?.paymentNeedsReview === true;
  const preparationConfirmed =
    checklist?.confirmedFromRevision !== undefined && !paymentNeedsReview;
  const reviewOutdated =
    !!review &&
    (review.expectedRevision !== checklist?.revision ||
      review.planRevision !== plan?.revision ||
      paymentNeedsReview);
  const checklistOutdated =
    !!checklistDraft &&
    (checklistDraft.expectedRevision !== (checklist?.revision ?? 0) ||
      checklistDraft.planRevision !== plan?.revision);
  const checklistForm =
    checklistDraft ??
    (plan
      ? savedDraft(
          checklist,
          checklist?.paymentNeedsReview
            ? checklist.planRevision
            : plan.revision,
        )
      : null);
  const editingPlan = !preview && (!!planDraft || !plan);
  const headingTitle =
    view === "checklist"
      ? "Чек-лист просмотра"
      : editingPlan
        ? plan
          ? "Уточните условия"
          : "Поиск жилья"
        : "Ваш стартовый план поиска";
  const blocked = !current || busy || !!uncertain;
  useEffect(() => {
    heading.current?.focus();
  }, [headingTitle, view]);

  if (sessionSignal.aborted) return null;

  if (view === "shortlist" && localShortlist && shortlist && current) {
    const outdated = plan?.revision !== shortlist.revision;
    return (
      <HousingShortlist
        criteria={shortlist.criteria}
        revision={shortlist.revision}
        blocked={blocked}
        loadFailed={!!error}
        outdated={outdated}
        onBack={() => {
          setShortlist(null);
          setView("plan");
        }}
        onOpenChecklist={() => {
          if (!outdated && !blocked && !error) {
            setShortlist(null);
            setView("checklist");
          }
        }}
      />
    );
  }

  if (view === "comparison" && comparison && plan) {
    const stale = comparison.revision !== plan.revision;
    return (
      <HousingDirectionComparison
        plan={comparison}
        changes={comparisonChanges(comparison.criteria, plan.criteria)}
        stale={stale}
        blocked={blocked}
        onBack={() => setView("plan")}
        onReview={() => setComparison(plan)}
        onOpenChecklist={() => {
          if (!blocked && !stale) setView("checklist");
        }}
        onTransport={
          onOpenSource ? () => onOpenSource(comparison.threadId) : undefined
        }
      />
    );
  }

  function updateCriteria(update: Partial<PlanDraft["criteria"]>) {
    if (!planForm) return;
    setPlanDraft({
      ...planForm,
      criteria: { ...planForm.criteria, ...update },
    });
  }
  function showPlan(event: FormEvent) {
    event.preventDefault();
    if (!planForm || blocked || planOutdated) return;
    const commute = planForm.criteria.commute.trim();
    setPlanDraft({
      ...planForm,
      criteria: {
        ...planForm.criteria,
        city: planForm.criteria.city.trim(),
        commute,
        situation: commute ? "oriented" : "direct",
      },
    });
    setPreview(true);
  }
  function savePlan() {
    if (!planForm || !criteria || blocked || planOutdated) return;
    const { budget, ...known } = criteria;
    void control.current?.save({
      kind: "plan",
      input: {
        expectedRevision: planForm.expectedRevision,
        threadId: planForm.threadId,
        criteria: {
          ...known,
          budgetRub: budget === "" ? null : Number(budget),
        },
        requestId: crypto.randomUUID(),
      },
    });
  }
  function saveChecklist() {
    if (!checklistForm || blocked || checklistOutdated) return;
    void control.current?.save({
      kind: "checklist",
      input: { ...checklistForm, requestId: crypto.randomUUID() },
    });
  }

  function confirmPreparation() {
    if (!review || blocked || reviewOutdated) return;
    void control.current?.save({
      kind: "confirmation",
      input: { ...review, reviewed: true, requestId: crypto.randomUUID() },
    });
  }

  return (
    <Card
      className={styles.panel + " ym-hide-content"}
      aria-labelledby={headingId}
      aria-busy={busy}
    >
      <div className={styles.header}>
        <Button type="button" variant="ghost" onClick={onExit}>
          К разделу
        </Button>
        <p className={styles.eyebrow}>Помощник по жилью</p>
        <h1 id={headingId} ref={heading} tabIndex={-1}>
          {headingTitle}
        </h1>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {(!current || uncertain || error) && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void control.current?.load()}
        >
          {uncertain ? "Проверить сохранение" : "Обновить данные"}
        </Button>
      )}
      {uncertain && canRetry && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void control.current?.save(uncertain)}
        >
          Повторить сохранение
        </Button>
      )}
      {!current ? (
        busy && <p role="status">Загружаем результаты…</p>
      ) : view === "plan" ? (
        <>
          {plan && (
            <p className={styles.intro}>
              Версия {plan.revision} · Стартовый план
            </p>
          )}
          {planOutdated && (
            <aside className={styles.orientation} role="status">
              <p>
                В другой вкладке сохранена версия {plan?.revision}. Ваши правки
                пока открыты.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={blocked}
                onClick={() => {
                  setPlanDraft(null);
                  setPreview(false);
                  setError("");
                }}
              >
                Открыть сохранённую версию
              </Button>
            </aside>
          )}
          {editingPlan && criteria ? (
            <form className={styles.stack} onSubmit={showPlan}>
              <Field
                label="Город"
                value={criteria.city}
                maxLength={100}
                className="ym-disable-keys"
                disabled={blocked || planOutdated}
                onChange={(event) =>
                  updateCriteria({ city: event.target.value })
                }
              />
              <Field
                label="Куда ездить"
                hint="Например, станция метро или рабочий адрес."
                value={criteria.commute}
                maxLength={100}
                className="ym-disable-keys"
                disabled={blocked || planOutdated}
                onChange={(event) =>
                  updateCriteria({ commute: event.target.value })
                }
              />
              <Field
                label="Бюджет в месяц, ₽"
                hint="Можно уточнить позже."
                value={criteria.budget}
                type="number"
                inputMode="numeric"
                min={1}
                max={99_999_999}
                step={1}
                className="ym-disable-keys"
                disabled={blocked || planOutdated}
                onChange={(event) =>
                  updateCriteria({ budget: event.target.value })
                }
              />
              <Button type="submit" disabled={blocked || planOutdated}>
                Собрать стартовый план
              </Button>
              {plan && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={blocked}
                  onClick={() => {
                    setPlanDraft(null);
                    setPreview(false);
                  }}
                >
                  Отмена
                </Button>
              )}
            </form>
          ) : criteria ? (
            <>
              {criteria.city && <p>{criteria.city}</p>}
              <HousingPlanSteps
                {...housingPlanContent({
                  ...criteria,
                  budgetRub: criteria.budget ? Number(criteria.budget) : null,
                })}
              />
              <div className={styles.stack}>
                {planDraft && (
                  <Button
                    type="button"
                    disabled={blocked || planOutdated}
                    onClick={savePlan}
                  >
                    Сохранить в мой план
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={blocked || planOutdated}
                  onClick={() => {
                    setPlanDraft(planForm);
                    setPreview(false);
                  }}
                >
                  Уточнить условия
                </Button>
                {plan && !planDraft && (
                  <>
                    <Button
                      type="button"
                      disabled={blocked}
                      onClick={() => {
                        setComparison(plan);
                        setView("comparison");
                      }}
                    >
                      Показать направления поиска
                    </Button>
                    {localShortlist && (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={blocked}
                        onClick={() => {
                          setShortlist(plan);
                          setView("shortlist");
                          void control.current?.load();
                        }}
                      >
                        Посмотреть короткий список
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setView("checklist")}
                    >
                      Открыть чек-лист просмотра
                    </Button>
                  </>
                )}
                {plan && onOpenSource && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onOpenSource(plan.threadId)}
                  >
                    Исходный диалог
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <p>
                Стартовый план пока не сохранён. Его можно составить с
                помощником по жилью.
              </p>
              {onChooseAssistant && (
                <Button type="button" onClick={onChooseAssistant}>
                  К помощнику по жилью
                </Button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setReview(null);
              setView("plan");
            }}
          >
            К стартовому плану
          </Button>
          {!plan || !checklistForm ? (
            <p>Сначала сохраните стартовый план поиска жилья.</p>
          ) : (
            <>
              <p className={styles.intro}>
                {checklist ? `Версия ${checklist.revision} · ` : ""}
                На основе стартового плана версии{" "}
                {checklistDraft?.planRevision ??
                  checklist?.planRevision ??
                  plan.revision}
              </p>
              {checklistOutdated && (
                <aside className={styles.orientation} role="status">
                  <p>
                    Появилась более свежая версия. Ваши отметки пока открыты.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={blocked}
                    onClick={() => {
                      setChecklistDraft(null);
                      setError("");
                    }}
                  >
                    Открыть сохранённую версию
                  </Button>
                </aside>
              )}
              {checklistStale && !checklistDraft && (
                <aside className={styles.orientation} role="status">
                  <p>
                    {paymentNeedsReview
                      ? `Изменился бюджет в стартовом плане версии ${plan.revision}. Перепроверьте полный первый платёж.`
                      : `Стартовый план обновлён до версии ${plan.revision}. Сохранённые отметки чек-листа действуют.`}
                  </p>
                  {paymentNeedsReview && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={blocked}
                      onClick={() =>
                        setChecklistDraft(savedDraft(checklist, plan.revision))
                      }
                    >
                      Перепроверить платёж
                    </Button>
                  )}
                </aside>
              )}
              <ul className={styles.steps} aria-label="Пункты просмотра">
                {viewingItems.map(({ id, title, details }) => (
                  <li key={id}>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={checklistForm.selected.includes(id)}
                        disabled={
                          blocked ||
                          checklistOutdated ||
                          !!review ||
                          (paymentNeedsReview && !checklistDraft)
                        }
                        onChange={(event) => {
                          const selected = new Set(checklistForm.selected);
                          if (event.target.checked) selected.add(id);
                          else selected.delete(id);
                          setChecklistDraft({
                            ...checklistForm,
                            selected: viewingItems
                              .map((item) => item.id)
                              .filter((key) => selected.has(key)),
                          });
                        }}
                      />
                      {title}
                    </label>
                    <p>{details}</p>
                  </li>
                ))}
              </ul>
              <aside className={styles.orientation}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={checklistForm.paymentChecked}
                    disabled={
                      blocked ||
                      checklistOutdated ||
                      !!review ||
                      (paymentNeedsReview && !checklistDraft)
                    }
                    onChange={(event) =>
                      setChecklistDraft({
                        ...checklistForm,
                        paymentChecked: event.target.checked,
                      })
                    }
                  />
                  Полный первый платёж проверен
                </label>
              </aside>
              <Button
                type="button"
                disabled={
                  blocked ||
                  checklistOutdated ||
                  !!review ||
                  (!!checklist && !checklistDraft)
                }
                onClick={saveChecklist}
              >
                Сохранить чек-лист
              </Button>
              {checklist && preparationConfirmed && !checklistDraft && (
                <p className={styles.summary} role="status">
                  Подготовка подтверждена
                </p>
              )}
              {checklist &&
                !preparationConfirmed &&
                !checklistDraft &&
                !review && (
                  <Button
                    type="button"
                    disabled={blocked || paymentNeedsReview}
                    onClick={() =>
                      setReview({
                        expectedRevision: checklist.revision,
                        planRevision: plan.revision,
                      })
                    }
                  >
                    Подтвердить подготовку
                  </Button>
                )}
              {review && (
                <aside
                  className={styles.orientation}
                  aria-label="Подтверждение подготовки"
                >
                  <h2 ref={confirmationHeading} tabIndex={-1}>
                    Подтвердите подготовку к просмотру
                  </h2>
                  {reviewOutdated ? (
                    <p role="status">
                      Результат обновился. Проверьте текущую версию чек-листа.
                    </p>
                  ) : (
                    <p>
                      Чек-лист версии {review.expectedRevision}, стартовый план
                      версии {review.planRevision}. Подтвердите, что вы
                      ознакомились с пунктами подготовки к просмотру.
                    </p>
                  )}
                  <Button
                    type="button"
                    disabled={blocked || reviewOutdated}
                    onClick={confirmPreparation}
                  >
                    Я подготовился к просмотру
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || !!uncertain}
                    onClick={() => setReview(null)}
                  >
                    {reviewOutdated ? "Посмотреть текущую версию" : "Отмена"}
                  </Button>
                </aside>
              )}
              {onOpenSource && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenSource(plan.threadId)}
                >
                  Исходный диалог
                </Button>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
