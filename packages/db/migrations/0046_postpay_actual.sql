begin;

-- New zero-valued postpay_open is an admission identity, NOT a money hold.
-- Existing rows, receipts, source allocations and runtime approvals stay intact.
alter table ai_credit_entries drop constraint ai_credit_entries_kind_check,drop constraint ai_credit_entries_check;
alter table ai_credit_entries add constraint ai_credit_entries_kind_check check(kind in ('bonus','topup','hold','settle','release','postpay_open'));
alter table ai_credit_entries add constraint ai_credit_entries_check check (
 (kind='bonus' and amount_micros=500000000 and hold_id is null and actor_user_id is not null)
 or(kind='topup' and amount_micros>0 and hold_id is null and actor_user_id is null)
 or(kind='hold' and amount_micros>0 and hold_id is null and actor_user_id is null)
 or(kind='postpay_open' and amount_micros=0 and hold_id is null and actor_user_id is null)
 or(kind in ('settle','release') and hold_id is not null and actor_user_id is null)
);
create table ai_postpay_attempts (
 id uuid primary key references ai_credit_entries(operation_id),
 user_id bigint not null references ai_credit_accounts(user_id),thread_id bigint not null,request_id uuid not null,
 attempt_number smallint not null default 1 check(attempt_number=1),
 provider text not null check(provider in ('routerai','gigachat')),
 protocol text not null check(protocol in ('responses','chat/completions','gigachat')),
 model text not null check(length(model) between 1 and 200),upstream text,
 execution_key text not null check(execution_key ~ '^[a-f0-9]{64}$'),policy_id text not null check(policy_id ~ '^[a-f0-9]{64}$'),
 tariff_snapshot jsonb not null check(tariff_snapshot='{"version":"citygo-10x-v1","realCurrency":"RUB","balanceUnit":"CITYGO_RUB","numerator":10,"denominator":1}'::jsonb),
 balance_before_micros bigint not null check(balance_before_micros between 1 and 10000000000000),real_ceiling_micros bigint,
 fixed_fee_micros bigint not null check(fixed_fee_micros in (0,3000000)),
 state text not null default 'admitted' check(state in ('admitted','dispatched','pending','settled','no_charge')),
 dispatched boolean not null default false,response_complete boolean not null default false,
 response_message_id bigint unique references messages(id),generation_id text,receipt jsonb,
 settlement_operation_id uuid unique references ai_credit_entries(operation_id),
 observed_receipt jsonb,observed_at timestamptz,reconcile_token uuid,reconcile_until timestamptz,
 next_check_at timestamptz not null default clock_timestamp(),check_count integer not null default 0 check(check_count>=0),
 created_at timestamptz not null default clock_timestamp(),unique(thread_id,request_id),
 foreign key(thread_id,request_id,attempt_number) references ai_model_attempts(thread_id,request_id,attempt_number),
 check((provider='routerai' and protocol in ('responses','chat/completions') and upstream is not null and upstream ~ '^[a-z0-9][a-z0-9_-]{0,79}$'
  and fixed_fee_micros=0 and balance_before_micros>=10 and real_ceiling_micros is not null and real_ceiling_micros=balance_before_micros/10)
  or(provider='gigachat' and protocol='gigachat' and model='GigaChat-3-Ultra' and upstream is null
   and fixed_fee_micros=3000000 and balance_before_micros>=3000000 and real_ceiling_micros is null)),
 check((state in ('settled','no_charge'))=(settlement_operation_id is not null)),
 check((reconcile_token is null)=(reconcile_until is null)),check(response_complete=(response_message_id is not null)),
 check(generation_id is null or generation_id ~ '^[a-zA-Z0-9_-]{1,200}$')
);
create unique index ai_postpay_generation_once on ai_postpay_attempts(provider,generation_id) where generation_id is not null;
create index ai_postpay_owner on ai_postpay_attempts(user_id,created_at,id);
create index ai_postpay_due on ai_postpay_attempts(next_check_at,id) where provider='routerai' and state in ('dispatched','pending');
create table credit_postpay_liabilities (
 charge_id uuid primary key references ai_postpay_attempts(id),user_id bigint not null references ai_credit_accounts(user_id),
 principal_micros bigint not null check(principal_micros between 1 and 10000000000000),created_at timestamptz not null default clock_timestamp()
);
create index credit_postpay_liabilities_owner on credit_postpay_liabilities(user_id,created_at,charge_id);
create table credit_postpay_repayments (
 id uuid primary key,charge_id uuid not null references credit_postpay_liabilities(charge_id),
 user_id bigint not null references ai_credit_accounts(user_id),source_lot_id uuid not null references credit_source_lots(id),
 amount_micros bigint not null check(amount_micros between 1 and 10000000000000),created_at timestamptz not null default clock_timestamp()
);
create index credit_postpay_repayments_charge on credit_postpay_repayments(charge_id);
create index credit_postpay_repayments_source on credit_postpay_repayments(source_lot_id);
create index credit_postpay_repayments_owner on credit_postpay_repayments(user_id);

create function citygo_guard_postpay_attempt() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if TG_OP='DELETE' then raise exception 'Postpay evidence is retained' using errcode='23514'; end if;
 if TG_OP='INSERT' then
  if new.state<>'admitted' or new.dispatched or new.response_complete or new.receipt is not null or not exists(
   select 1 from public.ai_credit_entries e join public.ai_credit_accounts a on a.user_id=e.user_id
   join public.ai_model_attempts m on m.thread_id=new.thread_id and m.request_id=new.request_id and m.attempt_number=1
   join public.ai_request_modes am on am.thread_id=m.thread_id and am.request_id=m.request_id
   join public.agent_threads t on t.id=m.thread_id join public.chat_requests r on r.thread_id=t.id and r.request_id=m.request_id
   where e.operation_id=new.id and e.user_id=new.user_id and e.kind='postpay_open' and e.amount_micros=0 and not a.billing_review_required
    and new.balance_before_micros=a.granted_micros-a.held_micros-a.spent_micros
    and m.user_id=new.user_id and m.provider=new.provider and m.model=new.model and m.policy_id=new.policy_id
    and am.user_id=new.user_id and am.provider=new.provider and am.model=new.model and am.policy_id=new.policy_id
    and am.execution_key=new.execution_key and am.upstream is not distinct from new.upstream
    and new.protocol=case am.mode when 'maximum' then 'responses' when 'balanced' then 'chat/completions' else 'gigachat' end
    and ((new.provider='routerai' and m.money_reserved_micros=new.real_ceiling_micros and m.money_currency='RUB' and m.money_rule_key=new.execution_key)
     or(new.provider='gigachat' and m.money_reserved_micros is null and m.money_currency is null))
    and t.user_id=new.user_id and t.busy_until>clock_timestamp() and r.status='running'
  ) then raise exception 'Postpay admission identity or balance is invalid' using errcode='23514'; end if;
 else
  if row(new.id,new.user_id,new.thread_id,new.request_id,new.attempt_number,new.provider,new.protocol,new.model,new.upstream,new.execution_key,new.policy_id,new.tariff_snapshot,new.balance_before_micros,new.real_ceiling_micros,new.fixed_fee_micros,new.created_at)
   is distinct from row(old.id,old.user_id,old.thread_id,old.request_id,old.attempt_number,old.provider,old.protocol,old.model,old.upstream,old.execution_key,old.policy_id,old.tariff_snapshot,old.balance_before_micros,old.real_ceiling_micros,old.fixed_fee_micros,old.created_at)
   or(old.state in ('settled','no_charge') and to_jsonb(new) is distinct from to_jsonb(old))
   or(old.dispatched and not new.dispatched) or(old.response_complete and not new.response_complete)
   or(old.response_message_id is not null and new.response_message_id is distinct from old.response_message_id)
   or(old.generation_id is not null and new.generation_id is distinct from old.generation_id)
   or(old.receipt is not null and new.receipt is distinct from old.receipt)
   or(new.state='admitted' and old.state<>'admitted') or(new.state='dispatched' and new.state is distinct from old.state and old.state<>'admitted')
   then raise exception 'Postpay admitted identity and outcome are immutable' using errcode='23514'; end if;
  if new.response_complete and not old.response_complete and (not new.dispatched or not exists(
   select 1 from public.messages m join public.chat_requests r on r.thread_id=m.thread_id and r.request_id=new.request_id
   where m.id=new.response_message_id and m.thread_id=new.thread_id and m.role='assistant' and length(btrim(m.content))>0
    and m.metadata->>'status'='complete' and m.metadata->>'source'='model' and m.metadata->>'requestId'=new.request_id::text
    and m.metadata->'generation'->>'provider'=new.provider and m.metadata->'generation'->>'requestedModel'=new.model
    and r.status='complete'
  )) then raise exception 'Postpay completion requires persisted terminal model answer' using errcode='23514'; end if;
 end if;
 return new;
end;
$$;
create trigger ai_postpay_guard before insert or update or delete on ai_postpay_attempts for each row execute function citygo_guard_postpay_attempt();
create function citygo_guard_postpay_liability() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if TG_OP<>'INSERT' then raise exception 'Postpay funding is append-only' using errcode='23514'; end if;
 if TG_TABLE_NAME='credit_postpay_liabilities' then
  if not exists(select 1 from public.ai_postpay_attempts p join public.ai_credit_entries e on e.operation_id=p.settlement_operation_id
   where p.id=new.charge_id and p.user_id=new.user_id and p.state='settled' and p.response_complete
    and e.user_id=new.user_id and e.kind='settle' and e.hold_id=p.id and e.amount_micros=new.principal_micros)
   then raise exception 'Postpay liability requires its exact debit' using errcode='23514'; end if;
 else
  if not exists(select 1 from public.credit_postpay_liabilities d join public.credit_source_lots l on l.user_id=d.user_id
   where d.charge_id=new.charge_id and d.user_id=new.user_id and l.id=new.source_lot_id and l.spent_micros>=new.amount_micros
    and d.principal_micros-coalesce((select sum(r.amount_micros) from public.credit_postpay_repayments r where r.charge_id=d.charge_id),0)>=new.amount_micros)
   then raise exception 'Postpay repayment exceeds liability or source' using errcode='23514'; end if;
 end if;
 return new;
end;
$$;
create trigger credit_postpay_liability_guard before insert or update or delete on credit_postpay_liabilities for each row execute function citygo_guard_postpay_liability();
create trigger credit_postpay_repayment_guard before insert or update or delete on credit_postpay_repayments for each row execute function citygo_guard_postpay_liability();

-- Invoker ownership/ACL remain unchanged. One FIFO debt queue, free sources only.
create or replace function citygo_apply_credit_debt_repayments(p_user_id bigint) returns void
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare d record; l record; remaining bigint; free_micros bigint; use_micros bigint;
begin
  perform id from public.users where id=p_user_id for update;
  perform user_id from public.ai_credit_accounts where user_id=p_user_id for update;
  for d in select * from (
    select 'legacy'::text as family,c.hold_id as identity,c.created_at,c.principal_micros-coalesce(sum(r.amount_micros),0) as remaining
    from public.credit_charge_debts c left join public.credit_debt_repayments r on r.debt_hold_id=c.hold_id
    where c.user_id=p_user_id group by c.hold_id,c.principal_micros,c.created_at
    having c.principal_micros>coalesce(sum(r.amount_micros),0)
    union all
    select 'postpay',c.charge_id,c.created_at,c.principal_micros-coalesce(sum(r.amount_micros),0)
    from public.credit_postpay_liabilities c left join public.credit_postpay_repayments r on r.charge_id=c.charge_id
    where c.user_id=p_user_id group by c.charge_id,c.principal_micros,c.created_at
    having c.principal_micros>coalesce(sum(r.amount_micros),0)
  ) q order by created_at,identity
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
        if d.family='legacy' then
          insert into public.credit_debt_repayments(id,debt_hold_id,user_id,source_lot_id,amount_micros)
            values(gen_random_uuid(),d.identity,p_user_id,l.id,use_micros);
        else
          insert into public.credit_postpay_repayments(id,charge_id,user_id,source_lot_id,amount_micros)
            values(gen_random_uuid(),d.identity,p_user_id,l.id,use_micros);
        end if;
        remaining:=remaining-use_micros;
      end if;
      exit when remaining=0;
    end loop;
  end loop;
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
  select outstanding+coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0) into outstanding
    from public.credit_postpay_liabilities d left join
      (select charge_id,sum(amount_micros) as paid from public.credit_postpay_repayments where user_id=who group by charge_id) r
      on r.charge_id=d.charge_id where d.user_id=who;
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
    +coalesce((select sum(a.spent_micros) from public.credit_hold_allocations a where a.source_lot_id=l.id),0)
    +coalesce((select sum(r.amount_micros) from public.credit_postpay_repayments r where r.source_lot_id=l.id),0)) then
    raise exception 'Debt repayments are not funded by their source lots' using errcode='23514';
  end if;
  if (exists(select 1 from public.credit_charge_debts where user_id=who) or exists(select 1 from public.credit_postpay_liabilities where user_id=who)) and exists(
    select 1 from public.ai_credit_accounts a where a.user_id=who and
      (a.spent_micros<>outstanding+coalesce((select sum(l.spent_micros) from public.credit_source_lots l where l.user_id=who),0)
       or a.granted_micros<>coalesce((select sum(l.gross_micros-l.refunded_micros) from public.credit_source_lots l where l.user_id=who),0)
       or a.held_micros<>coalesce((select sum(l.held_micros+l.refund_reserved_micros) from public.credit_source_lots l where l.user_id=who),0))) then
    raise exception 'Debt account counters and verified sources disagree' using errcode='23514';
  end if;
  if exists(select 1 from public.credit_postpay_liabilities d left join public.credit_postpay_repayments r on r.charge_id=d.charge_id
    where d.user_id=who group by d.charge_id,d.principal_micros having coalesce(sum(r.amount_micros),0)>d.principal_micros) then
    raise exception 'Postpay was funded more than once' using errcode='23514'; end if;
  return new;
end;
$$;

create function citygo_check_postpay_conservation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare who bigint;
begin
 who:=new.user_id;
 if exists(select 1 from public.ai_postpay_attempts p left join public.ai_credit_entries e on e.operation_id=p.settlement_operation_id
  left join public.credit_postpay_liabilities d on d.charge_id=p.id
  where p.user_id=who and (
   (p.state in ('settled','no_charge') and (e.id is null or e.user_id<>who or e.hold_id is distinct from p.id))
   or(p.state='no_charge' and(e.kind<>'release' or e.amount_micros<>0 or d.charge_id is not null or p.receipt is not null
    or(p.provider='routerai' and(p.dispatched or p.generation_id is not null or p.response_complete))
    or(p.provider='gigachat' and not exists(select 1 from public.gigachat_request_fees f
      where f.hold_id=p.id and f.billing_mode='postpay_actual_v1' and f.state in ('failed','expired') and f.resolution_operation_id=e.operation_id))))
   or(p.state='settled' and(not p.dispatched or not p.response_complete or e.kind<>'settle'
    or(case when e.amount_micros>0 then d.principal_micros is distinct from e.amount_micros else d.charge_id is not null end)
    or(p.provider='gigachat' and(e.amount_micros<>3000000 or p.receipt is not null or not exists(
     select 1 from public.gigachat_request_fees f where f.hold_id=p.id and f.billing_mode='postpay_actual_v1'
      and f.state='succeeded' and f.response_message_id=p.response_message_id and f.resolution_operation_id=e.operation_id)))
    or(p.provider='routerai' and(p.receipt is null or p.generation_id is null
     or p.receipt->>'reference' is distinct from p.id::text or p.receipt->>'generationId' is distinct from p.generation_id
     or p.receipt->>'model' is distinct from p.model or p.receipt->>'upstream' is distinct from p.upstream
     or p.receipt->>'currency' is distinct from 'RUB'
     or case when jsonb_typeof(p.receipt->'costRub')='string' and length(p.receipt->>'costRub')<=80
      and p.receipt->>'costRub' ~ '^[0-9]{1,13}([.][0-9]{1,30})?([eE][+-]?[0-9]{1,2})?$'
      and jsonb_typeof(p.receipt->'amountMicros')='number' then
       (p.receipt->>'costRub')::numeric<=0 or floor((p.receipt->>'costRub')::numeric*10000000)<>e.amount_micros
       or floor((p.receipt->>'costRub')::numeric*1000000)<>(p.receipt->>'amountMicros')::numeric
      else true end))))
  )) then raise exception 'Postpay is not backed by exact terminal evidence and funding' using errcode='23514'; end if;
 return new;
end;
$$;
create constraint trigger postpay_liability_debt_conservation after insert on credit_postpay_liabilities
 deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger postpay_repayment_debt_conservation after insert on credit_postpay_repayments
 deferrable initially deferred for each row execute function citygo_check_credit_debt_conservation();
create constraint trigger postpay_outcome_conservation after insert or update on ai_postpay_attempts
 deferrable initially deferred for each row execute function citygo_check_postpay_conservation();
create constraint trigger postpay_posting_conservation after insert on ai_credit_entries
 deferrable initially deferred for each row execute function citygo_check_postpay_conservation();
create constraint trigger postpay_liability_conservation after insert on credit_postpay_liabilities
 deferrable initially deferred for each row execute function citygo_check_postpay_conservation();

alter table gigachat_request_fees add column billing_mode text not null default 'legacy'
 check(billing_mode in ('legacy','postpay_actual_v1'));
alter table gigachat_request_fees drop constraint gigachat_request_fees_check3;
alter table gigachat_request_fees add constraint gigachat_request_fee_price_snapshot check (
 snapshot=jsonb_build_object('version',case billing_mode when 'legacy' then 'citygo-gigachat-flat3-success-v1' else 'citygo-gigachat-flat3-postpay-v1' end,
 'provider','gigachat','mode','minimum','model','GigaChat-3-Ultra','scope','GIGACHAT_API_PERS',
 'feeCitygoMicros',3000000,'holdCitygoMicros',case billing_mode when 'legacy' then 5000000 else 0 end,'operatorCostRubMicros',0,
 'pricingId',pricing_id,'accountRef',account_ref,'catalogId',catalog_id,'executionKey',execution_key)
);

create or replace function citygo_guard_gigachat_request_fee() returns trigger
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
      where h.operation_id=new.hold_id and h.user_id=new.user_id and ((new.billing_mode='legacy' and h.kind='hold' and h.amount_micros=5000000) or (new.billing_mode='postpay_actual_v1' and h.kind='postpay_open' and h.amount_micros=0 and exists(select 1 from public.ai_postpay_attempts p where p.id=h.operation_id and p.user_id=new.user_id and p.provider='gigachat' and p.fixed_fee_micros=3000000 and p.execution_key=new.execution_key)))
        and a.user_id=new.user_id and a.provider='gigachat' and a.model='GigaChat-3-Ultra'
        and a.money_currency is null and a.money_reserved_micros is null and a.money_rule_key is null and a.money_budget_revision is null
        and m.user_id=new.user_id and m.mode='minimum' and m.provider='gigachat' and m.model='GigaChat-3-Ultra'
        and m.catalog_id=new.catalog_id and m.execution_key=new.execution_key and m.policy_id=a.policy_id
        and r.status='running' and t.user_id=new.user_id and t.lease_token=new.chat_lease::text and t.busy_until>clock_timestamp()
    ) then raise exception 'GigaChat fee requires its exact frozen attempt and five CityGo hold' using errcode='23514'; end if;
  else
    if row(new.billing_mode,new.hold_id,new.user_id,new.thread_id,new.request_id,new.chat_lease,new.attempt_number,new.catalog_id,new.pricing_id,
      new.account_ref,new.execution_key,new.snapshot,new.lease_token,new.expires_at,new.created_at)
      is distinct from row(old.billing_mode,old.hold_id,old.user_id,old.thread_id,old.request_id,old.chat_lease,old.attempt_number,old.catalog_id,old.pricing_id,
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
commit;
