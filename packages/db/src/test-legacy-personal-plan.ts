// Historical schema37–40 fixtures must use their real old INSERT shape, not
// the schema41 writer which requires atomic revision history.
import { PersonalPlan, type Database } from "./index.js";
export async function seedLegacyPlan(
  db: Database,
  userId: string,
  input: {
    operationId: string;
    sourceMessageId: string | null;
    title: string;
    details: string;
  },
) {
  const id = (
    await db.query<{ id: string }>(
      `insert into personal_plan_items(user_id,operation_id,source_message_id,create_request_hash,title,details)
     values($1,$2,$3,repeat('a',64),$4,$5) returning id::text`,
      [
        userId,
        input.operationId,
        input.sourceMessageId,
        input.title,
        input.details,
      ],
    )
  ).rows[0]!.id;
  return {
    userId,
    item: (await new PersonalPlan(db).list(userId)).items.find(
      (item) => item.id === id,
    )!,
  };
}
