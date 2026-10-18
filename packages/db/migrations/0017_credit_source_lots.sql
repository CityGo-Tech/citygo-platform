begin;

alter table ai_credit_accounts add column billing_review_required boolean not null default false;
create table credit_source_lots (
  id uuid primary key,
  user_id bigint not null references ai_credit_accounts(user_id),
  kind text not null check(kind in ('gift','paid','legacy_nonrefundable')),
  source_operation_id uuid unique references ai_credit_entries(operation_id),
  source_entry_id bigint references ai_credit_entries(id),
  paid_operation_id uuid unique references ai_credit_topups(operation_id),
  provider_payment_id text,
  merchant_id text,
  test boolean,
  gross_micros bigint not null check(gross_micros between 1 and 10000000000000),
  spent_micros bigint not null default 0 check(spent_micros>=0),
  held_micros bigint not null default 0 check(held_micros>=0),
  refund_reserved_micros bigint not null default 0 check(refund_reserved_micros>=0),
  refunded_micros bigint not null default 0 check(refunded_micros>=0 and refunded_micros%10000=0),
  created_at timestamptz not null default clock_timestamp(),
  check(spent_micros+held_micros+refund_reserved_micros+refunded_micros<=gross_micros),
  check((kind='paid' and source_operation_id is not null and paid_operation_id is not null
    and source_operation_id=paid_operation_id and source_entry_id is not null
    and provider_payment_id is not null and merchant_id is not null and test is not null)
    or(kind='gift' and source_operation_id is not null and source_entry_id is not null and paid_operation_id is null
      and provider_payment_id is null and merchant_id is null and test is null)
    or(kind='legacy_nonrefundable' and source_operation_id is null and source_entry_id is null and paid_operation_id is null
      and provider_payment_id is null and merchant_id is null and test is null))
);
create index credit_source_lots_user on credit_source_lots(user_id,source_entry_id,id);
create unique index credit_source_one_legacy on credit_source_lots(user_id) where kind='legacy_nonrefundable';
create table credit_hold_allocations (
  hold_id uuid not null references ai_credit_entries(operation_id),
  source_lot_id uuid not null references credit_source_lots(id),
  ordinal integer not null check(ordinal>=0),
  reserved_micros bigint not null check(reserved_micros between 1 and 10000000000000),
  spent_micros bigint not null default 0 check(spent_micros between 0 and reserved_micros),
  state text not null default 'reserved' check(state in ('reserved','settled','released')),
  primary key(hold_id,source_lot_id),unique(hold_id,ordinal),
  check(state='settled' or spent_micros=0)
);
create index credit_hold_allocations_lot on credit_hold_allocations(source_lot_id);
create table credit_refund_allocations (
  refund_id uuid primary key,
  user_id bigint not null references ai_credit_accounts(user_id),
  source_lot_id uuid not null references credit_source_lots(id),
  amount_micros bigint not null check(amount_micros between 10000 and 10000000000000 and amount_micros%10000=0),
  refunded_before_kopeks bigint not null check(refunded_before_kopeks between 0 and 1000000000),
  state text not null default 'reserved' check(state in ('reserved','settled','released')),
  created_at timestamptz not null default clock_timestamp()
);
create index credit_refund_allocations_lot on credit_refund_allocations(source_lot_id);
create unique index credit_refund_one_reserved on credit_refund_allocations(source_lot_id) where state='reserved';

-- Conservative historical projection. Historical top-up proofs are not proof
-- of which source financed an old hold/spend: no refundable paid backfill.
insert into credit_source_lots(id,user_id,kind,gross_micros,spent_micros,held_micros)
  select gen_random_uuid(),user_id,'legacy_nonrefundable',granted_micros,spent_micros,held_micros
    from ai_credit_accounts where granted_micros>0;
update ai_credit_accounts a set billing_review_required=true where a.held_micros<>(
  select coalesce(sum(e.amount_micros),0) from ai_credit_entries e
  where e.user_id=a.user_id and e.kind='hold'
    and not exists(select 1 from ai_credit_entries r where r.hold_id=e.operation_id));
insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros)
  select e.operation_id,l.id,0,e.amount_micros from ai_credit_entries e
    join ai_credit_accounts a on a.user_id=e.user_id
    join credit_source_lots l on l.user_id=a.user_id and l.kind='legacy_nonrefundable'
    where e.kind='hold' and not a.billing_review_required
      and not exists(select 1 from ai_credit_entries r where r.hold_id=e.operation_id);

create function citygo_guard_credit_source_lot() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then
    if new.spent_micros<>0 or new.held_micros<>0 or new.refund_reserved_micros<>0 or new.refunded_micros<>0 then
      raise exception 'New source lots must be unused' using errcode='23514';
    end if;
    if new.kind='gift' then
      if not exists(select 1 from public.ai_credit_entries e where e.operation_id=new.source_operation_id
        and e.id=new.source_entry_id and e.user_id=new.user_id and e.kind='bonus' and e.amount_micros=new.gross_micros) then
        raise exception 'Gift source does not match its posting' using errcode='23514';
      end if;
    elsif new.kind='paid' then
      if not exists(select 1 from public.ai_credit_topups p join public.ai_credit_entries e on e.operation_id=p.operation_id
        where p.operation_id=new.paid_operation_id and e.id=new.source_entry_id and p.user_id=new.user_id
          and e.kind='topup' and e.user_id=new.user_id and e.amount_micros=new.gross_micros and p.credited_micros=new.gross_micros
          and p.provider_payment_id=new.provider_payment_id and p.merchant_id=new.merchant_id and p.test=new.test) then
        raise exception 'Paid source does not match its verified posting' using errcode='23514';
      end if;
    else raise exception 'Historical lots can only be created by migration' using errcode='23514';
    end if;
  elsif row(new.id,new.user_id,new.kind,new.source_operation_id,new.source_entry_id,new.paid_operation_id,new.provider_payment_id,new.merchant_id,new.test,new.gross_micros,new.created_at)
    is distinct from row(old.id,old.user_id,old.kind,old.source_operation_id,old.source_entry_id,old.paid_operation_id,old.provider_payment_id,old.merchant_id,old.test,old.gross_micros,old.created_at) then
    raise exception 'Source identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger credit_source_lot_guard before insert or update on credit_source_lots
  for each row execute function citygo_guard_credit_source_lot();
create function citygo_create_credit_gift_lot() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.kind='bonus' then
    insert into public.credit_source_lots(id,user_id,kind,source_operation_id,source_entry_id,gross_micros)
      values(new.operation_id,new.user_id,'gift',new.operation_id,new.id,new.amount_micros);
  end if;
  return new;
end;
$$;
create trigger credit_gift_lot after insert on ai_credit_entries for each row execute function citygo_create_credit_gift_lot();
create function citygo_create_credit_paid_lot() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  insert into public.credit_source_lots(id,user_id,kind,source_operation_id,source_entry_id,paid_operation_id,provider_payment_id,merchant_id,test,gross_micros)
    select new.operation_id,new.user_id,'paid',new.operation_id,e.id,new.operation_id,new.provider_payment_id,new.merchant_id,new.test,new.credited_micros
      from public.ai_credit_entries e where e.operation_id=new.operation_id;
  return new;
end;
$$;
create trigger credit_paid_lot after insert on ai_credit_topups for each row execute function citygo_create_credit_paid_lot();

create function citygo_guard_credit_allocation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then
    if TG_TABLE_NAME='credit_hold_allocations' then
      if new.state<>'reserved' or new.spent_micros<>0 or not exists(
        select 1 from public.ai_credit_entries e join public.credit_source_lots l on l.user_id=e.user_id
        where e.operation_id=new.hold_id and e.kind='hold' and l.id=new.source_lot_id
          and e.amount_micros>=new.reserved_micros) then
        raise exception 'AI source allocation does not match its hold' using errcode='23514';
      end if;
    elsif new.state<>'reserved' or not exists(
      select 1 from public.credit_source_lots l where l.id=new.source_lot_id and l.kind='paid'
        and l.user_id=new.user_id and l.refunded_micros/10000=new.refunded_before_kopeks) then
      raise exception 'Refund allocation requires an unused verified paid source' using errcode='23514';
    end if;
    return new;
  end if;
  if TG_TABLE_NAME='credit_hold_allocations' then
    if row(new.hold_id,new.source_lot_id,new.ordinal,new.reserved_micros) is distinct from row(old.hold_id,old.source_lot_id,old.ordinal,old.reserved_micros)
      or(old.state<>'reserved' and row(new.state,new.spent_micros) is distinct from row(old.state,old.spent_micros)) then
      raise exception 'AI source allocation is immutable after resolution' using errcode='23514';
    end if;
  elsif row(new.refund_id,new.user_id,new.source_lot_id,new.amount_micros,new.refunded_before_kopeks,new.created_at)
    is distinct from row(old.refund_id,old.user_id,old.source_lot_id,old.amount_micros,old.refunded_before_kopeks,old.created_at)
    or(old.state<>'reserved' and new.state<>old.state) then
    raise exception 'Refund source allocation is immutable after resolution' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger credit_hold_allocation_guard before insert or update on credit_hold_allocations for each row execute function citygo_guard_credit_allocation();
create trigger credit_refund_allocation_guard before insert or update on credit_refund_allocations for each row execute function citygo_guard_credit_allocation();

commit;
