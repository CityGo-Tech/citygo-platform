begin;

-- Product fee and a confirmed free provider basis are different amounts.
-- This migration does not enable GigaChat, infer commercial rights, reprice an
-- old request, change RouterAI receipts or create credits/provider accounts.
create table gigachat_request_fees (
  hold_id uuid primary key references ai_credit_entries(operation_id),
  user_id bigint not null references ai_credit_accounts(user_id),
  thread_id bigint not null,
  request_id uuid not null,
  chat_lease uuid not null,
  attempt_number smallint not null default 1 check(attempt_number=1),
  catalog_id text not null check(catalog_id ~ '^[a-f0-9]{64}$'),
  pricing_id text not null check(pricing_id ~ '^[a-f0-9]{64}$'),
  account_ref text not null check(account_ref ~ '^[a-f0-9]{64}$'),
  execution_key text not null check(execution_key ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,
  lease_token uuid not null unique,
  expires_at timestamptz not null,
  state text not null default 'reserved' check(state in ('reserved','dispatched','succeeded','failed','expired')),
  response_message_id bigint unique references messages(id),
  served_model text,
  resolution_operation_id uuid unique references ai_credit_entries(operation_id),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  unique(thread_id,request_id),
  foreign key(thread_id,request_id,attempt_number) references ai_model_attempts(thread_id,request_id,attempt_number),
  foreign key(thread_id,request_id) references ai_request_modes(thread_id,request_id),
  check(expires_at>created_at and expires_at<=created_at+interval '330 seconds'),
  check((state in ('reserved','dispatched') and resolution_operation_id is null and resolved_at is null)
    or(state in ('succeeded','failed','expired') and resolution_operation_id is not null and resolved_at is not null)),
  check((state='succeeded' and response_message_id is not null and served_model is not null)
    or(state<>'succeeded' and response_message_id is null and served_model is null)),
  check(snapshot=jsonb_build_object('version','citygo-gigachat-flat3-success-v1',
    'provider','gigachat','mode','minimum','model','GigaChat-3-Ultra','scope','GIGACHAT_API_PERS',
    'feeCitygoMicros',3000000,'holdCitygoMicros',5000000,'operatorCostRubMicros',0,
    'pricingId',pricing_id,'accountRef',account_ref,'catalogId',catalog_id,'executionKey',execution_key))
);
create index gigachat_request_fees_user on gigachat_request_fees(user_id,created_at desc,hold_id);
create index gigachat_request_fees_pending on gigachat_request_fees(expires_at,hold_id) where state in ('reserved','dispatched');

create table gigachat_account_leases (
  account_ref text primary key check(account_ref ~ '^[a-f0-9]{64}$'),
  lease_token uuid unique references gigachat_request_fees(lease_token),
  hold_id uuid unique references gigachat_request_fees(hold_id),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((lease_token is null and hold_id is null and expires_at is null)
    or(lease_token is not null and hold_id is not null and expires_at is not null))
);

create function citygo_guard_gigachat_request_fee() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='DELETE' then raise exception 'GigaChat fee evidence is retained' using errcode='23514'; end if;
  if TG_OP='INSERT' then
    if new.state<>'reserved' or new.resolution_operation_id is not null or not exists(
      select 1 from public.ai_credit_entries h join public.ai_model_attempts a
        on a.thread_id=new.thread_id and a.request_id=new.request_id and a.attempt_number=1
      join public.ai_request_modes m on m.thread_id=a.thread_id and m.request_id=a.request_id
      join public.chat_requests r on r.thread_id=a.thread_id and r.request_id=a.request_id
      join public.agent_threads t on t.id=a.thread_id
      where h.operation_id=new.hold_id and h.user_id=new.user_id and h.kind='hold' and h.amount_micros=5000000
        and a.user_id=new.user_id and a.provider='gigachat' and a.model='GigaChat-3-Ultra'
        and a.money_currency is null and a.money_reserved_micros is null and a.money_rule_key is null and a.money_budget_revision is null
        and m.user_id=new.user_id and m.mode='minimum' and m.provider='gigachat' and m.model='GigaChat-3-Ultra'
        and m.catalog_id=new.catalog_id and m.execution_key=new.execution_key and m.policy_id=a.policy_id
        and r.status='running' and t.user_id=new.user_id and t.lease_token=new.chat_lease::text and t.busy_until>clock_timestamp()
    ) then raise exception 'GigaChat fee requires its exact frozen attempt and five CityGo hold' using errcode='23514'; end if;
  else
    if row(new.hold_id,new.user_id,new.thread_id,new.request_id,new.chat_lease,new.attempt_number,new.catalog_id,new.pricing_id,
      new.account_ref,new.execution_key,new.snapshot,new.lease_token,new.expires_at,new.created_at)
      is distinct from row(old.hold_id,old.user_id,old.thread_id,old.request_id,old.chat_lease,old.attempt_number,old.catalog_id,old.pricing_id,
      old.account_ref,old.execution_key,old.snapshot,old.lease_token,old.expires_at,old.created_at)
      or(old.state in ('succeeded','failed','expired') and to_jsonb(new) is distinct from to_jsonb(old))
      or(new.state='reserved' and old.state<>'reserved')
      or(new.state='dispatched' and old.state not in ('reserved','dispatched')) then
      raise exception 'GigaChat accepted fee and terminal outcome are immutable' using errcode='23514';
    end if;
    if new.state='succeeded' and (old.state<>'dispatched' or clock_timestamp()>=new.expires_at or not exists(
      select 1 from public.messages m join public.chat_requests r on r.thread_id=m.thread_id
      where m.id=new.response_message_id and m.thread_id=new.thread_id and r.request_id=new.request_id and r.status='complete'
        and m.role='assistant' and length(btrim(m.content))>0 and m.metadata->>'status'='complete'
        and m.metadata->>'source'='model' and m.metadata->>'requestId'=new.request_id::text
        and m.metadata->'generation'->>'provider'='gigachat'
        and m.metadata->'generation'->>'requestedModel'='GigaChat-3-Ultra'
        and m.metadata->'generation'->>'model'=new.served_model
        and new.served_model ~ '^GigaChat-3-Ultra(:[A-Za-z0-9._-]{1,100})?$'
    )) then raise exception 'GigaChat success fee requires the persisted complete answer' using errcode='23514'; end if;
    if old.state in ('reserved','dispatched') and new.state in ('dispatched','succeeded') and not exists(
      select 1 from public.gigachat_account_leases l where l.account_ref=new.account_ref and l.hold_id=new.hold_id
        and l.lease_token=new.lease_token and l.expires_at=new.expires_at and l.expires_at>clock_timestamp()
    ) then raise exception 'GigaChat dispatch requires its exact live account capacity lease' using errcode='23514'; end if;
    if new.state='expired' and clock_timestamp()<new.expires_at then
      raise exception 'A live GigaChat attempt cannot be expired' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger gigachat_request_fee_guard before insert or update or delete on gigachat_request_fees
  for each row execute function citygo_guard_gigachat_request_fee();

create function citygo_guard_gigachat_account_lease() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='DELETE' then raise exception 'GigaChat account lease identity is retained' using errcode='23514'; end if;
  if TG_OP='INSERT' then
    if new.lease_token is not null then raise exception 'New GigaChat capacity starts unleased' using errcode='23514'; end if;
  else
    if row(new.account_ref,new.created_at) is distinct from row(old.account_ref,old.created_at) then
      raise exception 'GigaChat account identity is immutable' using errcode='23514';
    end if;
    if old.lease_token is not null and new.lease_token is not null and
      row(new.lease_token,new.hold_id,new.expires_at) is distinct from row(old.lease_token,old.hold_id,old.expires_at) then
      raise exception 'GigaChat live lease cannot be replaced or extended' using errcode='23514';
    end if;
    if old.lease_token is not null and new.lease_token is null and not exists(
      select 1 from public.gigachat_request_fees f where f.hold_id=old.hold_id and f.lease_token=old.lease_token
        and(f.state='succeeded' or(f.state in ('failed','expired') and clock_timestamp()>=old.expires_at))
    ) then raise exception 'GigaChat unknown transport retains capacity until expiry' using errcode='23514'; end if;
    if old.lease_token is null and new.lease_token is not null and not exists(
      select 1 from public.gigachat_request_fees f where f.hold_id=new.hold_id and f.lease_token=new.lease_token
        and f.account_ref=new.account_ref and f.expires_at=new.expires_at and f.state='reserved' and f.expires_at>clock_timestamp()
    ) then raise exception 'GigaChat lease must bind its exact retained fee' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
create trigger gigachat_account_lease_guard before insert or update or delete on gigachat_account_leases
  for each row execute function citygo_guard_gigachat_account_lease();

create function citygo_check_gigachat_fee_conservation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare fee record; posting record;
begin
  if TG_TABLE_NAME='gigachat_request_fees' then
    select * into fee from public.gigachat_request_fees where hold_id=new.hold_id;
  else
    select * into fee from public.gigachat_request_fees where hold_id=coalesce(new.hold_id,new.operation_id);
  end if;
  if not found then return new; end if;
  select * into posting from public.ai_credit_entries where hold_id=fee.hold_id;
  if fee.state in ('reserved','dispatched') then
    if found then raise exception 'Pending GigaChat fee cannot have a balance resolution' using errcode='23514'; end if;
    if not exists(select 1 from public.gigachat_account_leases l where l.hold_id=fee.hold_id
      and l.account_ref=fee.account_ref and l.lease_token=fee.lease_token and l.expires_at=fee.expires_at) then
      raise exception 'Pending GigaChat fee requires its exact capacity lease' using errcode='23514';
    end if;
  elsif not found or posting.operation_id is distinct from fee.resolution_operation_id or posting.user_id<>fee.user_id
    or(fee.state='succeeded' and(posting.kind<>'settle' or posting.amount_micros<>3000000))
    or(fee.state in ('failed','expired') and(posting.kind<>'release' or posting.amount_micros<>0)) then
    raise exception 'GigaChat fee must have exactly its three CityGo success or zero error posting' using errcode='23514';
  end if;
  return new;
end;
$$;
create constraint trigger gigachat_request_fee_conservation after insert or update on gigachat_request_fees
  deferrable initially deferred for each row execute function citygo_check_gigachat_fee_conservation();
create constraint trigger gigachat_fee_posting_conservation after insert on ai_credit_entries
  deferrable initially deferred for each row execute function citygo_check_gigachat_fee_conservation();

commit;
