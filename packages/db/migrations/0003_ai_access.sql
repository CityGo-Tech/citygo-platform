begin;

-- No backfill: the old generic questionnaire checkbox grants no recipient access.
create table ai_consents (
  user_id bigint primary key references users(id) on delete cascade,
  policy_id text not null check (policy_id ~ '^[a-f0-9]{64}$'),
  granted boolean not null,
  updated_at timestamptz not null default current_timestamp
);
alter table consent_events add column details jsonb not null default '{}'::jsonb;
alter table chat_requests add column ai_policy_id text;

create table ai_usage_daily (
  usage_day date primary key,
  accepted_requests integer not null default 0 check (accepted_requests >= 0)
);
create table ai_user_usage_daily (
  user_id bigint not null references users(id) on delete cascade,
  usage_day date not null,
  accepted_requests integer not null default 0 check (accepted_requests >= 0),
  primary key (user_id, usage_day)
);

commit;
