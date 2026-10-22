begin;

-- Existing conversations remain legacy (NULL), with their IDs, messages,
-- leases and financial references untouched. This does not open a new chat.
alter table agent_threads add column conversation_agent_key text;
alter table agent_threads add constraint assistant_conversation_key check (
  conversation_agent_key is null or conversation_agent_key in
    ('support','housing','job-search','resume-builder','digital-mentor')
);
alter table agent_threads add constraint assistant_conversation_role check (
  conversation_agent_key is null or agent_key=conversation_agent_key
);

drop index one_open_thread_per_user;
create unique index one_open_thread_per_user on agent_threads(user_id)
  where status<>'closed' and conversation_agent_key is null;
create unique index one_open_thread_per_assistant
  on agent_threads(user_id,conversation_agent_key)
  where status<>'closed' and conversation_agent_key is not null;
create index agent_threads_owner_history on agent_threads(user_id,id desc);

-- A pinned assistant cannot be changed into another assistant or the legacy
-- route, including after closure. Changing both fields must not bypass CHECK.
create function citygo_guard_assistant_conversation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.conversation_agent_key is distinct from old.conversation_agent_key
    or (old.conversation_agent_key is not null
      and row(new.id,new.user_id) is distinct from row(old.id,old.user_id)) then
    raise exception 'Assistant conversation identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger assistant_conversation_identity before update on agent_threads
  for each row execute function citygo_guard_assistant_conversation();

commit;
