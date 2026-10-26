begin;
-- The routing envelope is distinct from the real, previously recorded grant.
-- Historical requests and consent events are never rewritten or backfilled.
create table ai_request_consent_bases (
 thread_id bigint not null,
 request_id uuid not null,
 user_id bigint not null references users(id),
 routing_policy_id text not null check(routing_policy_id ~ '^[a-f0-9]{64}$'),
 grant_policy_id text not null check(grant_policy_id ~ '^[a-f0-9]{64}$'),
 service_event_id bigint not null references service_consent_events(id),
 service_policy_hash text not null check(service_policy_hash ~ '^[a-f0-9]{64}$'),
 basis text not null check(basis in ('current','legacy-balanced')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(thread_id,request_id),
 foreign key(thread_id,request_id) references ai_request_modes(thread_id,request_id),
 check((basis='current')=(routing_policy_id=grant_policy_id))
);
create function citygo_guard_ai_request_consent_basis() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if TG_OP<>'INSERT' then raise exception 'Admitted consent basis is immutable' using errcode='23514'; end if;
 if not exists(select 1 from public.ai_request_modes m join public.chat_requests r
   on r.thread_id=m.thread_id and r.request_id=m.request_id
   join public.service_consent_events e on e.id=new.service_event_id
   join public.ai_consents a on a.user_id=new.user_id
   where m.thread_id=new.thread_id and m.request_id=new.request_id and m.user_id=new.user_id
   and m.consent_policy_id=new.routing_policy_id and r.status='running'
   and e.user_id=new.user_id and e.purpose='personal-data' and e.decision='granted'
   and e.policy_hash=new.service_policy_hash and e.policy_snapshot->'aiProcessing'->>'id'=new.grant_policy_id
   and e.id=(select max(last_pd.id) from public.service_consent_events last_pd
     where last_pd.user_id=new.user_id and last_pd.purpose='personal-data')
   and a.policy_id=new.grant_policy_id and a.granted=true
   and exists(select 1 from public.consent_events ai where ai.user_id=new.user_id
     and ai.consent_key='ai-recipient' and ai.action='granted' and ai.policy_version=new.grant_policy_id
     and ai.details=e.policy_snapshot->'aiProcessing'
     and ai.id=(select max(last_ai.id) from public.consent_events last_ai
       where last_ai.user_id=new.user_id and last_ai.consent_key='ai-recipient'))
   and (new.basis='current' or (m.mode='balanced' and m.provider='routerai'
     and m.model='deepseek/deepseek-v4-pro-0813' and m.upstream='deepseek'
     and m.policy_id=new.grant_policy_id and m.snapshot->'policy'=e.policy_snapshot->'aiProcessing'
     and m.snapshot->'execution'->>'maxInputBytes'='8192'
     and m.snapshot->'execution'->>'maxOutputTokens'='4096'
     and m.execution_key=encode(sha256(convert_to('{"version":"ai-reserve-v1","policyId":"'||new.grant_policy_id||'","maxInputBytes":8192,"maxOutputTokens":4096,"creditReservationMode":"fixed5_overdraft"}','UTF8')),'hex')))) then
   raise exception 'Consent basis requires its real grant and frozen request' using errcode='23514';
 end if;
 return new;
end;
$$;
create trigger ai_request_consent_basis_guard before insert or update or delete on ai_request_consent_bases
 for each row execute function citygo_guard_ai_request_consent_basis();
commit;
