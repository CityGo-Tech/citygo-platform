import {
  housingWorkspaceSchema,
  personalPlanIdSchema,
  saveHousingChecklistSchema,
  saveHousingPlanSchema,
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
const checklistSnapshot = `json_build_object(
  'revision',revision,'planRevision',plan_revision,'selected',selected,'paymentChecked',payment_checked,
  'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'requestId',request_id::text
)`;

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
          (select ${checklistSnapshot} from housing_workspace_checklists where user_id=u.id order by revision desc limit 1) as checklist
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
      const previous = (
        await tx.query<{ snapshot: Checklist }>(
          `select ${checklistSnapshot} as snapshot from housing_workspace_checklists where user_id=$1 and request_id=$2`,
          [userId, input.requestId],
        )
      ).rows[0]?.snapshot;
      const current = await this.read(tx, userId);
      if (previous) {
        checkReplay(
          input.expectedRevision + 1 === previous.revision &&
            input.planRevision === previous.planRevision &&
            input.paymentChecked === previous.paymentChecked &&
            input.selected.length === previous.selected.length &&
            input.selected.every(
              (item, index) => item === previous.selected[index],
            ),
        );
        return { workspace: current, saved: false };
      }
      checkRevision(current.checklist?.revision ?? 0, input.expectedRevision);
      if (!current.plan)
        throw new DomainError(409, "Сначала сохраните стартовый план.");
      if (current.plan.revision !== input.planRevision)
        throw new DomainError(
          409,
          "План изменился. Проверьте чек-лист перед сохранением.",
          "PLAN_STALE",
          current.plan.revision,
        );
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
}
