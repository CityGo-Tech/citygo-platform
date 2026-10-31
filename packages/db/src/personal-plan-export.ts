import {
  personalPlanExportSchema,
  personalPlanIdSchema,
  type PersonalPlanExport,
} from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

/** A single SELECT snapshot: no page stitching, source message text or writes. */
export async function exportPersonalPlan(
  db: Database,
  userId: string,
): Promise<PersonalPlanExport> {
  personalPlanIdSchema.parse(userId);
  return db.transaction(async (tx) => {
    const row = (
      await tx.query<{ generatedAt: string; items: unknown }>(
        `with owner as (
        select id from users where id=$1 and status='active' and not must_change_password
      ), visible as (
        select p.*, case when p.source_message_id is null then null else
          jsonb_build_object('messageId',m.id::text,'threadId',t.id::text,'role',m.role) end as source,
          coalesce(c.entries,'[]'::jsonb) as entries
        from personal_plan_items p join owner u on u.id=p.user_id
        left join messages m on m.id=p.source_message_id
        left join agent_threads t on t.id=m.thread_id
        left join personal_plan_checklists c on c.item_id=p.id
        where p.deleted_at is null and (p.source_message_id is null or
          (t.user_id=$1 and m.role in ('user','assistant')))
        order by p.id desc limit 201
      )
      select to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "generatedAt",
        coalesce(jsonb_agg(jsonb_build_object(
          'id',p.id::text,'title',p.title,'details',p.details,'status',p.status,
          'revision',p.revision,'source',p.source,
          'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updatedAt',to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'checklist',p.entries
        ) order by p.id desc) filter(where p.id is not null),'[]'::jsonb) as items
      from owner u left join visible p on true group by u.id`,
        [userId],
      )
    ).rows[0];
    if (!row) throw new DomainError(403, "Войдите в действующий аккаунт");
    const value = personalPlanExportSchema.safeParse({ userId, ...row });
    if (!value.success)
      throw new DomainError(
        500,
        "Не удалось выгрузить весь план. Можно сохранить отдельные шаги.",
      );
    return value.data;
  });
}
