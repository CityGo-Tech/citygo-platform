begin;

-- CG-012A: inactive storage foundation. No backfill, seeds, runtime grants,
-- endpoints, confirmation or XP changes. Old records remain untouched.
create table r1_housing_briefs (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  plan_id bigint not null,
  plan_version integer not null check (plan_version > 0),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (plan_id, user_id, plan_version)
    references relocation_plans(id, user_id, version)
);
create index r1_housing_briefs_owner_idx on r1_housing_briefs(user_id, id);
create index r1_housing_briefs_plan_idx on r1_housing_briefs(plan_id, user_id, plan_version);

create table r1_housing_commands (
  user_id bigint not null references users(id) on delete cascade,
  command_id uuid not null,
  event_id uuid not null unique,
  action text not null check (action in ('create_brief', 'state_answer')),
  actor text not null check (actor = 'user'),
  source text not null check (source = 'explicit_command'),
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  brief_id bigint not null,
  result_revision integer not null check (result_revision > 0),
  field text,
  before_answer jsonb,
  after_answer jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, command_id),
  unique (event_id, brief_id, result_revision),
  foreign key (brief_id, user_id) references r1_housing_briefs(id, user_id) on delete cascade,
  check (
    (action = 'create_brief' and result_revision = 1 and field is null and before_answer is null and after_answer is null)
    or (action = 'state_answer' and result_revision > 1 and field is not null
      and before_answer is not null and after_answer is not null
      and jsonb_typeof(before_answer) = 'object' and jsonb_typeof(after_answer) = 'object')
  )
);
create index r1_housing_commands_brief_idx on r1_housing_commands(brief_id, user_id);

create table r1_housing_brief_revisions (
  brief_id bigint not null references r1_housing_briefs(id) on delete cascade,
  revision integer not null check (revision > 0),
  event_id uuid not null unique,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null default now(),
  primary key (brief_id, revision),
  unique (brief_id, revision, event_id),
  foreign key (event_id, brief_id, revision)
    references r1_housing_commands(event_id, brief_id, result_revision)
);
-- A committed command always points to its own persisted result, not latest.
alter table r1_housing_commands add constraint r1_housing_command_result_fk
  foreign key (brief_id, result_revision, event_id)
    references r1_housing_brief_revisions(brief_id, revision, event_id)
  deferrable initially deferred;

create function citygo_keep_housing_history() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $immutable$
begin
  raise exception 'CG012_IMMUTABLE_HISTORY' using errcode = '23514';
end
$immutable$;
revoke all on function citygo_keep_housing_history() from public;
create trigger r1_housing_briefs_immutable before update on r1_housing_briefs
  for each row execute function citygo_keep_housing_history();
create trigger r1_housing_commands_immutable before update on r1_housing_commands
  for each row execute function citygo_keep_housing_history();
create trigger r1_housing_revisions_immutable before update on r1_housing_brief_revisions
  for each row execute function citygo_keep_housing_history();
-- No runtime role receives access here. Future lifecycle deletion is separate
-- from editing history; do not add a blanket delete trigger blocking erasure.

commit;
