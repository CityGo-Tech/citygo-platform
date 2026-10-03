import type { Quest, QuestPlanReference } from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

type StoredPlan = QuestPlanReference & {
  status: "draft" | "active" | "completed" | "archived";
};
type StoredQuest = {
  id: string;
  state: Quest["state"];
  slug: string;
  xp_reward: number;
  plan_id: string;
  plan_version: number;
};

// Selection for current reads/commands, NOT a rule for historical backfill.
export async function currentQuestPlan(tx: Sql, userId: string) {
  return (
    await tx.query<StoredPlan>(
      "select id::text,version,status from relocation_plans where user_id=$1 and status in ('active','completed') order by version desc limit 1",
      [userId],
    )
  ).rows[0];
}

// All plan/quest writers take user -> plan -> quest locks. Future replacement
// commands must follow the same order; no AI/network I/O inside this transaction.
export async function lockQuestPlan(
  tx: Sql,
  userId: string,
  questId: string,
  expected: QuestPlanReference | undefined,
  allowCompletedReplay: boolean,
): Promise<StoredQuest> {
  await tx.query("select id from users where id=$1 for update", [userId]);
  const owned = (
    await tx.query<{ plan_id: string }>(
      "select plan_id::text from user_quests where id=$1 and user_id=$2",
      [questId, userId],
    )
  ).rows[0];
  if (!owned || (expected && expected.id !== owned.plan_id))
    throw new DomainError(404, "Квест не найден");
  const plan = (
    await tx.query<StoredPlan>(
      "select id::text,version,status from relocation_plans where id=$1 and user_id=$2 for update",
      [owned.plan_id, userId],
    )
  ).rows[0];
  if (!plan) throw new DomainError(404, "Квест не найден");
  const quest = (
    await tx.query<StoredQuest>(
      `select uq.id::text,uq.state,q.slug,q.xp_reward,uq.plan_id::text,uq.plan_version
       from user_quests uq join quests q on q.id=uq.quest_id
       where uq.id=$1 and uq.user_id=$2 for update of uq`,
      [questId, userId],
    )
  ).rows[0];
  if (!quest) throw new DomainError(404, "Квест не найден");
  const current = await currentQuestPlan(tx, userId);
  if (
    plan.id !== current?.id ||
    plan.version !== quest.plan_version ||
    (expected && expected.version !== plan.version) ||
    (plan.status !== "active" &&
      !(
        allowCompletedReplay &&
        plan.status === "completed" &&
        quest.state === "completed"
      ))
  )
    throw new DomainError(
      409,
      "План изменился или больше не активен. Обновите страницу.",
      "PLAN_STALE",
      current?.version,
    );
  return quest;
}
