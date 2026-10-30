import {
  personalPlanIdSchema,
  planChecklistSchema,
  savePlanChecklistSchema,
  type PlanChecklist,
  type SavePlanChecklist,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
const missing = () => new DomainError(404, "Чек-лист не найден");
type Row = { revision: string; entries: unknown };
/** Only explicit owner edits. Parent CAS serializes with every other step edit. */
export class PlanChecklists {
  constructor(private readonly db: Database) {}
  private parse(userId: string, itemId: string, row: Row): PlanChecklist {
    const result = planChecklistSchema.safeParse({
      userId,
      itemId,
      revision: Number(row.revision),
      entries: row.entries,
    });
    if (!result.success)
      throw new DomainError(500, "Не удалось прочитать чек-лист");
    return result.data;
  }
  private async read(
    sql: Sql,
    userId: string,
    itemId: string,
    lock = false,
  ): Promise<Row> {
    const row = (
      await sql.query<Row>(
        `select p.revision::text,coalesce(c.entries,'[]'::jsonb) as entries
      from personal_plan_items p join users u on u.id=p.user_id
      left join personal_plan_checklists c on c.item_id=p.id
      where p.id=$1 and p.user_id=$2 and p.deleted_at is null and u.status='active' and not u.must_change_password
      ${lock ? "for update of p" : ""}`,
        [itemId, userId],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  async get(userId: string, itemId: string) {
    personalPlanIdSchema.parse(userId);
    personalPlanIdSchema.parse(itemId);
    return this.parse(userId, itemId, await this.read(this.db, userId, itemId));
  }
  async save(userId: string, itemId: string, raw: SavePlanChecklist) {
    personalPlanIdSchema.parse(userId);
    personalPlanIdSchema.parse(itemId);
    const input = savePlanChecklistSchema.parse(raw);
    return this.db.transaction(async (tx) => {
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
      const row = await this.read(tx, userId, itemId, true);
      const current = this.parse(userId, itemId, row);
      if (current.revision !== input.expectedRevision)
        throw new DomainError(
          409,
          "Шаг изменился. Обновите чек-лист перед сохранением.",
          "REVISION_CONFLICT",
          current.revision,
        );
      if (current.revision === Number.MAX_SAFE_INTEGER)
        throw new DomainError(409, "Достигнут предел версий шага");
      await tx.query(
        "update personal_plan_items set revision=revision+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=$1",
        [itemId],
      );
      await tx.query(
        `insert into personal_plan_checklists(item_id,parent_revision,entries) values($1,$2,$3::jsonb)
        on conflict(item_id) do update set parent_revision=excluded.parent_revision,entries=excluded.entries`,
        [itemId, current.revision + 1, JSON.stringify(input.entries)],
      );
      return this.parse(userId, itemId, await this.read(tx, userId, itemId));
    });
  }
}
