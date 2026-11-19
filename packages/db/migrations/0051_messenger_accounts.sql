begin;

create table messenger_accounts (
  provider text not null check (provider in ('telegram','max')),
  subject bigint not null check (subject>0 and (provider<>'telegram' or subject<=4503599627370495)),
  user_id bigint not null references users(id) on delete cascade,
  primary key (provider,subject),
  unique (user_id,provider)
);

-- NULL preserves ordinary password and email-confirmation sessions. A
-- provider session cannot outlive the link, including on account deletion.
alter table sessions add column messenger_provider text;
alter table sessions add constraint sessions_messenger_link
  foreign key (user_id,messenger_provider)
  references messenger_accounts(user_id,provider) on delete cascade;
create index sessions_messenger_owner_idx on sessions(user_id,messenger_provider)
  where messenger_provider is not null;

-- The opaque proof fingerprint has no user identifier or launch contents.
create table messenger_launch_consumptions (
  provider text not null check (provider in ('telegram','max')),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  primary key (provider,fingerprint)
);
create index messenger_launch_consumptions_expiration_idx on messenger_launch_consumptions(expires_at);

create function citygo_guard_messenger_launch_consumption() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if old.expires_at>clock_timestamp() then
    raise exception 'Unexpired messenger launch consumption is immutable' using errcode='23514';
  end if;
  return old;
end;
$$;
create trigger messenger_launch_consumptions_expiration
  before delete on messenger_launch_consumptions
  for each row execute function citygo_guard_messenger_launch_consumption();

commit;
