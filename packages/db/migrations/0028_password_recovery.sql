begin;

-- A decoy has no account, credential snapshot or raw recipient. Issuance never
-- declares old email addresses verified and never creates a login session.
create table password_recovery_challenges (
  id uuid primary key,
  target_user_id bigint references users(id),
  credential_digest text check (credential_digest ~ '^[a-f0-9]{64}$'),
  proof_hash text not null check (proof_hash ~ '^[a-f0-9]{64}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  recipient_key text not null check (recipient_key ~ '^[a-f0-9]{64}$'),
  delivery text not null default 'pending' check (delivery in ('pending','sent','failed')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  check ((target_user_id is null)=(credential_digest is null)),
  check (expires_at>created_at),
  check (consumed_at is null or (target_user_id is not null and delivery='sent' and attempts<5 and invalidated_at is null and consumed_at<=expires_at))
);
create index password_recovery_user_pending on password_recovery_challenges(target_user_id)
  where consumed_at is null and invalidated_at is null;
create index password_recovery_expiry on password_recovery_challenges(expires_at)
  where consumed_at is null and invalidated_at is null;

create function citygo_guard_password_recovery() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.id,new.target_user_id,new.credential_digest,new.proof_hash,new.recipient_key,new.created_at,new.expires_at)
    is distinct from row(old.id,old.target_user_id,old.credential_digest,old.proof_hash,old.recipient_key,old.created_at,old.expires_at)
    or ((old.consumed_at is not null or old.invalidated_at is not null) and new is distinct from old)
    or new.attempts<old.attempts then
    raise exception 'Password recovery identity, lifetime and terminal state are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger password_recovery_identity before update on password_recovery_challenges
  for each row execute function citygo_guard_password_recovery();

commit;
