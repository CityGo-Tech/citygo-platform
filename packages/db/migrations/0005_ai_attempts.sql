begin;

-- Capacity reservations, not proof of network dispatch or provider billing.
-- No historical backfill: earlier attempts cannot be reconstructed reliably.
create table ai_model_attempt_daily (
  usage_day date primary key,
  reserved_attempts integer not null default 0 check (reserved_attempts >= 0),
  user_limit integer not null check (user_limit between 0 and 10000),
  global_limit integer not null check (global_limit between 0 and 1000000)
);
create table ai_user_model_attempt_daily (
  user_id bigint not null references users(id) on delete cascade,
  usage_day date not null,
  reserved_attempts integer not null default 0 check (reserved_attempts >= 0),
  primary key (user_id, usage_day)
);
create table ai_model_attempts (
  thread_id bigint not null,
  request_id uuid not null,
  attempt_number smallint not null check (attempt_number between 1 and 2),
  user_id bigint not null references users(id) on delete cascade,
  provider text not null check (provider in ('openai','routerai','gigachat')),
  model text not null check (length(model) > 0),
  policy_id text not null check (policy_id ~ '^[a-f0-9]{64}$'),
  routing_revision integer not null check (routing_revision > 0),
  reserved_at timestamptz not null default now(),
  primary key (thread_id, request_id, attempt_number),
  foreign key (thread_id, request_id) references chat_requests(thread_id, request_id) on delete cascade
);
create index ai_model_attempts_user_idx on ai_model_attempts (user_id);
create index ai_model_attempts_recent_idx on ai_model_attempts
  (reserved_at desc, thread_id desc, request_id desc, attempt_number desc);

commit;
