begin;

-- Existing attempts remain fully prepaid. Nothing here activates a new mode.
alter table ai_credit_charges add column reservation_mode text not null default 'full'
  check(reservation_mode in ('full','fixed5_overdraft'));
alter table ai_credit_charges add constraint ai_credit_fixed5_scope check (
  reservation_mode='full' or (tariff_snapshot->>'version'='citygo-10x-v1'
    and real_ceiling_micros between 500000 and 6000000)
);
alter table ai_credit_accounts drop constraint ai_credit_accounts_check;
alter table ai_credit_accounts add constraint ai_credit_bounded_overdraft check (
  held_micros+spent_micros<=granted_micros+55000000
);

create table credit_charge_debts (
  hold_id uuid primary key references ai_credit_charges(hold_id),
  user_id bigint not null references ai_credit_accounts(user_id),
  principal_micros bigint not null check(principal_micros between 1 and 55000000),
  created_at timestamptz not null default clock_timestamp()
);
create index credit_charge_debts_user on credit_charge_debts(user_id,created_at,hold_id);
create table credit_debt_repayments (
  id uuid primary key,
  debt_hold_id uuid not null references credit_charge_debts(hold_id),
  user_id bigint not null references ai_credit_accounts(user_id),
  source_lot_id uuid not null references credit_source_lots(id),
  amount_micros bigint not null check(amount_micros between 1 and 55000000),
  created_at timestamptz not null default clock_timestamp()
);
create index credit_debt_repayments_debt on credit_debt_repayments(debt_hold_id);
create index credit_debt_repayments_lot on credit_debt_repayments(source_lot_id);
create index credit_debt_repayments_user on credit_debt_repayments(user_id);

create function citygo_guard_credit_debt_identity() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP<>'INSERT' then
    raise exception 'Debt accounting identity is append-only' using errcode='23514';
  end if;
  if TG_TABLE_NAME='credit_charge_debts' then
    if not exists(select 1 from public.ai_credit_charges c join public.ai_credit_entries e on e.operation_id=c.hold_id
      where c.hold_id=new.hold_id and c.user_id=new.user_id and e.user_id=new.user_id
        and e.kind='hold' and e.amount_micros=5000000 and c.reservation_mode='fixed5_overdraft'
        and c.dispatched and c.response_complete and c.generation_id is not null) then
      raise exception 'Debt requires a completed fixed5 charge' using errcode='23514';
    end if;
  else
    if not exists(select 1 from public.credit_charge_debts d join public.credit_source_lots l on l.user_id=d.user_id
      where d.hold_id=new.debt_hold_id and d.user_id=new.user_id and l.id=new.source_lot_id
        and l.spent_micros>=new.amount_micros
        and d.principal_micros-coalesce((select sum(r.amount_micros) from public.credit_debt_repayments r
          where r.debt_hold_id=d.hold_id),0)>=new.amount_micros) then
      raise exception 'Debt repayment exceeds the original liability or source' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger credit_charge_debt_identity before insert or update or delete on credit_charge_debts
  for each row execute function citygo_guard_credit_debt_identity();
create trigger credit_debt_repayment_identity before insert or update or delete on credit_debt_repayments
  for each row execute function citygo_guard_credit_debt_identity();

create function citygo_guard_charge_reservation_mode() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='UPDATE' then
    if row(new.reservation_mode,new.tariff_snapshot,new.real_ceiling_micros,new.hold_id,new.user_id,new.thread_id,new.request_id,new.model,new.upstream)
      is distinct from row(old.reservation_mode,old.tariff_snapshot,old.real_ceiling_micros,old.hold_id,old.user_id,old.thread_id,old.request_id,old.model,old.upstream) then
      raise exception 'Accepted charge reservation is immutable' using errcode='23514';
    end if;
    if (old.receipt is not null and new.receipt is distinct from old.receipt)
      or(old.generation_id is not null and new.generation_id is distinct from old.generation_id)
      or(old.dispatched and not new.dispatched) or(old.response_complete and not new.response_complete) then
      raise exception 'Charge receipt and transport identity cannot be rewritten' using errcode='23514';
    end if;
  elsif new.reservation_mode='fixed5_overdraft' then
    if not exists(select 1 from public.ai_credit_entries e where e.operation_id=new.hold_id
      and e.user_id=new.user_id and e.kind='hold' and e.amount_micros=5000000) then
      raise exception 'Fixed5 charge requires its exact initial hold' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger ai_credit_charge_reservation_guard before insert or update on ai_credit_charges
  for each row execute function citygo_guard_charge_reservation_mode();

-- Invoker privileges, caller owns security -> user -> account locks. Re-entering
-- those user/account locks is harmless and also serializes trigger callers.
create function citygo_apply_credit_debt_repayments(p_user_id bigint) returns void
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare d record; l record; remaining bigint; free_micros bigint; use_micros bigint;
begin
  perform id from public.users where id=p_user_id for update;
  perform user_id from public.ai_credit_accounts where user_id=p_user_id for update;
  for d in select c.hold_id,c.principal_micros-coalesce(sum(r.amount_micros),0) as remaining
    from public.credit_charge_debts c left join public.credit_debt_repayments r on r.debt_hold_id=c.hold_id
    where c.user_id=p_user_id group by c.hold_id,c.principal_micros,c.created_at
    having c.principal_micros>coalesce(sum(r.amount_micros),0) order by c.created_at,c.hold_id
  loop
    remaining:=d.remaining;
    for l in select * from public.credit_source_lots where user_id=p_user_id
      and gross_micros>spent_micros+held_micros+refund_reserved_micros+refunded_micros
      order by case kind when 'gift' then 0 when 'legacy_nonrefundable' then 1 else 2 end,
        source_entry_id nulls first,id for update
    loop
      free_micros:=l.gross_micros-l.spent_micros-l.held_micros-l.refund_reserved_micros-l.refunded_micros;
      use_micros:=least(remaining,free_micros);
      if use_micros>0 then
        update public.credit_source_lots set spent_micros=spent_micros+use_micros where id=l.id;
        insert into public.credit_debt_repayments(id,debt_hold_id,user_id,source_lot_id,amount_micros)
          values(gen_random_uuid(),d.hold_id,p_user_id,l.id,use_micros);
        remaining:=remaining-use_micros;
      end if;
      exit when remaining=0;
    end loop;
  end loop;
end;
$$;
create function citygo_repay_credit_debt_from_new_source() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  perform public.citygo_apply_credit_debt_repayments(new.user_id);
  return new;
end;
$$;
create trigger credit_source_debt_repayment after insert on credit_source_lots
  for each row execute function citygo_repay_credit_debt_from_new_source();

-- Cross-table checks are deferred until the posting, receipt and source
-- allocations are all committed together. A naked negative account is invalid.
create function citygo_check_credit_debt_conservation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare who bigint; deficit bigint; outstanding bigint;
begin
  who:=new.user_id;
  select greatest(held_micros+spent_micros-granted_micros,0) into deficit
    from public.ai_credit_accounts where user_id=who;
  select coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0) into outstanding
    from public.credit_charge_debts d left join
      (select debt_hold_id,sum(amount_micros) as paid from public.credit_debt_repayments where user_id=who group by debt_hold_id) r
      on r.debt_hold_id=d.hold_id where d.user_id=who;
  if outstanding<0 or outstanding>55000000 or coalesce(deficit,0)<>outstanding then
    raise exception 'Negative balance requires its exact bounded outstanding debt' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_charge_debts d
    join public.ai_credit_charges c on c.hold_id=d.hold_id
    join public.ai_credit_entries h on h.operation_id=d.hold_id
    left join public.ai_credit_entries s on s.hold_id=d.hold_id
    where d.user_id=who and (c.reservation_mode<>'fixed5_overdraft' or c.user_id<>who
      or not c.dispatched or not c.response_complete or c.generation_id is null
      or h.amount_micros<>5000000 or s.id is null or s.kind is distinct from 'settle'
      or s.user_id is distinct from who
      or d.principal_micros<>s.amount_micros-least(s.amount_micros,h.amount_micros)
      or c.receipt is null or c.receipt->>'currency' is distinct from 'RUB'
      or c.receipt->>'reference' is distinct from c.hold_id::text
      or c.receipt->>'generationId' is distinct from c.generation_id
      or c.receipt->>'model' is distinct from c.model or c.receipt->>'upstream' is distinct from c.upstream
      or case when jsonb_typeof(c.receipt->'costRub')='string'
        and length(c.receipt->>'costRub')<=80
        and c.receipt->>'costRub' ~ '^[0-9]{1,13}([.][0-9]{1,30})?([eE][+-]?[0-9]{1,2})?$'
        and jsonb_typeof(c.receipt->'amountMicros')='number' then
          (c.receipt->>'costRub')::numeric*1000000>c.real_ceiling_micros
          or floor((c.receipt->>'costRub')::numeric*10000000)<>s.amount_micros
          or floor((c.receipt->>'costRub')::numeric*1000000)<>(c.receipt->>'amountMicros')::numeric
        else true end)) then
    raise exception 'Debt is not backed by the accepted exact charge receipt' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_charge_debts d left join public.credit_debt_repayments r on r.debt_hold_id=d.hold_id
    where d.user_id=who group by d.hold_id,d.principal_micros having coalesce(sum(r.amount_micros),0)>d.principal_micros) then
    raise exception 'Debt was repaid more than once' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_source_lots l where l.user_id=who and l.spent_micros<
    coalesce((select sum(r.amount_micros) from public.credit_debt_repayments r where r.source_lot_id=l.id),0)
    +coalesce((select sum(a.spent_micros) from public.credit_hold_allocations a where a.source_lot_id=l.id),0)) then
    raise exception 'Debt repayments are not funded by their source lots' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_charge_debts where user_id=who) and exists(
    select 1 from public.ai_credit_accounts a where a.user_id=who and
      (a.spent_micros<>outstanding+coalesce((select sum(l.spent_micros) from public.credit_source_lots l where l.user_id=who),0)
       or a.granted_micros<>coalesce((select sum(l.gross_micros-l.refunded_micros) from public.credit_source_lots l where l.user_id=who),0)
       or a.held_micros<>coalesce((select sum(l.held_micros+l.refund_reserved_micros) from public.credit_source_lots l where l.user_id=who),0))) then
    raise exception 'Debt account counters and verified sources disagree' using errcode='23514';
  end if;
  return new;
end;
$$;
create constraint trigger credit_account_debt_check after insert or update on ai_credit_accounts
  deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger credit_charge_debt_check after insert on credit_charge_debts
  deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger credit_debt_repayment_check after insert on credit_debt_repayments
  deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger credit_receipt_debt_check after update on ai_credit_charges
  deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger credit_source_debt_check after insert or update on credit_source_lots
  deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();

commit;
