begin;

-- Private display metadata only. Neither thread context nor its update/order changes.
-- Clearing retains the revision so an old browser cannot overwrite a newer title.
create table conversation_titles (
  thread_id bigint primary key references agent_threads(id) on delete cascade,
  user_id bigint not null references users(id),
  title text check (title is null or (char_length(title) between 1 and 80 and octet_length(title)<=320 and char_length(title)+char_length(regexp_replace(title, '[^\U00010000-\U0010FFFF]', '', 'g'))<=80 and position(chr(8232) in title)=0 and position(chr(8233) in title)=0 and btrim(title)<>'' and title !~ '[[:cntrl:]]')),
  revision bigint not null default 1 check (revision>=1),
  updated_at timestamptz not null default clock_timestamp()
);
create index conversation_titles_user_idx on conversation_titles(user_id);
create function citygo_guard_conversation_title() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'Conversation title revisions cannot be deleted by runtime' using errcode='23514';
  end if;
  if tg_op='INSERT' and new.revision<>1 then
    raise exception 'Conversation title starts at revision one' using errcode='23514';
  end if;
  if tg_op='UPDATE' and (new.thread_id<>old.thread_id or new.user_id<>old.user_id or
      old.revision=9223372036854775807 or new.revision<>old.revision+1 or new.title is not distinct from old.title) then
    raise exception 'Conversation title identity and revision are immutable' using errcode='23514';
  end if;
  perform 1 from agent_threads where id=new.thread_id and user_id=new.user_id;
  if not found then
    raise exception 'Conversation title must belong to its thread owner' using errcode='23514';
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end $$;
create trigger conversation_titles_guard before insert or update or delete on conversation_titles
  for each row execute function citygo_guard_conversation_title();
revoke all on function citygo_guard_conversation_title() from public;

commit;
