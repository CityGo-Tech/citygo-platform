import {
  confirmHousingChecklistSchema,
  housingWorkspaceSchema,
  personalPlanIdSchema,
  saveHousingChecklistSchema,
  saveHousingPlanSchema,
  type ConfirmHousingChecklist,
  type HousingWorkspace,
  type SaveHousingChecklist,
  type SaveHousingPlan,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

type Plan = NonNullable<HousingWorkspace["plan"]>;
type Checklist = NonNullable<HousingWorkspace["checklist"]>;
const planSnapshot = `json_build_object(
  'revision',revision,'threadId',thread_id::text,
  'criteria',json_build_object('situation',situation,'city',city,'commute',commute,'budgetRub',budget_rub),
  'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'requestId',request_id::text
)`;
// Compare all later versions with the saved source, so a budget change and
// reversal still asks the owner to recheck payments. Other criteria do not
// affect the generic payment questions in this checklist.
const paymentNeedsReview = `case when exists(
  select 1 from housing_workspace_plans source
  join housing_workspace_plans later
    on later.user_id=source.user_id and later.revision>source.revision
  where source.user_id=c.user_id and source.revision=c.plan_revision
    and later.budget_rub is distinct from source.budget_rub
) then true end`;

function checklistSnapshot(needsReview = "null::boolean") {
  return `json_strip_nulls(json_build_object(
    'revision',c.revision,'planRevision',c.plan_revision,'selected',c.selected,'paymentChecked',c.payment_checked,
    'updatedAt',to_char(c.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'requestId',c.request_id::text,'confirmedFromRevision',c.confirmed_from_revision,
    'paymentNeedsReview',${needsReview}
  ))`;
}

function checkRevision(current: number, expected: number) {
  if (current !== expected)
    throw new DomainError(
      409,
      "Результат изменился. Откройте сохранённую версию.",
      "REVISION_CONFLICT",
      current,
    );
  if (current === 2147483647)
    throw new DomainError(409, "Достигнут предел версий результата.");
}

function checkReplay(matches: boolean) {
  if (!matches)
    throw new DomainError(
      409,
      "Эта команда сохранения уже использована.",
      "CONFLICT",
    );
}

/** Housing result revisions are appended only by explicit owner commands. */
export class HousingWorkspaceStore {
  constructor(private readonly db: Database) {}

  private async read(sql: Sql, userId: string) {
    // One statement keeps the two current revisions in the same MVCC snapshot.
    const data = (
      await sql.query<{ plan: unknown; checklist: unknown }>(
        `select
          (select ${planSnapshot} from housing_workspace_plans where user_id=u.id order by revision desc limit 1) as plan,
          (select ${checklistSnapshot(paymentNeedsReview)} from housing_workspace_checklists c
            where c.user_id=u.id order by c.revision desc limit 1) as checklist
         from users u where u.id=$1 and u.status='active' and not u.must_change_password`,
        [userId],
      )
    ).rows[0];
    if (!data) throw new DomainError(401, "Войдите в аккаунт");
    const parsed = housingWorkspaceSchema.safeParse({ userId, ...data });
    if (!parsed.success)
      throw new DomainError(500, "Не удалось прочитать жилищные результаты.");
    return parsed.data;
  }

  private async lockOwner(tx: Sql, userId: string) {
    const owner = (
      await tx.query<{ status: string; must_change_password: boolean }>(
        "select status,must_change_password from users where id=$1 for update",
        [userId],
      )
    ).rows[0];
    if (!owner || owner.status !== "active")
      throw new DomainError(401, "Войдите в аккаунт");
    if (owner.must_change_password)
      throw new DomainError(403, "Сначала смените временный пароль");
  }

  private async checklistByRequest(tx: Sql, userId: string, requestId: string) {
    return (
      await tx.query<{ snapshot: Checklist }>(
        `select ${checklistSnapshot()} as snapshot from housing_workspace_checklists c where c.user_id=$1 and c.request_id=$2`,
        [userId, requestId],
      )
    ).rows[0]?.snapshot;
  }

  private async requireUnusedPlanRequest(
    tx: Sql,
    userId: string,
    requestId: string,
  ) {
    const used = await tx.query(
      "select 1 from housing_workspace_plans where user_id=$1 and request_id=$2",
      [userId, requestId],
    );
    checkReplay(!used.rows.length);
  }

  async get(userId: string) {
    return this.read(this.db, personalPlanIdSchema.parse(userId));
  }

  async savePlan(
    userId: string,
    raw: SaveHousingPlan,
    onSaved?: () => Promise<void>,
  ) {
    personalPlanIdSchema.parse(userId);
    const input = saveHousingPlanSchema.parse(raw);
    const { workspace, saved } = await this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const previous = (
        await tx.query<{ snapshot: Plan }>(
          `select ${planSnapshot} as snapshot from housing_workspace_plans where user_id=$1 and request_id=$2`,
          [userId, input.requestId],
        )
      ).rows[0]?.snapshot;
      const current = await this.read(tx, userId);
      const { situation, city, commute, budgetRub } = input.criteria;
      if (previous) {
        checkReplay(
          input.expectedRevision + 1 === previous.revision &&
            input.threadId === previous.threadId &&
            situation === previous.criteria.situation &&
            city === previous.criteria.city &&
            commute === previous.criteria.commute &&
            budgetRub === previous.criteria.budgetRub,
        );
        return { workspace: current, saved: false };
      }
      checkReplay(
        !(await this.checklistByRequest(tx, userId, input.requestId)),
      );
      checkRevision(current.plan?.revision ?? 0, input.expectedRevision);
      if (current.plan && current.plan.threadId !== input.threadId)
        throw new DomainError(
          409,
          "Используйте исходную задачу плана.",
          "CONFLICT",
        );
      if (!current.plan) {
        const source = await tx.query(
          `select id from agent_threads where id=$1 and user_id=$2 and status<>'closed'
           and coalesce(conversation_agent_key,agent_key)='housing'`,
          [input.threadId, userId],
        );
        if (!source.rows.length)
          throw new DomainError(404, "Жилищная задача не найдена.");
      }
      await tx.query(
        `insert into housing_workspace_plans(user_id,revision,thread_id,situation,city,commute,budget_rub,request_id)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          userId,
          input.expectedRevision + 1,
          input.threadId,
          situation,
          city,
          commute,
          budgetRub,
          input.requestId,
        ],
      );
      return { workspace: await this.read(tx, userId), saved: true };
    });
    if (saved) await onSaved?.();
    return workspace;
  }

  async saveChecklist(
    userId: string,
    raw: SaveHousingChecklist,
    onSaved?: () => Promise<void>,
  ) {
    personalPlanIdSchema.parse(userId);
    const input = saveHousingChecklistSchema.parse(raw);
    const { workspace, saved } = await this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const previous = await this.checklistByRequest(
        tx,
        userId,
        input.requestId,
      );
      const current = await this.read(tx, userId);
      if (previous) {
        checkReplay(
          input.expectedRevision + 1 === previous.revision &&
            previous.confirmedFromRevision === undefined &&
            input.planRevision === previous.planRevision &&
            input.paymentChecked === previous.paymentChecked &&
            input.selected.length === previous.selected.length &&
            input.selected.every(
              (item, index) => item === previous.selected[index],
            ),
        );
        return { workspace: current, saved: false };
      }
      await this.requireUnusedPlanRequest(tx, userId, input.requestId);
      checkRevision(current.checklist?.revision ?? 0, input.expectedRevision);
      this.requireCurrentPlan(current, input.planRevision);
      await tx.query(
        `insert into housing_workspace_checklists(user_id,revision,plan_revision,selected,payment_checked,request_id)
         values($1,$2,$3,$4,$5,$6)`,
        [
          userId,
          input.expectedRevision + 1,
          input.planRevision,
          input.selected,
          input.paymentChecked,
          input.requestId,
        ],
      );
      return { workspace: await this.read(tx, userId), saved: true };
    });
    if (saved) await onSaved?.();
    return workspace;
  }

  private requireCurrentPlan(current: HousingWorkspace, planRevision: number) {
    if (!current.plan)
      throw new DomainError(409, "Сначала сохраните стартовый план.");
    if (current.plan.revision !== planRevision)
      throw new DomainError(
        409,
        "План изменился. Откройте актуальную версию.",
        "PLAN_STALE",
        current.plan.revision,
      );
  }

  async confirmChecklist(userId: string, raw: ConfirmHousingChecklist) {
    personalPlanIdSchema.parse(userId);
    const input = confirmHousingChecklistSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const previous = await this.checklistByRequest(
        tx,
        userId,
        input.requestId,
      );
      const current = await this.read(tx, userId);
      if (previous) {
        checkReplay(
          previous.confirmedFromRevision === input.expectedRevision &&
            previous.planRevision === input.planRevision,
        );
        return current;
      }
      await this.requireUnusedPlanRequest(tx, userId, input.requestId);
      this.requireCurrentPlan(current, input.planRevision);
      const checklist = current.checklist;
      if (!checklist)
        throw new DomainError(409, "Сначала сохраните чек-лист просмотра.");
      checkRevision(checklist.revision, input.expectedRevision);
      if (checklist.paymentNeedsReview)
        throw new DomainError(
          409,
          "Бюджет изменился. Перепроверьте платежи и сохраните чек-лист.",
          "PLAN_STALE",
          input.planRevision,
        );
      if (checklist.confirmedFromRevision !== undefined) return current;
      await tx.query(
        `insert into housing_workspace_checklists(user_id,revision,plan_revision,selected,payment_checked,request_id,confirmed_from_revision)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [
          userId,
          checklist.revision + 1,
          input.planRevision,
          checklist.selected,
          checklist.paymentChecked,
          input.requestId,
          checklist.revision,
        ],
      );
      return this.read(tx, userId);
    });
  }
}
