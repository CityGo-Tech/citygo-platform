begin;

-- Explicit owner-authored requests. No messages, money, AI calls or worker jobs.
create table human_support_requests (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  operation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  body text not null check (char_length(body) between 20 and 4000 and body=btrim(body)),
  status text not null default 'open' check (status in ('open','closed')),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  unique(user_id,operation_id),
  check (updated_at>=created_at),
  check ((status='closed')=(closed_at is not null))
);
create index human_support_owner_history on human_support_requests(user_id,id desc);
create index human_support_inbox on human_support_requests(status,id desc);
create function citygo_guard_human_support_request() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.status<>'open' or new.revision<>1 or new.closed_at is not null then
      raise exception 'Invalid support request initial state' using errcode='23514';
    end if;
  elsif row(new.id,new.user_id,new.operation_id,new.request_hash,new.body,new.created_at)
    is distinct from row(old.id,old.user_id,old.operation_id,old.request_hash,old.body,old.created_at)
    or new.revision<>old.revision+1 or new.updated_at<=old.updated_at
    or (new.status='closed' and new.closed_at<>new.updated_at) then
    raise exception 'Support request identity and revision are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger human_support_request_guard before insert or update on human_support_requests
  for each row execute function citygo_guard_human_support_request();

commit;
