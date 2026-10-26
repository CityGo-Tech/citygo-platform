begin;

-- New requests freeze one public server-selected profile. Old requests are not
-- backfilled or reinterpreted, and this table is not a new global routing switch.
create table ai_request_modes (
  thread_id bigint not null,
  request_id uuid not null,
  user_id bigint not null references users(id),
  consent_policy_id text not null check(consent_policy_id ~ '^[a-f0-9]{64}$'),
  routing_revision integer not null check(routing_revision>0),
  mode text not null check(mode in ('maximum','balanced','minimum')),
  catalog_id text not null check(catalog_id ~ '^[a-f0-9]{64}$'),
  provider text not null check(provider in ('openai','routerai','gigachat')),
  model text not null check(char_length(model) between 1 and 200),
  policy_id text not null check(policy_id ~ '^[a-f0-9]{64}$'),
  execution_key text not null check(execution_key ~ '^[a-f0-9]{64}$'),
  upstream text check(upstream ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=262144),
  created_at timestamptz not null default clock_timestamp(),
  primary key(thread_id,request_id),
  foreign key(thread_id,request_id) references chat_requests(thread_id,request_id),
  check((provider='routerai')=(upstream is not null))
);
create index ai_request_modes_user on ai_request_modes(user_id,created_at,thread_id,request_id);

create function citygo_guard_ai_request_mode() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP<>'INSERT' then
    raise exception 'Accepted AI request mode is immutable and retained' using errcode='23514';
  end if;
  if not exists(select 1 from public.chat_requests r join public.agent_threads t on t.id=r.thread_id
    where r.thread_id=new.thread_id and r.request_id=new.request_id and r.status='running'
      and t.user_id=new.user_id and r.ai_policy_id=new.consent_policy_id and r.ai_routing_revision=new.routing_revision)
    or exists(select 1 from public.ai_model_attempts where thread_id=new.thread_id and request_id=new.request_id) then
    raise exception 'AI mode must freeze before the first admitted model attempt' using errcode='23514';
  end if;
  if new.snapshot->>'mode' is distinct from new.mode
    or new.snapshot->>'catalogId' is distinct from new.catalog_id
    or jsonb_typeof(new.snapshot->'policy') is distinct from 'object'
    or jsonb_typeof(new.snapshot->'execution') is distinct from 'object'
    or new.snapshot->'policy'->>'id' is distinct from new.policy_id
    or new.snapshot->'policy'->>'provider' is distinct from new.provider
    or new.snapshot->'policy'->>'model' is distinct from new.model
    or new.snapshot->'execution'->>'key' is distinct from new.execution_key
    or new.snapshot->'execution'->'policy' is distinct from new.snapshot->'policy'
    or new.snapshot->>'upstream' is distinct from new.upstream
    or new.snapshot-array['mode','catalogId','policy','execution','upstream'] <> '{}'::jsonb
    or (new.snapshot->'policy')-array['id','version','provider','model','recipient','routing','data'] <> '{}'::jsonb
    or (new.snapshot->'execution')-array['key','policy','maxInputBytes','maxOutputTokens'] <> '{}'::jsonb
    or jsonb_typeof(new.snapshot->'execution'->'maxInputBytes') is distinct from 'number'
    or jsonb_typeof(new.snapshot->'execution'->'maxOutputTokens') is distinct from 'number' then
    raise exception 'AI mode snapshot does not match its immutable profile' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger ai_request_mode_guard before insert or update or delete on ai_request_modes
  for each row execute function citygo_guard_ai_request_mode();

-- Defense in depth for future API code paths: an attempt cannot bypass the
-- frozen selection with a direct INSERT. Historical requests without a mode
-- retain their existing behavior, and Worker status UPDATEs are unaffected.
create function citygo_guard_ai_mode_attempt() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare pinned public.ai_request_modes%rowtype;
begin
  select * into pinned from public.ai_request_modes
    where thread_id=new.thread_id and request_id=new.request_id;
  if found and (
    row(new.user_id,new.provider,new.model,new.policy_id,new.routing_revision)
      is distinct from row(pinned.user_id,pinned.provider,pinned.model,pinned.policy_id,pinned.routing_revision)
    or (new.money_rule_key is not null and new.money_rule_key is distinct from pinned.execution_key)
    or not exists(select 1 from public.chat_requests r
      where r.thread_id=new.thread_id and r.request_id=new.request_id and r.status='running'
        and r.ai_policy_id=pinned.consent_policy_id and r.ai_routing_revision=pinned.routing_revision)
  ) then
    raise exception 'AI attempt does not match the frozen request mode' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger ai_mode_attempt_guard before insert on ai_model_attempts
  for each row execute function citygo_guard_ai_mode_attempt();

commit;
