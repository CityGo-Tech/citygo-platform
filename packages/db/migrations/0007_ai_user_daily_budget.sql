begin;

-- Add a personal reservation ceiling without enabling or extending any budget.
-- NULL preserves existing deployments; zero explicitly blocks personal reserves.
alter table ai_budget add column user_daily_limit_micros bigint
  check (user_daily_limit_micros between 0 and 1000000000000);

-- Reuse the immutable priced-attempt ledger: existing reservations already count.
-- Historical unpriced attempts remain unknown; never invent zero-cost backfills.
create index ai_model_attempts_user_money_day_idx
  on ai_model_attempts (user_id, reserved_at)
  where money_reserved_micros is not null;

commit;
