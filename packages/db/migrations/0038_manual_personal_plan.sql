begin;

-- Owner-created steps may have no chat source; sourced steps retain ownership checks.
alter table personal_plan_items alter column source_message_id drop not null;

create or replace function citygo_guard_personal_plan_item() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.source_message_id is not null and not exists (
    select 1 from messages m join agent_threads t on t.id=m.thread_id
    where m.id=new.source_message_id and t.user_id=new.user_id
      and m.role in ('user','assistant')
  ) then
    raise exception 'Personal plan source must belong to its owner' using errcode='23514';
  end if;
  if tg_op='INSERT' then
    if new.revision<>1 or new.deleted_at is not null or new.status<>'pending' then
      raise exception 'Personal plan initial state is invalid' using errcode='23514';
    end if;
  else
    if row(new.id,new.user_id,new.source_message_id,new.operation_id,new.create_request_hash,new.created_at)
       is distinct from row(old.id,old.user_id,old.source_message_id,old.operation_id,old.create_request_hash,old.created_at)
       or old.deleted_at is not null or new.revision<>old.revision+1
       or new.updated_at<=old.updated_at
       or (new.deleted_at is not null and
           row(new.title,new.details,new.status) is distinct from row(old.title,old.details,old.status)) then
      raise exception 'Personal plan identity, revision and tombstone are immutable' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

commit;
