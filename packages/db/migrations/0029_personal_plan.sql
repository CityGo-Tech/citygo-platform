begin;

-- Private actions explicitly chosen by the owner, not profile facts, quests or
-- evidence that a model's advice is true. Removed rows retain replay identity.
create table personal_plan_items (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  source_message_id bigint not null references messages(id) on delete cascade,
  operation_id uuid not null,
  create_request_hash text not null check (create_request_hash ~ '^[a-f0-9]{64}$'),
  title text not null check (char_length(title) between 1 and 120 and title=btrim(title)),
  details text not null check (char_length(details)<=4000 and details=btrim(details)),
  status text not null default 'pending' check (status in ('pending','completed')),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique(user_id,operation_id),
  check (updated_at>=created_at),
  check (deleted_at is null or deleted_at=updated_at)
);
create index personal_plan_active_owner_id on personal_plan_items(user_id,id desc)
  where deleted_at is null;
-- The unique owner/operation index also supports user deletion; this index
-- bounds message cascades, including retained tombstones.
create index personal_plan_source_message on personal_plan_items(source_message_id);

create function citygo_guard_personal_plan_item() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if not exists (
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
create trigger personal_plan_item_guard before insert or update on personal_plan_items
  for each row execute function citygo_guard_personal_plan_item();

commit;
