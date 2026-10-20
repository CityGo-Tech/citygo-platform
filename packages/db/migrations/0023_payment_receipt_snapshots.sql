begin;

-- Explicit operator-selected provider receipt profile; no merchant/tax-system
-- inference, provider call, backfill or live admission. Existing requests remain v1.
alter table payment_topup_orders
  add column payload_version smallint not null default 1 check(payload_version in (1,2)),
  add column receipt_email text,
  add column receipt_profile text,
  add constraint payment_topup_receipt_snapshot check(coalesce(
    (payload_version=1 and receipt_email is null and receipt_profile is null and not(create_payload?'receipt'))
    or(payload_version=2 and receipt_profile='citygo_service_full_payment_v1'
      and length(receipt_email) between 3 and 254
      and receipt_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and receipt_email !~ '[[:cntrl:]]'
      and lower(split_part(receipt_email,'@',2)) !~ '(^|\.)(invalid|localhost|test|example)$'
      and lower(split_part(receipt_email,'@',2)) !~ '(^|\.)example\.(com|net|org)$'
      and create_payload=jsonb_build_object(
        'amount',jsonb_build_object('value',(amount_kopeks/100)::text||'.'||lpad((amount_kopeks%100)::text,2,'0'),'currency','RUB'),
        'capture',true,'confirmation',jsonb_build_object('type','redirect','return_url',return_url),
        'metadata',jsonb_build_object('citygo_order_id',id::text),
        'description',case when test then 'Пополнение тестового баланса CityGo' else 'Пополнение баланса CityGo' end,
        'receipt',jsonb_build_object('customer',jsonb_build_object('email',receipt_email),
          'items',jsonb_build_array(jsonb_build_object(
            'description',case when test then 'Пополнение тестового баланса CityGo' else 'Пополнение баланса CityGo' end,
            'quantity','1.000','amount',jsonb_build_object('value',(amount_kopeks/100)::text||'.'||lpad((amount_kopeks%100)::text,2,'0'),'currency','RUB'),
            'vat_code',1,'payment_mode','full_payment','payment_subject','service','measure','piece'))))),false));

alter table payment_refunds
  add column payload_version smallint not null default 1 check(payload_version in (1,2)),
  add column receipt_email text,
  add column receipt_profile text,
  add constraint payment_refund_receipt_snapshot check(coalesce(
    (payload_version=1 and receipt_email is null and receipt_profile is null and not(create_payload?'receipt'))
    or(payload_version=2 and receipt_profile='citygo_service_full_payment_v1'
      and length(receipt_email) between 3 and 254
      and ((amount_kopeks=payment_amount_kopeks and not(create_payload?'receipt'))
        or(amount_kopeks<payment_amount_kopeks and create_payload->'receipt'->'customer'->>'email'=receipt_email))),false));

create function citygo_guard_payment_receipt_snapshot() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.payload_version,new.receipt_email,new.receipt_profile)
    is distinct from row(old.payload_version,old.receipt_email,old.receipt_profile) then
    raise exception 'Payment receipt snapshot is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger payment_topup_receipt_immutable before update on payment_topup_orders
  for each row execute function citygo_guard_payment_receipt_snapshot();
create trigger payment_refund_receipt_immutable before update on payment_refunds
  for each row execute function citygo_guard_payment_receipt_snapshot();

create function citygo_guard_refund_receipt_source() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
  checkout public.payment_topup_orders%rowtype;
  expected_receipt jsonb;
  expected_payload jsonb;
begin
  select * into checkout from public.payment_topup_orders where id=new.payment_operation_id;
  if found and checkout.payload_version=2 then
    expected_payload=jsonb_build_object('payment_id',new.provider_payment_id,
      'amount',jsonb_build_object('value',(new.amount_kopeks/100)::text||'.'||lpad((new.amount_kopeks%100)::text,2,'0'),'currency','RUB'),
      'description',case when new.test then 'Тестовый возврат CityGo' else 'Возврат средств CityGo' end,
      'metadata',jsonb_build_object('citygo_refund_id',new.id::text));
    if new.amount_kopeks<checkout.amount_kopeks then
      expected_receipt=jsonb_set(checkout.create_payload->'receipt','{items,0,amount,value}',
        to_jsonb((new.amount_kopeks/100)::text||'.'||lpad((new.amount_kopeks%100)::text,2,'0')),false);
      expected_payload=expected_payload||jsonb_build_object('receipt',expected_receipt);
    end if;
    if new.payload_version<>2 or new.receipt_email is distinct from checkout.receipt_email
      or new.receipt_profile is distinct from checkout.receipt_profile
      or new.user_id<>checkout.user_id or new.merchant_id<>checkout.merchant_id or new.test<>checkout.test
      or new.provider_payment_id is distinct from checkout.provider_payment_id
      or new.payment_amount_kopeks<>checkout.amount_kopeks
      or new.create_payload is distinct from expected_payload then
      raise exception 'Refund receipt differs from the immutable paid checkout' using errcode='23514';
    end if;
  elsif new.payload_version<>1 then
    raise exception 'Refund receipt requires its original checkout' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger payment_refund_receipt_source before insert on payment_refunds
  for each row execute function citygo_guard_refund_receipt_source();

-- For v2 use the immutable payer-selected address, never later account edits.
-- Legacy v1/manual postings retain their original account-email behaviour.
create or replace function citygo_guard_npd_receipt_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
  checkout public.payment_topup_orders%rowtype;
  expected_email text;
begin
  if TG_OP='INSERT' then
    select * into checkout from public.payment_topup_orders where id=new.id;
    if found and checkout.payload_version=2 then
      if checkout.user_id<>new.user_id or checkout.merchant_id<>new.merchant_id
        or checkout.test or checkout.amount_kopeks<>new.amount_kopeks
        or checkout.provider_payment_id is distinct from new.payment_id then
        raise exception 'Manual receipt checkout source mismatch' using errcode='23514';
      end if;
      expected_email=checkout.receipt_email;
    else
      select c.email into expected_email from public.user_credentials c where c.user_id=new.user_id;
    end if;
    if not exists(select 1 from public.ai_credit_topups p where p.operation_id=new.id
      and not p.test and p.user_id=new.user_id and p.provider_payment_id=new.payment_id
      and p.merchant_id=new.merchant_id and p.paid_kopeks=new.amount_kopeks
      and p.verified_at=new.observed_at)
      or new.buyer_email is distinct from expected_email then
      raise exception 'Manual receipt requires an exact live topup source' using errcode='23514';
    end if;
    if new.revision<>1 or new.cumulative_refunded_kopeks<>0 or new.claimed_by_user_id is not null
      or new.registration_status<>'pending' or new.delivery_status<>'pending'
      or new.correction_status<>'not_required' or new.active_evidence_id is not null or new.review_reason is not null then
      raise exception 'Manual receipt must start unreported' using errcode='23514';
    end if;
  else
    if row(new.id,new.user_id,new.payment_id,new.payment_provider,new.merchant_id,new.amount_kopeks,new.buyer_email,new.observed_at,new.created_at)
      is distinct from row(old.id,old.user_id,old.payment_id,old.payment_provider,old.merchant_id,old.amount_kopeks,old.buyer_email,old.observed_at,old.created_at)
      or new.revision<>old.revision+1 then
      raise exception 'Manual receipt identity/revision is immutable' using errcode='23514';
    end if;
    if old.claimed_by_user_id is not null and new.claimed_by_user_id is distinct from old.claimed_by_user_id then
      raise exception 'Manual receipt claim requires explicit recovery' using errcode='23514';
    end if;
  end if;
  if new.cumulative_refunded_kopeks<>(select coalesce(sum(r.amount_kopeks),0) from public.npd_refund_observations r where r.task_id=new.id) then
    raise exception 'Refund total does not match observations' using errcode='23514';
  end if;
  if new.registration_status='operator_reported' and (new.active_evidence_id is null or not exists(select 1 from public.npd_receipt_evidence e
    where e.task_id=new.id and e.kind='register' and e.amount_kopeks=new.amount_kopeks)) then
    raise exception 'Manual receipt registration requires evidence' using errcode='23514';
  end if;
  if (new.registration_status='pending' and (new.active_evidence_id is not null or new.delivery_status<>'pending'))
    or ((new.correction_status='not_required') is distinct from (new.cumulative_refunded_kopeks=0)) then
    raise exception 'Manual receipt state is inconsistent' using errcode='23514';
  end if;
  if new.correction_status='operator_reported' and not exists(select 1 from public.npd_receipt_evidence e
    where e.id=new.active_evidence_id and e.task_id=new.id and e.kind='correction'
      and e.refund_snapshot_kopeks=new.cumulative_refunded_kopeks and e.amount_kopeks=new.amount_kopeks-new.cumulative_refunded_kopeks) then
    raise exception 'Manual receipt correction requires current evidence' using errcode='23514';
  end if;
  if new.delivery_status='operator_reported' and (new.correction_status='required' or not exists(
    select 1 from public.npd_receipt_commands c where c.task_id=new.id and c.action='delivery'
      and c.payload->>'receiptEvidenceId'=new.active_evidence_id::text)) then
    raise exception 'Manual receipt delivery requires a separate report' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function citygo_create_npd_receipt_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
  checkout public.payment_topup_orders%rowtype;
  expected_email text;
begin
  if not new.test then
    select * into checkout from public.payment_topup_orders where id=new.operation_id;
    if found and checkout.payload_version=2 then
      if checkout.user_id<>new.user_id or checkout.merchant_id<>new.merchant_id
        or checkout.test or checkout.amount_kopeks<>new.paid_kopeks
        or checkout.provider_payment_id is distinct from new.provider_payment_id then
        raise exception 'Manual receipt checkout source mismatch' using errcode='23514';
      end if;
      expected_email=checkout.receipt_email;
    else
      select c.email into expected_email from public.user_credentials c where c.user_id=new.user_id;
    end if;
    insert into public.npd_receipt_tasks(id,user_id,payment_id,merchant_id,amount_kopeks,buyer_email,observed_at)
      values(new.operation_id,new.user_id,new.provider_payment_id,new.merchant_id,new.paid_kopeks,expected_email,new.verified_at);
  end if;
  return new;
end;
$$;

revoke all on function citygo_guard_payment_receipt_snapshot() from public;
revoke all on function citygo_guard_refund_receipt_source() from public;
commit;

