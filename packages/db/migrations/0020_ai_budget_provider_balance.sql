begin;

-- Existing budgets stay fixed and disabled/enabled exactly as before. No
-- migration authorizes spend or removes an operator/personal money limit.
alter table ai_budget
  add column mode text not null default 'fixed'
    check (mode in ('fixed','routerai_balance')),
  alter column daily_limit_micros drop not null,
  alter column total_limit_micros drop not null,
  drop constraint ai_budget_check,
  drop constraint ai_budget_check1,
  drop constraint ai_budget_check2,
  drop constraint ai_budget_total_reserved_micros_check;

alter table ai_budget
  add constraint ai_budget_mode_limits check (
    (mode='fixed' and daily_limit_micros is not null and total_limit_micros is not null
      and daily_limit_micros <= total_limit_micros
      and total_reserved_micros <= total_limit_micros
      and (not enabled or daily_limit_micros > 0))
    or (mode='routerai_balance' and currency is not null and currency='RUB'
      and daily_limit_micros is null and total_limit_micros is null)
  ),
  add constraint ai_budget_enabled_rule check (
    not enabled or (currency is not null and jsonb_array_length(rules)>0)
  ),
  -- Technical precision boundary for JSON/JavaScript counters, NOT a monetary
  -- allowance or an artificial replacement for an unlimited operator budget.
  add constraint ai_budget_reserved_safe_integer check (
    total_reserved_micros between 0 and 9007199254740991
  );

alter table ai_budget_daily
  drop constraint ai_budget_daily_reserved_micros_check,
  add constraint ai_budget_daily_reserved_safe_integer check (
    reserved_micros between 0 and 9007199254740991
  );

-- No new objects or privileges. Existing API grants remain unchanged.
commit;
