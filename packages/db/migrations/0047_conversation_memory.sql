begin;

-- A private, rebuildable quotation index. Every byte comes from an original
-- completed USER message, never from a model-generated summary or inference.
create table conversation_memory_fragments (
  message_id bigint not null references messages(id) on delete cascade,
  ordinal integer not null check (ordinal between 0 and 999),
  user_id bigint not null references users(id) on delete cascade,
  thread_id bigint not null references agent_threads(id) on delete cascade,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  start_offset integer not null check (start_offset=ordinal*1000),
  end_offset integer not null check (end_offset>start_offset and end_offset<=start_offset+1000),
  content text not null check (char_length(content)=end_offset-start_offset and octet_length(content)<=4000),
  search_vector tsvector generated always as (to_tsvector('pg_catalog.russian',content)) stored,
  created_at timestamptz not null default clock_timestamp(),
  primary key(message_id,source_sha256,ordinal)
);
create index conversation_memory_scope_idx on conversation_memory_fragments(user_id,thread_id,message_id desc,ordinal);
create index conversation_memory_search_idx on conversation_memory_fragments using gin(search_vector);
create index messages_memory_sources_idx on messages(thread_id,id)
  where role='user' and coalesce(metadata->>'status','complete')='complete';

create function citygo_guard_conversation_memory_fragment() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if exists(with source_ids as materialized (
      select distinct message_id from inserted_fragments
    ), sources as materialized (
      select m.id,m.thread_id,t.user_id,m.content,char_length(m.content) as characters,
        encode(sha256(convert_to(m.content,'UTF8')),'hex') as hash
      from source_ids i join public.messages m on m.id=i.message_id
      join public.agent_threads t on t.id=m.thread_id
      where m.role='user' and coalesce(m.metadata->>'status','complete')='complete'
    ) select 1 from inserted_fragments n left join sources s on s.id=n.message_id
      where s.id is null or s.thread_id<>n.thread_id or s.user_id<>n.user_id
        or n.source_sha256<>s.hash
        or n.content<>substring(s.content from n.start_offset+1 for n.end_offset-n.start_offset)
        or n.end_offset>s.characters
        or (n.end_offset<s.characters and n.end_offset-n.start_offset<>1000)) then
    raise exception 'Conversation memory must quote its exact completed user source' using errcode='23514';
  end if;
  return null;
end $$;
create function citygo_reject_conversation_memory_update() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  raise exception 'Conversation memory quotations are immutable' using errcode='23514';
  return new;
end $$;
-- The transition table hashes each original once for the whole insert statement,
-- rather than once for every 1,000-character quotation from that original.
create trigger conversation_memory_fragment_guard after insert on conversation_memory_fragments
  referencing new table as inserted_fragments
  for each statement execute function citygo_guard_conversation_memory_fragment();
create trigger conversation_memory_update_guard before update on conversation_memory_fragments
  for each row execute function citygo_reject_conversation_memory_update();
revoke all on function citygo_guard_conversation_memory_fragment() from public;
revoke all on function citygo_reject_conversation_memory_update() from public;

commit;
