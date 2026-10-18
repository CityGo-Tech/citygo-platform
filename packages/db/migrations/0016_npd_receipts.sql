begin;

-- No backfill, live activation or fiscal API call. Only NEW verified live
-- top-up postings create original manual obligations in the same transaction.
create table npd_receipt_tasks (
  id uuid primary key references ai_credit_topups(operation_id),
  user_id bigint not null references users(id),
  payment_id text not null unique,
  payment_provider text not null default 'yookassa' check(payment_provider='yookassa'),
  merchant_id text not null,
  amount_kopeks bigint not null check(amount_kopeks between 1 and 1000000000),
  buyer_email text,
  observed_at timestamptz not null,
  cumulative_refunded_kopeks bigint not null default 0 check(cumulative_refunded_kopeks between 0 and amount_kopeks),
  revision integer not null default 1 check(revision>0),
  claimed_by_user_id bigint references users(id),
  registration_status text not null default 'pending' check(registration_status in ('pending','operator_reported')),
  delivery_status text not null default 'pending' check(delivery_status in ('pending','operator_reported')),
  correction_status text not null default 'not_required' check(correction_status in ('not_required','required','operator_reported')),
  active_evidence_id uuid,
  review_reason text check(review_reason in ('registration_uncertain','delivery_uncertain','correction_uncertain')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index npd_receipt_tasks_owner on npd_receipt_tasks(user_id,created_at desc,id desc);
create index npd_receipt_tasks_queue on npd_receipt_tasks(created_at desc,id desc);
create table npd_receipt_commands (
  request_id uuid primary key,
  task_id uuid not null references npd_receipt_tasks(id),
  actor_user_id bigint not null references users(id),
  action text not null check(action in ('claim','register','delivery','review','correction')),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
  result_revision integer not null check(result_revision>0),
  created_at timestamptz not null default clock_timestamp()
);
create index npd_receipt_commands_history on npd_receipt_commands(task_id,created_at desc,request_id);
create table npd_receipt_evidence (
  id uuid primary key references npd_receipt_commands(request_id),
  task_id uuid not null references npd_receipt_tasks(id),
  kind text not null check(kind in ('register','correction')),
  receipt_id text unique check(receipt_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  receipt_url text,
  amount_kopeks bigint not null check(amount_kopeks between 0 and 1000000000),
  evidence_url text not null,
  refund_snapshot_kopeks bigint not null check(refund_snapshot_kopeks between 0 and 1000000000),
  created_at timestamptz not null default clock_timestamp(),
  check((receipt_id is null and receipt_url is null and amount_kopeks=0 and kind='correction')
    or(receipt_id is not null and receipt_url is not null and amount_kopeks>0)),
  unique(id,task_id)
);
create unique index npd_receipt_one_original on npd_receipt_evidence(task_id) where kind='register';
create unique index npd_receipt_one_correction_snapshot on npd_receipt_evidence(task_id,refund_snapshot_kopeks) where kind='correction';
alter table npd_receipt_tasks add constraint npd_task_evidence_owner
  foreign key(active_evidence_id,id) references npd_receipt_evidence(id,task_id);
create table npd_refund_observations (
  id uuid not null unique,
  provider_refund_id text primary key check(provider_refund_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  task_id uuid not null references npd_receipt_tasks(id),
  amount_kopeks bigint not null check(amount_kopeks between 1 and 1000000000),
  observed_at timestamptz not null,
  result_revision integer not null check(result_revision>0),
  created_at timestamptz not null default clock_timestamp()
);
create index npd_refund_observations_task on npd_refund_observations(task_id,created_at desc);

create function citygo_guard_npd_receipt_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then
    if not exists(select 1 from public.ai_credit_topups p where p.operation_id=new.id
      and not p.test and p.user_id=new.user_id and p.provider_payment_id=new.payment_id
      and p.merchant_id=new.merchant_id and p.paid_kopeks=new.amount_kopeks
      and p.verified_at=new.observed_at)
      or new.buyer_email is distinct from (select c.email from public.user_credentials c where c.user_id=new.user_id) then
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
create trigger npd_receipt_task_guard before insert or update on npd_receipt_tasks
  for each row execute function citygo_guard_npd_receipt_task();

create function citygo_create_npd_receipt_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if not new.test then
    insert into public.npd_receipt_tasks(id,user_id,payment_id,merchant_id,amount_kopeks,buyer_email,observed_at)
      select new.operation_id,new.user_id,new.provider_payment_id,new.merchant_id,new.paid_kopeks,c.email,new.verified_at
      from (select 1) seed left join public.user_credentials c on c.user_id=new.user_id;
  end if;
  return new;
end;
$$;
create trigger npd_live_topup_obligation after insert on ai_credit_topups
  for each row execute function citygo_create_npd_receipt_task();

create function citygo_apply_npd_refund_observation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  update public.npd_receipt_tasks set
    cumulative_refunded_kopeks=(select sum(amount_kopeks) from public.npd_refund_observations where task_id=new.task_id),
    correction_status='required',delivery_status='pending',revision=revision+1,updated_at=clock_timestamp()
    where id=new.task_id and revision+1=new.result_revision;
  if not found then raise exception 'Refund observation revision changed' using errcode='23514'; end if;
  return new;
end;
$$;
create trigger npd_refund_observation_apply after insert on npd_refund_observations
  for each row execute function citygo_apply_npd_refund_observation();

commit;
