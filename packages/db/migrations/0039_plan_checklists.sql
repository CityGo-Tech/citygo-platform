begin;
-- One bounded, user-authored checklist per private step. No AI or financial data.
create function citygo_valid_plan_checklist(entries jsonb) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog,public,pg_temp as $$
declare entry jsonb;
begin
  if jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)>20 then return false; end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry)<>'object' or (select count(*) from jsonb_object_keys(entry))<>4
      or not (entry ?& array['id','title','details','completed'])
      or jsonb_typeof(entry->'id')<>'string' or (entry->>'id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(entry->'title')<>'string' or char_length(entry->>'title') not between 1 and 120 or entry->>'title'<>btrim(entry->>'title')
      or jsonb_typeof(entry->'details')<>'string' or char_length(entry->>'details')>1000 or entry->>'details'<>btrim(entry->>'details')
      or jsonb_typeof(entry->'completed')<>'boolean' then return false; end if;
  end loop;
  return (select count(*)=count(distinct value->>'id') from jsonb_array_elements(entries));
end;
$$;
create table personal_plan_checklists (
  item_id bigint primary key references personal_plan_items(id) on delete cascade,
  parent_revision bigint not null check(parent_revision between 1 and 9007199254740991),
  entries jsonb not null check(citygo_valid_plan_checklist(entries))
);
create function citygo_guard_plan_checklist() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if not exists(select 1 from personal_plan_items p join users u on u.id=p.user_id
    where p.id=new.item_id and p.deleted_at is null and p.revision=new.parent_revision
    and u.status='active' and not u.must_change_password)
    or (tg_op='UPDATE' and (new.item_id<>old.item_id or new.parent_revision<=old.parent_revision)) then
    raise exception 'Invalid private checklist identity or parent revision' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger personal_plan_checklist_guard before insert or update on personal_plan_checklists
  for each row execute function citygo_guard_plan_checklist();
commit;
