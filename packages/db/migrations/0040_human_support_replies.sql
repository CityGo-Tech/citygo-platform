begin;

-- Replies stay in CityGo. No message, outbound delivery, AI or money records.
create table human_support_replies (
  id bigint generated always as identity primary key,
  request_id bigint not null references human_support_requests(id),
  author_user_id bigint not null references users(id),
  operation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  body text not null check (char_length(body) between 1 and 4000 and body=btrim(body)),
  created_at timestamptz not null default clock_timestamp(),
  unique(author_user_id,operation_id)
);
create index human_support_reply_history on human_support_replies(request_id,id desc);
create function citygo_guard_human_support_reply() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  raise exception 'Support replies are append-only' using errcode='23514';
end;
$$;
create trigger human_support_reply_guard before update or delete on human_support_replies
  for each row execute function citygo_guard_human_support_reply();

commit;
