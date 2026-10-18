begin;

-- A notification is only a bounded wake-up hint for an already-bound local
-- payment/refund. No incoming amount/status/metadata/PII is stored or credited.
create table payment_notification_inbox (
  id uuid primary key,
  event text not null check(event in (
    'payment.succeeded','payment.canceled','payment.waiting_for_capture','refund.succeeded')),
  object_id uuid not null,
  payment_order_id uuid references payment_topup_orders(id),
  refund_id uuid references payment_refunds(id),
  merchant_id text not null check(merchant_id ~ '^[1-9][0-9]{0,19}$'),
  test boolean not null,
  status text not null default 'pending' check(status in ('pending','processing','processed')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_reason text check(last_reason in ('verification_failed','retry_required')),
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  unique(event,object_id,merchant_id,test),
  check((event like 'payment.%' and payment_order_id is not null and refund_id is null)
    or (event='refund.succeeded' and refund_id is not null and payment_order_id is null)),
  check((status='processing')=(lease_token is not null and lease_until is not null)),
  check((lease_token is null)=(lease_until is null)),
  check((status='processed')=(processed_at is not null))
);
create index payment_notification_due on payment_notification_inbox
  (merchant_id,test,next_attempt_at,created_at,id) where status<>'processed';

create function citygo_guard_payment_notification() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then
    if new.status<>'pending' or new.attempt_count<>0 or new.lease_token is not null
      or new.processed_at is not null or new.last_reason is not null then
      raise exception 'Notification starts pending' using errcode='23514';
    end if;
    if new.payment_order_id is not null then
      if not exists(select 1 from public.payment_topup_orders p
        where p.id=new.payment_order_id and p.provider_payment_id=new.object_id::text
          and p.merchant_id=new.merchant_id and p.test=new.test) then
        raise exception 'Notification has no bound local payment' using errcode='23514';
      end if;
    elsif not exists(select 1 from public.payment_refunds r
      where r.id=new.refund_id and r.provider_refund_id=new.object_id::text
        and r.merchant_id=new.merchant_id and r.test=new.test) then
      raise exception 'Notification has no bound local refund' using errcode='23514';
    end if;
  else
    if row(new.id,new.event,new.object_id,new.payment_order_id,new.refund_id,
        new.merchant_id,new.test,new.created_at) is distinct from
      row(old.id,old.event,old.object_id,old.payment_order_id,old.refund_id,
        old.merchant_id,old.test,old.created_at) or old.status='processed'
      or new.attempt_count not between old.attempt_count and old.attempt_count+1 then
      raise exception 'Notification identity and completed history are immutable' using errcode='23514';
    end if;
    if new.status='processing' and (new.attempt_count<>old.attempt_count+1
      or (old.status='processing' and old.lease_until>clock_timestamp())) then
      raise exception 'Notification claim requires an available lease' using errcode='23514';
    end if;
    if new.status in ('pending','processed') and old.status<>'processing' then
      raise exception 'Notification completion requires a claim' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger payment_notification_guard before insert or update on payment_notification_inbox
  for each row execute function citygo_guard_payment_notification();

revoke all on payment_notification_inbox from public;
revoke all on function citygo_guard_payment_notification() from public;

commit;
