begin;

-- Global email admission caps share the existing recipient event journal.
create index email_registration_global_window on email_registration_rate_events(kind,created_at desc);

-- Operator-only, explicit binding. Runtime must not bind a replacement identity
-- key silently: changing an HMAC secret must not recreate a used gift right.
create table phone_verification_control (
  id integer primary key check (id=1),
  identity_key_fingerprint text check (identity_key_fingerprint ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  policy jsonb,
  bound_at timestamptz,
  check ((identity_key_fingerprint is null)=(policy_fingerprint is null)),
  check ((identity_key_fingerprint is null)=(policy is null)),
  check ((identity_key_fingerprint is null)=(bound_at is null)),
  check (policy is null or jsonb_typeof(policy)='object')
);
insert into phone_verification_control(id) values(1);

-- No raw phone, IP, code or session token is persisted here. Phone/proof/code
-- digests are purpose-separated caller HMACs. A challenge belongs to one user.
create table phone_verification_challenges (
  id uuid primary key,
  user_id bigint not null references users(id),
  phone_key text not null check (phone_key ~ '^[a-f0-9]{64}$'),
  proof_hash text not null check (proof_hash ~ '^[a-f0-9]{64}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text not null check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  delivery text not null default 'pending' check (delivery in ('pending','accepted','failed')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  superseded_at timestamptz,
  consumed_at timestamptz,
  consumed_operation_id uuid unique references ai_credit_entries(operation_id),
  check (expires_at>created_at),
  check ((consumed_at is null)=(consumed_operation_id is null)),
  check (consumed_at is null or (delivery='accepted' and attempts<5 and superseded_at is null and consumed_at<=expires_at))
);
create index phone_verification_user_pending on phone_verification_challenges(user_id,created_at desc)
  where consumed_at is null and superseded_at is null;

-- Every admitted send consumes these durable count limits before network I/O,
-- including failed/unknown delivery. These are NOT invented SMS money costs.
create table phone_verification_sends (
  id uuid primary key,
  challenge_id uuid not null references phone_verification_challenges(id),
  user_id bigint not null references users(id),
  phone_key text not null check (phone_key ~ '^[a-f0-9]{64}$'),
  ip_key text not null check (ip_key ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text not null check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index phone_verification_send_user on phone_verification_sends(user_id,created_at desc);
create index phone_verification_send_phone on phone_verification_sends(phone_key,created_at desc);
create index phone_verification_send_ip on phone_verification_sends(ip_key,created_at desc);
create index phone_verification_send_global on phone_verification_sends(created_at desc);

-- Financial/anti-abuse tombstones survive account retirement. No cascading FK
-- or runtime DELETE privilege may resurrect a claim on a recreated account.
create table phone_welcome_claims (
  user_id bigint primary key references users(id),
  phone_key text not null unique check (phone_key ~ '^[a-f0-9]{64}$'),
  challenge_id uuid not null unique references phone_verification_challenges(id),
  operation_id uuid not null unique references ai_credit_entries(operation_id),
  granted_micros bigint not null check (granted_micros=500000000),
  claimed_at timestamptz not null default clock_timestamp()
);

create function citygo_guard_phone_challenge() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.id,new.user_id,new.phone_key,new.proof_hash,new.policy_fingerprint,new.created_at)
    is distinct from row(old.id,old.user_id,old.phone_key,old.proof_hash,old.policy_fingerprint,old.created_at)
    or (old.consumed_at is not null and new is distinct from old)
    or (old.superseded_at is not null and new is distinct from old)
    or (new.attempts<old.attempts and (new.code_hash=old.code_hash or new.delivery<>'pending')) then
    raise exception 'Phone challenge identity and consumption are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger phone_challenge_identity before update on phone_verification_challenges
  for each row execute function citygo_guard_phone_challenge();

create function citygo_guard_phone_welcome_claim() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if not exists(select 1 from phone_verification_challenges c
    join ai_credit_entries e on e.operation_id=new.operation_id
    where c.id=new.challenge_id and c.user_id=new.user_id and c.phone_key=new.phone_key
      and c.consumed_operation_id=new.operation_id and c.consumed_at is not null
      and c.delivery='accepted' and c.superseded_at is null
      and e.user_id=new.user_id and e.kind='bonus' and e.amount_micros=new.granted_micros) then
    raise exception 'Phone welcome claim requires its exact consumed challenge and bonus' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger phone_welcome_claim_evidence before insert on phone_welcome_claims
  for each row execute function citygo_guard_phone_welcome_claim();

commit;
