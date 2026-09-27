begin;

-- No automatic grants/backfill and no provider or paid top-up activation.
-- Fixed RUB micro-units; these balances are separate from operator budgets.
create table ai_credit_accounts (
  user_id bigint primary key references users(id),
  granted_micros bigint not null default 0 check (granted_micros in (0,500000000)),
  held_micros bigint not null default 0 check (held_micros >= 0),
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  check (held_micros + spent_micros <= granted_micros)
);
create table ai_credit_entries (
  id bigint generated always as identity primary key,
  user_id bigint not null references ai_credit_accounts(user_id),
  operation_id uuid not null unique,
  kind text not null check (kind in ('bonus','hold','settle','release')),
  amount_micros bigint not null check (amount_micros between 0 and 500000000),
  hold_id uuid references ai_credit_entries(operation_id),
  actor_user_id bigint references users(id),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (kind='bonus' and amount_micros=500000000 and hold_id is null and actor_user_id is not null)
    or (kind='hold' and amount_micros>0 and hold_id is null and actor_user_id is null)
    or (kind in ('settle','release') and hold_id is not null and actor_user_id is null)
  ),
  check (kind<>'release' or amount_micros=0)
);
create unique index ai_credit_one_bonus on ai_credit_entries(user_id) where kind='bonus';
create unique index ai_credit_one_resolution on ai_credit_entries(hold_id) where hold_id is not null;
create index ai_credit_history on ai_credit_entries(user_id,id desc);
create index ai_credit_actor on ai_credit_entries(actor_user_id) where actor_user_id is not null;

commit;
