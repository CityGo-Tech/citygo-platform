begin;

-- Expand only: legacy writers may still omit the pair; keep their uniqueness.
-- 0011 is a separate validation/contract phase and requires a drained rollout.
alter table relocation_plans add constraint relocation_plans_owner_version_key
  unique (id, user_id, version);
alter table user_quests add column plan_id bigint;
alter table user_quests add column plan_version integer;
alter table user_quests add constraint user_quests_plan_pair
  check ((plan_id is null and plan_version is null)
    or (plan_id is not null and plan_version is not null and plan_version > 0));
alter table user_quests add constraint user_quests_plan_owner_fkey
  foreign key (plan_id, user_id, plan_version)
  references relocation_plans(id, user_id, version);
create unique index user_quests_plan_quest_key on user_quests(plan_id, quest_id);

-- Operator-only diagnostic view. No raw profile/chat/financial data, no guessing
-- latest/active among several legacy plans. Explicit mappings still validate.
create view citygo_quest_plan_preflight as
select uq.id as user_quest_id, uq.user_id, p.id as candidate_plan_id,
  p.version as candidate_plan_version,
  case
    when u.id is null then 'missing_user'
    when q.id is null then 'missing_quest'
    when uq.plan_id is null and candidates.n = 0 then 'missing_plan'
    when uq.plan_id is null and candidates.n <> 1 then 'ambiguous_plan'
    when p.id is null then 'missing_plan'
    when p.user_id <> uq.user_id or
      (uq.plan_version is not null and uq.plan_version <> p.version) then 'owner_or_version_mismatch'
    when uq.plan_id is null and p.status not in ('active', 'completed') then 'unsupported_legacy_status'
    when jsonb_typeof(p.plan->'stages') is distinct from 'array'
      or not (p.plan->'stages' ? q.slug) then 'quest_not_in_plan'
    when p.status = 'completed' and uq.state <> 'completed' then 'completed_plan_has_open_quest'
    when uq.plan_id is null and p.created_at > uq.created_at then 'plan_created_after_quest'
    when exists (select 1 from xp_events x where x.user_quest_id = uq.id and x.user_id <> uq.user_id)
      then 'xp_owner_mismatch'
    when uq.state <> 'completed' and exists (
      select 1 from xp_events x where x.user_quest_id = uq.id and x.event_key like 'quest-complete:%'
    ) then 'xp_state_mismatch'
    else null
  end as issue
from user_quests uq
left join users u on u.id = uq.user_id
left join quests q on q.id = uq.quest_id
left join lateral (
  select count(*) as n, min(rp.id) as id from relocation_plans rp where rp.user_id = uq.user_id
) candidates on true
left join relocation_plans p on p.id = coalesce(uq.plan_id, candidates.id);

commit;
