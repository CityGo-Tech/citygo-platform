begin;

-- Actual saved states only. Earlier revisions are never reconstructed.
create table personal_plan_item_history (
  item_id bigint not null references personal_plan_items(id) on delete cascade,
  revision bigint not null check(revision between 1 and 9007199254740991),
  title text not null check(char_length(title) between 1 and 120 and title=btrim(title)),
  details text not null check(char_length(details)<=4000 and details=btrim(details)),
  status text not null check(status in ('pending','completed')),
  checklist jsonb not null check(citygo_valid_plan_checklist(checklist)),
  initial_snapshot boolean not null default false,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(item_id,revision)
);

insert into personal_plan_item_history(item_id,revision,title,details,status,checklist,initial_snapshot)
select p.id,p.revision,p.title,p.details,p.status,coalesce(c.entries,'[]'::jsonb),true
from personal_plan_items p left join personal_plan_checklists c on c.item_id=p.id
where p.deleted_at is null;

create function citygo_guard_personal_plan_history() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  -- Preserve the existing parent/user/source hard-delete cascade. A direct
  -- history DELETE while its step exists is still forbidden.
  if tg_op='DELETE' and not exists(select 1 from personal_plan_items where id=old.item_id) then
    return old;
  end if;
  if tg_op<>'INSERT' then
    raise exception 'Plan history is append-only' using errcode='23514';
  end if;
  if new.initial_snapshot or not exists(
    select 1 from personal_plan_items p join users u on u.id=p.user_id
    left join personal_plan_checklists c on c.item_id=p.id
    where p.id=new.item_id and p.deleted_at is null and u.status='active' and not u.must_change_password
      and p.revision=new.revision and p.title=new.title and p.details=new.details and p.status=new.status
      and coalesce(c.entries,'[]'::jsonb)=new.checklist
  ) then
    raise exception 'Plan history must match the current private step' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger personal_plan_history_guard before insert or update or delete on personal_plan_item_history
  for each row execute function citygo_guard_personal_plan_history();

commit;
