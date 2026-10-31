import {
  personalPlanHistoryPageSchema,
  personalPlanIdSchema,
  type PersonalPlanHistoryEntry,
  type PersonalPlanHistoryPage,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

/** Runs within the same owner-locked transaction as the actual edit. */
export async function recordPersonalPlanRevision(tx: Sql, itemId: string) {
  await tx.query(
    `insert into personal_plan_item_history(item_id,revision,title,details,status,checklist)
     select p.id,p.revision,p.title,p.details,p.status,coalesce(c.entries,'[]'::jsonb)
     from personal_plan_items p left join personal_plan_checklists c on c.item_id=p.id
     where p.id=$1 and p.deleted_at is null`,
    [itemId],
  );
}

export class PersonalPlanHistory {
  constructor(private readonly db: Database) {}
  async page(
    userId: string,
    itemId: string,
    before?: number,
  ): Promise<PersonalPlanHistoryPage> {
    personalPlanIdSchema.parse(userId);
    personalPlanIdSchema.parse(itemId);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new DomainError(400, "Проверьте версию шага");
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
      const current = (
        await tx.query<{ revision: string }>(
          `select p.revision::text from personal_plan_items p
         left join messages m on m.id=p.source_message_id left join agent_threads t on t.id=m.thread_id
         where p.id=$1 and p.user_id=$2 and p.deleted_at is null
         and (p.source_message_id is null or (t.user_id=$2 and m.role in ('user','assistant')))`,
          [itemId, userId],
        )
      ).rows[0];
      if (!current) throw new DomainError(404, "История шага не найдена");
      const rows = (
        await tx.query<
          Omit<PersonalPlanHistoryEntry, "revision"> & { revision: string }
        >(
          `select revision::text,title,details,status,checklist,initial_snapshot as "initialSnapshot",
         to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
         from personal_plan_item_history where item_id=$1 and ($2::bigint is null or revision<$2)
         order by revision desc limit 6`,
          [itemId, before ?? null],
        )
      ).rows;
      if (before === undefined && rows[0]?.revision !== current.revision)
        throw new DomainError(500, "Не удалось прочитать историю шага");
      const entries: PersonalPlanHistoryEntry[] = [];
      let bytes = 2;
      for (const row of rows.slice(0, 5)) {
        const entry = { ...row, revision: Number(row.revision) };
        const size =
          Buffer.byteLength(JSON.stringify(entry), "utf8") +
          (entries.length ? 1 : 0);
        if (entries.length && bytes + size > 256 * 1024) break;
        entries.push(entry);
        bytes += size;
      }
      const parsed = personalPlanHistoryPageSchema.safeParse({
        userId,
        itemId,
        currentRevision: Number(current.revision),
        entries,
        nextBefore:
          rows.length > entries.length ? entries.at(-1)!.revision : null,
      });
      if (!parsed.success)
        throw new DomainError(500, "Не удалось прочитать историю шага");
      return parsed.data;
    });
  }
}
