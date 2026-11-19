begin;

create table housing_workspace_plans (
  user_id bigint not null references users(id) on delete cascade,
  revision int not null check (revision > 0),
  thread_id bigint not null references agent_threads(id) on delete cascade,
  situation text not null check (situation in ('searching','oriented','direct')),
  city text not null check (char_length(city) <= 100),
  commute text not null check (char_length(commute) <= 100),
  budget_rub int check (budget_rub between 1 and 99999999),
  request_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id,revision),
  unique (user_id,request_id)
);
create index housing_workspace_plans_thread_idx on housing_workspace_plans(thread_id);

create table housing_workspace_checklists (
  user_id bigint not null,
  revision int not null check (revision > 0),
  plan_revision int not null,
  selected text[] not null check (
    cardinality(selected) <= 3
    and selected <@ array['payment','contract','inspection']::text[]
  ),
  payment_checked boolean not null,
  request_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id,revision),
  unique (user_id,request_id),
  foreign key (user_id,plan_revision) references housing_workspace_plans(user_id,revision) on delete cascade
);
create index housing_workspace_checklists_plan_idx on housing_workspace_checklists(user_id,plan_revision);

commit;
