begin;

-- Monetary requests, separate from receipt/correction operator reports.
create table payment_refunds (
  id uuid primary key,
  request_id uuid not null unique,
  created_by_user_id bigint not null references users(id),
  user_id bigint not null references ai_credit_accounts(user_id),
  payment_operation_id uuid not null references ai_credit_topups(operation_id),
  provider_payment_id text not null,
  merchant_id text not null,
  test boolean not null,
  amount_kopeks bigint not null check(amount_kopeks between 100 and 1000000000),
  payment_amount_kopeks bigint not null check(payment_amount_kopeks between 100 and 1000000000),
  refunded_before_kopeks bigint not null check(refunded_before_kopeks>=0),
  create_key uuid not null check(create_key=id),
  create_payload jsonb not null check(jsonb_typeof(create_payload)='object' and coalesce(
    create_payload->>'payment_id'=provider_payment_id
    and create_payload->'metadata'->>'citygo_refund_id'=id::text
    and create_payload->'amount'->>'currency'='RUB'
    and create_payload->'amount'->>'value'=(amount_kopeks/100)::text||'.'||lpad((amount_kopeks%100)::text,2,'0'),false)),
  status text not null default 'reserved' check(status in ('reserved','unknown','pending','succeeded','canceled','review_required')),
  provider_refund_id text unique,
  revision integer not null default 1 check(revision>=1),
  attempt_count integer not null default 0 check(attempt_count>=0),
  last_attempt_at timestamptz,
  dispatch_token uuid,
  dispatch_lease_until timestamptz,
  review_reason text check(review_reason is null or review_reason in (
    'dispatch_result_unknown','provider_transport_failure','provider_request_rejected',
    'provider_mismatch','provider_refund_conflict','payment_mismatch','manual_review_required',
    'replay_window_expired','configuration_mismatch','external_refund_drift')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(amount_kopeks+refunded_before_kopeks<=payment_amount_kopeks),
  check((dispatch_token is null)=(dispatch_lease_until is null)),
  check(status not in ('succeeded','canceled') or provider_refund_id is not null)
);
create unique index payment_refund_one_open_source on payment_refunds(payment_operation_id)
  where status not in ('succeeded','canceled');
create index payment_refunds_owner on payment_refunds(user_id,created_at desc,id desc);
create index payment_refunds_queue on payment_refunds(status,created_at desc,id desc);

create table payment_refund_events (
  sequence bigint generated always as identity primary key,
  refund_id uuid not null references payment_refunds(id),
  action text not null check(action in ('reserved','dispatch_started','provider_observed','review_required','dispatch_failed')),
  actor_user_id bigint references users(id),
  revision integer not null check(revision>=1),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(refund_id,revision)
);
create index payment_refund_events_refund on payment_refund_events(refund_id,sequence desc);

create function guard_payment_refund_identity() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then
    if new.status<>'reserved' or new.provider_refund_id is not null or new.revision<>1
      or new.attempt_count<>0 or new.dispatch_token is not null or new.review_reason is not null then
      raise exception 'Refunds start with a paid reservation, not an external status' using errcode='23514';
    end if;
    if not exists(select 1 from public.ai_credit_topups p
      join public.credit_refund_allocations a on a.refund_id=new.id and a.user_id=p.user_id
      join public.credit_source_lots l on l.id=a.source_lot_id and l.paid_operation_id=p.operation_id
      where p.operation_id=new.payment_operation_id and p.user_id=new.user_id
        and p.provider_payment_id=new.provider_payment_id and p.merchant_id=new.merchant_id and p.test=new.test
        and p.paid_kopeks=new.payment_amount_kopeks and a.state='reserved'
        and a.amount_micros=new.amount_kopeks*10000 and a.refunded_before_kopeks=new.refunded_before_kopeks) then
      raise exception 'Refund identity does not match its reserved verified source' using errcode='23514';
    end if;
  else
    if row(new.id,new.request_id,new.created_by_user_id,new.user_id,new.payment_operation_id,
      new.provider_payment_id,new.merchant_id,new.test,new.amount_kopeks,new.payment_amount_kopeks,new.refunded_before_kopeks,new.create_key,new.create_payload,new.created_at)
      is distinct from row(old.id,old.request_id,old.created_by_user_id,old.user_id,old.payment_operation_id,
      old.provider_payment_id,old.merchant_id,old.test,old.amount_kopeks,old.payment_amount_kopeks,old.refunded_before_kopeks,old.create_key,old.create_payload,old.created_at)
      or (old.provider_refund_id is not null and new.provider_refund_id is distinct from old.provider_refund_id)
      or (old.status in ('succeeded','canceled') and new.status<>old.status)
      or new.revision<>old.revision+1 then
      raise exception 'Refund source, external identity and terminal result are immutable' using errcode='23514';
    end if;
  end if;
  if not exists(select 1 from public.credit_refund_allocations a where a.refund_id=new.id
    and a.state=case new.status when 'succeeded' then 'settled' when 'canceled' then 'released' else 'reserved' end) then
    raise exception 'Refund journal and monetary reservation must resolve together' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger payment_refund_identity before insert or update on payment_refunds
  for each row execute function guard_payment_refund_identity();

create function guard_payment_refund_event_immutable() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  raise exception 'Refund monetary history is append only' using errcode='23514';
end;
$$;
create trigger payment_refund_event_immutable before update or delete on payment_refund_events
  for each row execute function guard_payment_refund_event_immutable();

commit;
