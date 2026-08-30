begin;

create table users (
  id bigint generated always as identity primary key,
  auth_subject text not null unique,
  status text not null default 'active' check (status in ('active', 'blocked', 'deleted')),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table relocation_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null unique references users(id) on delete cascade,
  origin_city text,
  target_city text not null,
  monthly_budget numeric(12, 2) check (monthly_budget is null or monthly_budget >= 0),
  move_target_date date,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table questionnaire_answers (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  question_key text not null,
  answer jsonb not null,
  answered_at timestamptz not null default current_timestamp,
  unique (user_id, question_key)
);

create table relocation_plans (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'archived')),
  plan jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (user_id, version)
);

create table quests (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null,
  stage text not null check (stage in ('profile', 'housing', 'work', 'documents', 'adaptation')),
  xp_reward integer not null check (xp_reward >= 0),
  definition jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table user_quests (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  quest_id bigint not null references quests(id),
  state text not null default 'locked' check (state in ('locked', 'available', 'in_progress', 'completed')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (user_id, quest_id),
  check (state <> 'completed' or completed_at is not null)
);

create table xp_events (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  user_quest_id bigint references user_quests(id) on delete set null,
  event_key text not null,
  points integer not null check (points > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  unique (user_id, event_key)
);

create table agent_threads (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  agent_key text not null,
  status text not null default 'open' check (status in ('open', 'closed', 'handoff')),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table messages (
  id bigint generated always as identity primary key,
  thread_id bigint not null references agent_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp
);

create table agent_handoffs (
  id bigint generated always as identity primary key,
  thread_id bigint not null references agent_threads(id) on delete cascade,
  from_agent_key text not null,
  to_agent_key text,
  reason text not null,
  requires_human boolean not null default false,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp
);

create table generated_artifacts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  thread_id bigint references agent_threads(id) on delete set null,
  kind text not null,
  storage_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp
);

create table knowledge_sources (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null,
  source_url text,
  status text not null default 'draft' check (status in ('draft', 'verified', 'retired')),
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  check (status <> 'verified' or verified_at is not null)
);

create table consent_events (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  consent_key text not null,
  action text not null check (action in ('granted', 'revoked')),
  policy_version text not null,
  occurred_at timestamptz not null default current_timestamp
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor_user_id bigint references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp
);

create index questionnaire_answers_user_id_idx on questionnaire_answers (user_id);
create index relocation_plans_user_id_idx on relocation_plans (user_id);
create index user_quests_quest_id_idx on user_quests (quest_id);
create index user_quests_active_idx on user_quests (user_id, updated_at)
  where state in ('available', 'in_progress');
create index xp_events_user_quest_id_idx on xp_events (user_quest_id)
  where user_quest_id is not null;
create index agent_threads_user_id_idx on agent_threads (user_id);
create index messages_thread_created_idx on messages (thread_id, created_at, id);
create index agent_handoffs_thread_id_idx on agent_handoffs (thread_id);
create index generated_artifacts_user_id_idx on generated_artifacts (user_id);
create index generated_artifacts_thread_id_idx on generated_artifacts (thread_id)
  where thread_id is not null;
create index consent_events_user_id_idx on consent_events (user_id);
create index audit_log_actor_user_id_idx on audit_log (actor_user_id)
  where actor_user_id is not null;
create index audit_log_entity_idx on audit_log (entity_type, entity_id, created_at);

commit;
