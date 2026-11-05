begin;
-- Add only the explicitly versioned native-search test route. Existing attempt
-- evidence and all other protocol/immutability guards remain unchanged.
-- CREATE OR REPLACE retains the function OID, owner and EXECUTE ACL.

create or replace function citygo_guard_postpay_attempt() returns trigger
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
    and case when am.snapshot->'policy'->>'version'='ai-mode-route-web-search-postpay-test-v1' then
      am.mode='maximum' and am.provider='routerai' and am.model='openai/gpt-6.1-sol' and am.upstream='openai'
      and new.protocol='chat/completions'
     else new.protocol=case am.mode when 'maximum' then 'responses' when 'balanced' then 'chat/completions' else 'gigachat' end end
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

commit;
