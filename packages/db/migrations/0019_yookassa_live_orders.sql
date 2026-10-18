begin;

-- Allow a separately configured live adapter without rewriting historical test
-- orders, payment proofs or balances. This migration does not activate a shop,
-- contact YooKassa, clear the sticky database mode or issue any credit.
alter table payment_topup_orders drop constraint payment_topup_orders_test_check;

-- Orders now choose the same durable mode as their immutable verified posting.
-- Test checkout remains incompatible with real checkout/AI in either direction,
-- including direct INSERTs and races across API replicas. Reuse the singleton
-- row lock; do not introduce elevated privileges or a mode-reset escape hatch.
create or replace function citygo_mark_payment_isolation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
  wanted_test boolean;
  previous public.account_security_state%rowtype;
begin
  if TG_TABLE_NAME in ('ai_credit_topups','payment_topup_orders') then
    wanted_test=new.test;
  else
    wanted_test=false;
  end if;
  select * into previous from public.account_security_state where id=1 for update;
  if not found then raise exception 'Payment isolation state is missing' using errcode='23514'; end if;
  if (wanted_test and previous.real_ai_admitted)
    or (not wanted_test and previous.test_payments_seen) then
    raise exception 'Test payments and real AI cannot share a database' using errcode='23514';
  end if;
  if wanted_test and not previous.test_payments_seen then
    update public.account_security_state set test_payments_seen=true where id=1;
  elsif not wanted_test and not previous.real_ai_admitted then
    update public.account_security_state set real_ai_admitted=true where id=1;
  end if;
  return new;
end;
$$;

commit;
