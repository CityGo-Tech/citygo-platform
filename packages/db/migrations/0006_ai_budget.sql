begin;

-- No prices or positive allowance are inferred by a migration.
create table ai_budget (
  id smallint primary key check (id=1),
  revision integer not null default 1 check (revision > 0),
  enabled boolean not null default false,
  currency text check (currency in ('RUB','USD')),
  daily_limit_micros bigint not null default 0 check (daily_limit_micros between 0 and 1000000000000),
  total_limit_micros bigint not null default 0 check (total_limit_micros between 0 and 1000000000000),
  total_reserved_micros bigint not null default 0 check (total_reserved_micros between 0 and 1000000000000),
  rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules)='array' and jsonb_array_length(rules)<=3),
  check (daily_limit_micros <= total_limit_micros),
  check (total_reserved_micros <= total_limit_micros),
  check (not enabled or (currency is not null and daily_limit_micros > 0 and jsonb_array_length(rules)>0))
);
insert into ai_budget(id) values (1);
create table ai_budget_daily (
  usage_day date primary key,
  reserved_micros bigint not null default 0 check (reserved_micros between 0 and 1000000000000)
);

-- Existing attempts remain unpriced. Never backfill them as zero-cost.
alter table ai_model_attempts
  add column money_currency text,
  add column money_reserved_micros bigint,
  add column money_budget_revision integer,
  add column money_rule_key text,
  add constraint ai_attempt_money_snapshot check (
    (money_currency is null and money_reserved_micros is null and money_budget_revision is null and money_rule_key is null)
    or (money_currency is not null and money_reserved_micros is not null and money_budget_revision is not null and money_rule_key is not null
      and money_currency in ('RUB','USD') and money_reserved_micros between 1 and 1000000000000
      and money_budget_revision>0 and money_rule_key ~ '^[a-f0-9]{64}$')
  );
create index audit_ai_budget_recent_idx on audit_log(id desc) where entity_type='ai-budget' and entity_id='1';

commit;
