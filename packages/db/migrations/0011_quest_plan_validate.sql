begin;

-- STOP/DRAIN old API/worker writers before this phase. Old SQL is plan-unaware;
-- retaining a NULL escape hatch would not make a mixed-version rollout safe.
do $preflight$
begin
  lock table users, relocation_plans, quests, user_quests, xp_events in share row exclusive mode;
  if exists (select 1 from citygo_quest_plan_preflight where issue is not null) then
    raise exception 'CG009_BACKFILL_BLOCKED: inspect citygo_quest_plan_preflight on an isolated expanded copy';
  end if;
  if exists (select 1 from relocation_plans where status = 'active' group by user_id having count(*) > 1) then
    raise exception 'CG009_BACKFILL_BLOCKED: multiple active plans';
  end if;
end
$preflight$;

-- Only the new ownership columns change. IDs, state, timestamps and XP do not.
update user_quests uq set plan_id = p.candidate_plan_id, plan_version = p.candidate_plan_version
from citygo_quest_plan_preflight p
where p.user_quest_id = uq.id and uq.plan_id is null and p.issue is null;

alter table user_quests alter column plan_id set not null;
alter table user_quests alter column plan_version set not null;
alter table user_quests drop constraint user_quests_user_id_quest_id_key;
create unique index relocation_plans_one_active on relocation_plans(user_id) where status = 'active';

-- A user-quest ID is a permanent identity (including its plan/version). New plan
-- versions create new IDs, never move old completions or their XP to a new plan.
create function citygo_keep_quest_identity() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $identity$
begin
  if (new.user_id, new.quest_id, new.plan_id, new.plan_version)
    is distinct from (old.user_id, old.quest_id, old.plan_id, old.plan_version) then
    raise exception 'CG009_IMMUTABLE_QUEST_IDENTITY' using errcode = '23514';
  end if;
  return new;
end
$identity$;
revoke all on function citygo_keep_quest_identity() from public;
create trigger user_quests_keep_identity before update on user_quests
for each row execute function citygo_keep_quest_identity();

commit;
