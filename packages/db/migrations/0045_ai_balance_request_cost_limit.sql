begin;

-- This opt-in changes NEW admissions only. Historical rows remain explicitly
-- operator_ceiling, their receipts/limits/identities are never rewritten, and no
-- runtime/AI-budget/provider/payment/SMS feature is enabled by this migration.
alter table ai_credit_charges
  add column cost_limit_mode text not null default 'operator_ceiling'
    check(cost_limit_mode in ('operator_ceiling','user_balance')),
  add column balance_before_hold_micros bigint;
alter table ai_credit_charges add constraint ai_credit_balance_limit_snapshot check (
  (cost_limit_mode='operator_ceiling' and balance_before_hold_micros is null)
  or (cost_limit_mode='user_balance' and balance_before_hold_micros is not null
    and reservation_mode='fixed5_overdraft'
    and tariff_snapshot->>'version'='citygo-10x-v1'
    and balance_before_hold_micros between 5000000 and 10000000000000
    and real_ceiling_micros=balance_before_hold_micros/10)
);
alter table ai_credit_charges drop constraint ai_credit_fixed5_scope;
alter table ai_credit_charges add constraint ai_credit_fixed5_scope check (
  reservation_mode='full' or (tariff_snapshot->>'version'='citygo-10x-v1' and
    ((cost_limit_mode='operator_ceiling' and real_ceiling_micros between 500000 and 6000000)
     or (cost_limit_mode='user_balance' and real_ceiling_micros between 500000 and 1000000000000)))
);

-- The per-attempt 6 real RUB / 55 CityGo overdraft stays intact for legacy rows.
-- A balance-marked valid provider receipt may exceed its accepted soft limit;
-- retain exact debt/source conservation, bounded by the existing integer ledger.
alter table ai_credit_accounts add constraint ai_credit_spent_technical_bound
  check(spent_micros<=10000000000000);
alter table ai_credit_accounts drop constraint ai_credit_bounded_overdraft;
alter table ai_credit_accounts add constraint ai_credit_bounded_overdraft
  check(held_micros+spent_micros<=granted_micros+10000000000000);
alter table credit_charge_debts drop constraint credit_charge_debts_principal_micros_check;
alter table credit_charge_debts add constraint credit_charge_debts_principal_micros_check
  check(principal_micros between 1 and 10000000000000);
alter table credit_debt_repayments drop constraint credit_debt_repayments_amount_micros_check;
alter table credit_debt_repayments add constraint credit_debt_repayments_amount_micros_check
  check(amount_micros between 1 and 10000000000000);

-- CREATE OR REPLACE preserves function ownership/ACLs. All remain invoker; no
-- new privileges or background worker are introduced.
create or replace function citygo_guard_charge_reservation_mode() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='UPDATE' then
    if row(new.reservation_mode,new.cost_limit_mode,new.balance_before_hold_micros,new.tariff_snapshot,new.real_ceiling_micros,new.hold_id,new.user_id,new.thread_id,new.request_id,new.model,new.upstream)
      is distinct from row(old.reservation_mode,old.cost_limit_mode,old.balance_before_hold_micros,old.tariff_snapshot,old.real_ceiling_micros,old.hold_id,old.user_id,old.thread_id,old.request_id,old.model,old.upstream) then
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
  if TG_OP='INSERT' and new.cost_limit_mode='user_balance' then
    -- The exact account is already locked by admission. Its fixed5 hold was
    -- posted just before this row, so add only that hold back to recover the
    -- accepted pre-hold balance, including any simultaneously blocked refunds.
    if not exists(select 1 from public.ai_credit_accounts a
      where a.user_id=new.user_id and
        new.balance_before_hold_micros=a.granted_micros-a.held_micros-a.spent_micros+5000000)
      or not exists(select 1 from public.ai_model_attempts m
        where m.thread_id=new.thread_id and m.request_id=new.request_id and m.attempt_number=1
          and m.user_id=new.user_id and m.provider='routerai' and m.model=new.model
          and m.money_currency='RUB' and m.money_reserved_micros=new.real_ceiling_micros) then
      raise exception 'Balance limit requires its exact pre-hold account and attempt snapshot' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function citygo_guard_credit_debt_identity() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP<>'INSERT' then
    raise exception 'Debt accounting identity is append-only' using errcode='23514';
  end if;
  if TG_TABLE_NAME='credit_charge_debts' then
    if not exists(select 1 from public.ai_credit_charges c join public.ai_credit_entries e on e.operation_id=c.hold_id
      where c.hold_id=new.hold_id and c.user_id=new.user_id and e.user_id=new.user_id
        and e.kind='hold' and e.amount_micros=5000000 and c.reservation_mode='fixed5_overdraft'
        and c.dispatched and c.response_complete and c.generation_id is not null
        and (c.cost_limit_mode='user_balance' or new.principal_micros<=55000000)) then
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

create or replace function citygo_check_credit_debt_conservation() returns trigger
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
  if outstanding<0 or outstanding>10000000000000 or coalesce(deficit,0)<>outstanding then
    raise exception 'Negative balance requires its exact bounded outstanding debt' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_charge_debts d
    join public.ai_credit_charges c on c.hold_id=d.hold_id
    join public.ai_credit_entries h on h.operation_id=d.hold_id
    left join public.ai_credit_entries s on s.hold_id=d.hold_id
    where d.user_id=who and (c.reservation_mode<>'fixed5_overdraft' or c.user_id<>who
      or (c.cost_limit_mode='operator_ceiling' and d.principal_micros>55000000)
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
          (c.cost_limit_mode='operator_ceiling' and (c.receipt->>'costRub')::numeric*1000000>c.real_ceiling_micros)
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

commit;
