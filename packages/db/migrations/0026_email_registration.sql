begin;

-- Pending registration is not an account or a login session. Existing accounts
-- are deliberately neither changed nor declared verified by this migration.
create table email_registrations (
  id uuid primary key,
  email text not null check (email=lower(email) and email=btrim(email) and char_length(email) between 3 and 254),
  password_hash text not null check (char_length(password_hash) between 1 and 2048),
  proof_hash text not null check (proof_hash ~ '^[a-f0-9]{64}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  recipient_key text not null check (recipient_key ~ '^[a-f0-9]{64}$'),
  delivery text not null default 'pending' check (delivery in ('pending','sent','failed')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_user_id bigint unique references users(id),
  consumed_at timestamptz,
  check (expires_at>created_at),
  check ((consumed_user_id is null)=(consumed_at is null)),
  check (consumed_user_id is null or delivery='sent')
);
create index email_registrations_expiry on email_registrations(expires_at) where consumed_user_id is null;

-- Quotas are shared by API replicas and consumed before external delivery.
-- Keys are caller-computed purpose-separated HMACs, never raw email/IP.
create table email_registration_rate_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('recipient','ip')),
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index email_registration_rate_window on email_registration_rate_events(kind,key_hash,created_at desc);

-- Only a newly consumed registration creates a verification fact. Keeping this
-- separate avoids a fabricated backfill for old accounts/bootstrap admin.
create table account_email_verifications (
  user_id bigint primary key references users(id),
  registration_id uuid not null unique references email_registrations(id),
  email text not null check (email=lower(email) and email=btrim(email) and char_length(email) between 3 and 254),
  verified_at timestamptz not null default clock_timestamp()
);

create function citygo_guard_email_registration() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.id,new.email,new.password_hash,new.proof_hash,new.recipient_key,new.created_at)
    is distinct from row(old.id,old.email,old.password_hash,old.proof_hash,old.recipient_key,old.created_at)
    or (old.consumed_user_id is not null and new is distinct from old)
    or (new.attempts<old.attempts and (new.code_hash=old.code_hash or new.delivery<>'pending')) then
    raise exception 'Registration identity and consumption are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger email_registration_identity before update on email_registrations
  for each row execute function citygo_guard_email_registration();

commit;
