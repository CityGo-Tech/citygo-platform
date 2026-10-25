begin;

-- Explicitly confirmed private facts. The immutable message reference records
-- provenance, not a claim that a model's suggestion was originally true.
create table personal_memory_items (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  source_message_id bigint not null references messages(id) on delete cascade,
  operation_id uuid not null,
  create_request_hash text not null check (create_request_hash ~ '^[a-f0-9]{64}$'),
  label text not null,
  value text not null,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique(user_id,operation_id),
  check (updated_at>=created_at),
  check ((deleted_at is null and char_length(label) between 1 and 80 and label=btrim(label)
      and char_length(value) between 1 and 800 and value=btrim(value))
    or (deleted_at is not null and deleted_at=updated_at and label='' and value=''))
);
create index personal_memory_active_owner_id on personal_memory_items(user_id,id desc)
  where deleted_at is null;
create index personal_memory_source_message on personal_memory_items(source_message_id);

create function citygo_guard_personal_memory_item() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='INSERT' then
    -- Same user -> item order as all application writers. Serialize the small
    -- per-user capacity check even for callers using the runtime's INSERT grant.
    perform id from users where id=new.user_id and status='active'
      and not must_change_password for update;
    if not found then
      raise exception 'Personal memory owner must be active' using errcode='23514';
    end if;
    if new.revision<>1 or new.deleted_at is not null or not exists (
      select 1 from messages m join agent_threads t on t.id=m.thread_id
      where m.id=new.source_message_id and t.user_id=new.user_id
        and m.role in ('user','assistant')
        and coalesce(m.metadata->>'status','complete')='complete'
    ) then
      raise exception 'Personal memory requires a complete owned source' using errcode='23514';
    end if;
    if (select count(*) from personal_memory_items where user_id=new.user_id and deleted_at is null)>=20 then
      raise exception 'Personal memory capacity exceeded' using errcode='23514';
    end if;
  else
    if row(new.id,new.user_id,new.source_message_id,new.operation_id,new.create_request_hash,new.created_at)
       is distinct from row(old.id,old.user_id,old.source_message_id,old.operation_id,old.create_request_hash,old.created_at)
       or old.deleted_at is not null or new.revision<>old.revision+1
       or new.updated_at<=old.updated_at then
      raise exception 'Personal memory identity, revision and tombstone are immutable' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger personal_memory_item_guard before insert or update on personal_memory_items
  for each row execute function citygo_guard_personal_memory_item();

commit;
