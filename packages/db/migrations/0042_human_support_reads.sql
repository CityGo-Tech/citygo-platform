-- Existing replies have no read evidence. No backfill silently marks them seen.
create table human_support_reads (
  request_id bigint primary key references human_support_requests(id),
  user_id bigint not null references users(id),
  through_reply_id bigint not null references human_support_replies(id),
  read_at timestamptz not null default clock_timestamp()
);
create index human_support_reads_user_idx on human_support_reads(user_id);
create index human_support_reads_reply_idx on human_support_reads(through_reply_id);

create function citygo_guard_support_read() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Support read evidence cannot be deleted' using errcode='23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.request_id <> old.request_id or new.user_id <> old.user_id or
       new.through_reply_id < old.through_reply_id then
      raise exception 'Support read cursor cannot change owner or move backwards' using errcode='23514';
    end if;
  end if;
  perform 1 from human_support_requests r join human_support_replies p on p.request_id=r.id
    where r.id=new.request_id and r.user_id=new.user_id and p.id=new.through_reply_id;
  if not found then
    raise exception 'Support read cursor must identify an owned reply' using errcode='23514';
  end if;
  if tg_op = 'UPDATE' and new.through_reply_id = old.through_reply_id then
    new.read_at := old.read_at;
  else
    new.read_at := clock_timestamp();
  end if;
  return new;
end $$;
create trigger human_support_reads_guard before insert or update or delete on human_support_reads
  for each row execute function citygo_guard_support_read();
