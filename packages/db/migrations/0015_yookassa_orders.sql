begin;

-- Durable mutually exclusive database modes. Configuration alone cannot stop a
-- second API replica or a later restart from spending sandbox credits on AI.
alter table account_security_state
  add column test_payments_seen boolean not null default false,
  add column real_ai_admitted boolean not null default false;
update account_security_state set
  test_payments_seen=exists(select 1 from ai_credit_topups where test),
  real_ai_admitted=exists(select 1 from ai_model_attempts)
    or exists(select 1 from ai_credit_topups where not test)
  where id=1;
-- A pre-existing mixed database is unsafe: do not guess a balance conversion.
alter table account_security_state add constraint payment_modes_exclusive
  check (not(test_payments_seen and real_ai_admitted));

-- Test-only checkout orders. Applying the migration never enables the adapter,
-- creates a provider payment, or credits a balance.
create table payment_topup_orders (
  id uuid primary key,
  user_id bigint not null references users(id),
  request_id uuid not null,
  amount_kopeks integer not null check (amount_kopeks between 100 and 1000000),
  currency text not null default 'RUB' check (currency='RUB'),
  merchant_id text not null check (merchant_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  test boolean not null check (test),
  return_url text not null check (length(return_url) between 1 and 2048),
  create_payload jsonb not null check (jsonb_typeof(create_payload)='object'),
  provider_payment_id text unique check (provider_payment_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  status text not null default 'queued'
    check (status in ('queued','pending','canceled','succeeded','review_required')),
  confirmation_url text check (length(confirmation_url) between 1 and 2048),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(user_id,request_id),
  check ((status='queued' and provider_payment_id is null)
    or status='review_required'
    or (status in ('pending','canceled','succeeded') and provider_payment_id is not null))
);
create index payment_topup_orders_user on payment_topup_orders(user_id,created_at desc);

-- Defense in depth for provider observations: runtime cannot rewrite a request,
-- move a payment to another identity, or declare success without its posting.
-- Invoker privileges only; the API already has narrowly scoped SELECT/UPDATE.
create function citygo_guard_payment_topup_order() returns trigger
language plpgsql security invoker as $$
begin
  if row(new.id,new.user_id,new.request_id,new.amount_kopeks,new.currency,
      new.merchant_id,new.test,new.return_url,new.create_payload,new.created_at)
    is distinct from
    row(old.id,old.user_id,old.request_id,old.amount_kopeks,old.currency,
      old.merchant_id,old.test,old.return_url,old.create_payload,old.created_at) then
    raise exception 'Payment order identity is immutable' using errcode='23514';
  end if;
  if old.provider_payment_id is not null and new.provider_payment_id is distinct from old.provider_payment_id then
    raise exception 'Payment order provider identity is immutable' using errcode='23514';
  end if;
  if old.status in ('succeeded','canceled') and new.status<>old.status then
    raise exception 'Payment order terminal status is immutable' using errcode='23514';
  end if;
  if new.status='succeeded' and not exists(
    select 1 from ai_credit_topups p where p.operation_id=new.id and p.user_id=new.user_id
      and p.provider_payment_id=new.provider_payment_id and p.paid_kopeks=new.amount_kopeks
      and p.credited_micros=new.amount_kopeks::bigint*10000
      and p.merchant_id=new.merchant_id and p.test=new.test
  ) then
    raise exception 'Payment order has no matching posting' using errcode='23514';
  end if;
  if new.status='canceled' and exists(
    select 1 from ai_credit_topups p where p.operation_id=new.id and p.user_id=new.user_id
      and p.provider_payment_id=new.provider_payment_id and p.paid_kopeks=new.amount_kopeks
      and p.credited_micros=new.amount_kopeks::bigint*10000
      and p.merchant_id=new.merchant_id and p.test=new.test
  ) then
    raise exception 'Credited payment order cannot be canceled' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger payment_topup_order_guard before update on payment_topup_orders
  for each row execute function citygo_guard_payment_topup_order();

create function citygo_keep_payment_isolation() returns trigger
language plpgsql security invoker as $$
begin
  if (old.test_payments_seen and not new.test_payments_seen)
    or (old.real_ai_admitted and not new.real_ai_admitted) then
    if exists(select 1 from users) or exists(select 1 from ai_model_attempts)
      or exists(select 1 from payment_topup_orders) or exists(select 1 from ai_credit_topups)
      or not exists(select 1 from ai_budget where id=1 and not enabled) then
      raise exception 'Payment isolation is sticky until a full closed reset' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger payment_isolation_sticky before update on account_security_state
  for each row execute function citygo_keep_payment_isolation();

create function citygo_mark_payment_isolation() returns trigger
language plpgsql security invoker as $$
declare
  wanted_test boolean;
  previous account_security_state%rowtype;
begin
  if TG_TABLE_NAME='ai_credit_topups' then wanted_test=new.test;
  elsif TG_TABLE_NAME='payment_topup_orders' then wanted_test=true;
  else wanted_test=false;
  end if;
  select * into previous from account_security_state where id=1 for update;
  if not found then raise exception 'Payment isolation state is missing' using errcode='23514'; end if;
  if (wanted_test and previous.real_ai_admitted)
    or (not wanted_test and previous.test_payments_seen) then
    raise exception 'Test payments and real AI cannot share a database' using errcode='23514';
  end if;
  if wanted_test and not previous.test_payments_seen then
    update account_security_state set test_payments_seen=true where id=1;
  elsif not wanted_test and not previous.real_ai_admitted then
    update account_security_state set real_ai_admitted=true where id=1;
  end if;
  return new;
end;
$$;
create trigger payment_order_isolation before insert on payment_topup_orders
  for each row execute function citygo_mark_payment_isolation();
create trigger payment_topup_isolation before insert on ai_credit_topups
  for each row execute function citygo_mark_payment_isolation();
create trigger real_ai_isolation before insert on ai_model_attempts
  for each row execute function citygo_mark_payment_isolation();

commit;
