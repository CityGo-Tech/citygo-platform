import {
  personalPlanIdSchema,
  resultDiscussionParamsSchema,
  resultDiscussionSourceSchema,
  planChecklistEntriesSchema,
  type ResultDiscussionParams,
} from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

/** Explicit, read-only source selection. Never starts a conversation or model. */
export async function readResultDiscussionSource(
  db: Database,
  userId: string,
  input: ResultDiscussionParams,
) {
  personalPlanIdSchema.parse(userId);
  const { kind, id } = resultDiscussionParamsSchema.parse(input);
  return db.transaction(async (tx) => {
    const owner = (
      await tx.query<{ status: string; must_change_password: boolean }>(
        "select status,must_change_password from users where id=$1 for share",
        [userId],
      )
    ).rows[0];
    if (!owner || owner.status !== "active" || owner.must_change_password)
      throw new DomainError(403, "Аккаунт недоступен");
    let value: unknown;
    if (kind === "plan") {
      const row = (
        await tx.query<{
          title: string;
          details: string;
          revision: number;
          checklist: unknown;
        }>(
          `select p.title,p.details,p.revision,c.entries as checklist
           from personal_plan_items p
           left join messages m on m.id=p.source_message_id
           left join agent_threads t on t.id=m.thread_id
           left join personal_plan_checklists c on c.item_id=p.id
           where p.id=$2 and p.user_id=$1 and p.deleted_at is null
           and (p.source_message_id is null or (t.user_id=$1 and m.role in ('user','assistant')))`,
          [userId, id],
        )
      ).rows[0];
      if (!row) throw new DomainError(404, "Результат не найден");
      // Checklist data is validated before rendering any saved text.
      const checklist = planChecklistEntriesSchema.parse(row.checklist ?? []);
      const text = [
        row.title,
        row.details,
        checklist.length
          ? "Чеклист:\n" +
            checklist
              .map(
                (entry) =>
                  (entry.completed ? "[x] " : "[ ] ") +
                  entry.title +
                  (entry.details ? "\n" + entry.details : ""),
              )
              .join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      value = {
        userId,
        kind,
        id,
        revision: Number(row.revision),
        title: row.title,
        text,
        assistantKey: "support",
        interrupted: false,
      };
    } else {
      const row = (
        await tx.query<{ text: string; assistantKey: string; status: string }>(
          `select m.content as text,coalesce(m.metadata->>'agentKey','housing') as "assistantKey",
            coalesce(m.metadata->>'status','complete') as status
           from messages m join agent_threads t on t.id=m.thread_id
           where m.id=$2 and t.user_id=$1 and m.role in ('user','assistant')
           and m.metadata->'citygoFavorite'='true'::jsonb
           and coalesce(m.metadata->>'status','complete') in ('complete','interrupted')`,
          [userId, id],
        )
      ).rows[0];
      if (!row) throw new DomainError(404, "Результат не найден");
      value = {
        userId,
        kind,
        id,
        revision: null,
        title: "Избранное сообщение",
        text: row.text,
        assistantKey: row.assistantKey,
        interrupted: row.status === "interrupted",
      };
    }
    const parsed = resultDiscussionSourceSchema.safeParse(value);
    if (!parsed.success)
      throw new DomainError(500, "Не удалось прочитать сохранённый результат");
    return parsed.data;
  });
}
