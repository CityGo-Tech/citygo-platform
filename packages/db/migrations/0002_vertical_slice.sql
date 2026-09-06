begin;

create table user_credentials (
  user_id bigint primary key references users(id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  check (email = lower(email))
);
create table sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_id_idx on sessions(user_id);
create index sessions_expires_idx on sessions(expires_at);
alter table agent_threads add column busy_until timestamptz;
alter table agent_threads add column lease_token text;
create unique index one_open_thread_per_user on agent_threads(user_id) where status <> 'closed';
create table chat_requests (
  thread_id bigint not null references agent_threads(id) on delete cascade,
  request_id uuid not null,
  status text not null check(status in ('running','complete','interrupted')),
  primary key(thread_id, request_id)
);
create unique index quest_completion_once on xp_events(user_quest_id)
  where user_quest_id is not null and event_key like 'quest-complete:%';
create table analytics_events (
  id bigint generated always as identity primary key,
  user_id bigint references users(id) on delete set null,
  name text not null,
  created_at timestamptz not null default now()
);
create index analytics_events_name_created_idx on analytics_events(name, created_at);
insert into quests(slug,title,stage,xp_reward,definition) values
('housing-brief','Составить план поиска жилья','housing',60,'{"order":1,"next":"housing-viewing"}'),
('housing-viewing','Подготовиться к просмотру квартиры','housing',60,'{"order":2}');
commit;
