begin;

-- Existing-account confirmation has its own proof. It never creates a user,
-- registration, session, consent, phone claim or credit entry.
create table account_email_confirmation_challenges (
  id uuid primary key,
  user_id bigint not null references users(id),
  email text not null check (email=lower(email) and email=btrim(email) and char_length(email) between 3 and 254),
  credential_digest text not null check (credential_digest ~ '^[a-f0-9]{64}$'),
  session_token_hash text not null check (session_token_hash ~ '^[a-f0-9]{64}$'),
  proof_hash text not null check (proof_hash ~ '^[a-f0-9]{64}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  recipient_key text not null check (recipient_key ~ '^[a-f0-9]{64}$'),
  delivery text not null default 'pending' check (delivery in ('pending','sent','failed')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  check (expires_at>created_at),
  check (consumed_at is null or (delivery='sent' and attempts<5 and invalidated_at is null and consumed_at<=expires_at))
);
create index account_email_confirmation_pending on account_email_confirmation_challenges(user_id,created_at desc)
  where consumed_at is null and invalidated_at is null;

create function citygo_guard_account_email_confirmation() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.id,new.user_id,new.email,new.credential_digest,new.session_token_hash,new.proof_hash,new.recipient_key,new.created_at,new.expires_at)
    is distinct from row(old.id,old.user_id,old.email,old.credential_digest,old.session_token_hash,old.proof_hash,old.recipient_key,old.created_at,old.expires_at)
    or ((old.consumed_at is not null or old.invalidated_at is not null) and new is distinct from old)
    or new.attempts<old.attempts then
    raise exception 'Account email confirmation identity and terminal state are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger account_email_confirmation_identity before update on account_email_confirmation_challenges
  for each row execute function citygo_guard_account_email_confirmation();

-- All old registration evidence survives unchanged. New confirmations point to
-- their own consumed challenge; a registration receipt is never fabricated.
alter table account_email_verifications alter column registration_id drop not null;
alter table account_email_verifications add column confirmation_id uuid unique references account_email_confirmation_challenges(id);
alter table account_email_verifications add constraint account_email_verification_provenance
  check (num_nonnulls(registration_id,confirmation_id)=1);

create function citygo_guard_account_email_verification_proof() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.registration_id is not null then
    if not exists(select 1 from email_registrations r where r.id=new.registration_id
      and r.consumed_user_id=new.user_id and r.email=new.email and r.consumed_at is not null and r.delivery='sent') then
      raise exception 'Email verification requires its consumed registration' using errcode='23514';
    end if;
  else
    if not exists(select 1 from account_email_confirmation_challenges c
      join user_credentials u on u.user_id=c.user_id and u.email=c.email
      where c.id=new.confirmation_id and c.user_id=new.user_id and c.email=new.email
      and c.consumed_at is not null and c.invalidated_at is null and c.delivery='sent') then
      raise exception 'Email verification requires its consumed account confirmation' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger account_email_verification_proof before insert on account_email_verifications
  for each row execute function citygo_guard_account_email_verification_proof();

commit;
