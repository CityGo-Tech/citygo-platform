begin;

-- Initialized once by the API from the existing selection; restarts never reset it.
create table ai_routing (
  id integer primary key check (id = 1),
  provider text not null check (provider in ('openai', 'routerai', 'gigachat', 'disabled')),
  policy_id text,
  revision integer not null check (revision > 0),
  check ((provider = 'disabled' and policy_id is null) or
         (provider <> 'disabled' and policy_id is not null and policy_id ~ '^[a-f0-9]{64}$'))
);

alter table chat_requests add column ai_routing_revision integer check (ai_routing_revision > 0);

-- Existing audit_log_actor_user_id_idx indexes the actor FK. This partial index
-- supports the bounded newest-first operational journal without scanning all audits.
create index audit_log_ai_routing_recent_idx on audit_log (id desc)
  where entity_type = 'ai-routing' and entity_id = '1';

commit;
