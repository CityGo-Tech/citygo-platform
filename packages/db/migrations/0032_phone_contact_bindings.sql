begin;

-- Contact ownership is independent of the permanently spent phone gift right.
-- No phone/OTP/session plaintext, new bonus or financial backfill belongs here.
create table phone_contact_bindings (
  id uuid primary key,
  user_id bigint not null references users(id),
  phone_key text not null check (phone_key ~ '^[a-f0-9]{64}$'),
  proof_user_id bigint not null references users(id),
  source_challenge_id uuid not null references phone_verification_challenges(id),
  source_claim_operation_id uuid not null references phone_welcome_claims(operation_id),
  policy_fingerprint text not null check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  method text not null default 'phone_code' check (method in ('phone_code','operator_transfer')),
  previous_binding_id uuid references phone_contact_bindings(id),
  bind_operation_id uuid not null unique,
  bound_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz,
  unlink_operation_id uuid unique,
  check ((unlinked_at is null)=(unlink_operation_id is null)),
  check (unlinked_at is null or unlinked_at>=bound_at),
  check ((method='phone_code' and proof_user_id=user_id and previous_binding_id is null
           and bind_operation_id=source_claim_operation_id and id=source_claim_operation_id)
    or (method='operator_transfer' and previous_binding_id is not null))
);
create unique index phone_contact_one_active_phone on phone_contact_bindings(phone_key) where unlinked_at is null;
create unique index phone_contact_one_active_user on phone_contact_bindings(user_id) where unlinked_at is null;
create index phone_contact_binding_user on phone_contact_bindings(user_id,bound_at,id);
create index phone_contact_binding_proof_user on phone_contact_bindings(proof_user_id);
create index phone_contact_binding_challenge on phone_contact_bindings(source_challenge_id);
create index phone_contact_binding_claim on phone_contact_bindings(source_claim_operation_id);
create index phone_contact_binding_previous on phone_contact_bindings(previous_binding_id);

-- The operator authorizes an unlink/transfer, never a fictional target SMS or gift.
create table phone_contact_changes (
  operation_id uuid primary key,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  from_user_id bigint not null references users(id),
  to_user_id bigint references users(id),
  source_binding_id uuid not null unique references phone_contact_bindings(id),
  target_binding_id uuid unique references phone_contact_bindings(id),
  phone_key text not null check (phone_key ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text not null check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  authority_sha256 text not null check (authority_sha256 ~ '^[a-f0-9]{64}$'),
  reason text not null check (reason='owner-request'),
  changed_at timestamptz not null default clock_timestamp(),
  check ((to_user_id is null)=(target_binding_id is null)),
  check (to_user_id is null or to_user_id<>from_user_id)
);
create index phone_contact_change_from on phone_contact_changes(from_user_id,changed_at);
create index phone_contact_change_to on phone_contact_changes(to_user_id,changed_at) where to_user_id is not null;

create function citygo_guard_phone_contact_binding() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare operator_allowed boolean;
begin
  select current_user not in ('citygo_api','citygo_worker','citygo_backup')
    and (current_user=pg_get_userbyid(c.relowner) or r.rolsuper)
    into operator_allowed from pg_class c join pg_roles r on r.rolname=current_user
    where c.oid='public.phone_contact_bindings'::regclass;
  if TG_OP='DELETE' then
    raise exception 'Phone contact history is retained' using errcode='23514';
  elsif TG_OP='UPDATE' then
    if not operator_allowed then
      raise exception 'Phone contact changes require the database operator' using errcode='42501';
    end if;
    if row(new.id,new.user_id,new.phone_key,new.proof_user_id,new.source_challenge_id,new.source_claim_operation_id,
      new.policy_fingerprint,new.method,new.previous_binding_id,new.bind_operation_id,new.bound_at)
      is distinct from row(old.id,old.user_id,old.phone_key,old.proof_user_id,old.source_challenge_id,old.source_claim_operation_id,
      old.policy_fingerprint,old.method,old.previous_binding_id,old.bind_operation_id,old.bound_at)
      or old.unlinked_at is not null or new.unlinked_at is null or new.unlink_operation_id is null then
      raise exception 'Phone contact identity and terminal unlink are immutable' using errcode='23514';
    end if;
    return new;
  end if;
  if new.unlinked_at is not null or new.unlink_operation_id is not null then
    raise exception 'New phone contact must be active' using errcode='23514';
  end if;
  if not exists(select 1 from public.phone_welcome_claims w
    join public.phone_verification_challenges c on c.id=w.challenge_id and c.user_id=w.user_id and c.phone_key=w.phone_key
    join public.ai_credit_entries e on e.operation_id=w.operation_id and e.user_id=w.user_id
      and e.kind='bonus' and e.amount_micros=w.granted_micros
    join public.phone_verification_control p on p.id=1 and p.bound_at is not null
      and p.policy_fingerprint=c.policy_fingerprint and p.policy_fingerprint=new.policy_fingerprint
    where w.user_id=new.proof_user_id and w.phone_key=new.phone_key and w.challenge_id=new.source_challenge_id
      and w.operation_id=new.source_claim_operation_id and w.granted_micros=500000000
      and c.delivery='accepted' and c.superseded_at is null and c.consumed_at is not null
      and c.consumed_operation_id=w.operation_id and c.consumed_at<=c.expires_at and new.bound_at>=c.consumed_at)
    or not exists(select 1 from public.users where id=new.user_id and status='active') then
    raise exception 'Phone contact requires its exact retained proof' using errcode='23514';
  end if;
  if new.method='operator_transfer' then
    if not operator_allowed then
      raise exception 'Phone contact transfer requires the database operator' using errcode='42501';
    end if;
    if not exists(select 1 from public.phone_contact_bindings b where b.id=new.previous_binding_id
      and b.user_id<>new.user_id and b.phone_key=new.phone_key and b.proof_user_id=new.proof_user_id
      and b.source_challenge_id=new.source_challenge_id and b.source_claim_operation_id=new.source_claim_operation_id
      and b.policy_fingerprint=new.policy_fingerprint and b.unlinked_at is not null
      and b.unlink_operation_id=new.bind_operation_id and b.unlinked_at<=new.bound_at) then
      raise exception 'Transferred contact requires the exact terminal source binding' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger phone_contact_binding_guard before insert or update or delete on phone_contact_bindings
  for each row execute function citygo_guard_phone_contact_binding();

create function citygo_guard_phone_contact_change() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare operator_allowed boolean;
begin
  if TG_OP<>'INSERT' then
    raise exception 'Phone contact operator receipts are append-only' using errcode='23514';
  end if;
  select current_user not in ('citygo_api','citygo_worker','citygo_backup')
    and (current_user=pg_get_userbyid(c.relowner) or r.rolsuper)
    into operator_allowed from pg_class c join pg_roles r on r.rolname=current_user
    where c.oid='public.phone_contact_changes'::regclass;
  if not operator_allowed then
    raise exception 'Phone contact receipt requires the database operator' using errcode='42501';
  end if;
  if not exists(select 1 from public.phone_contact_bindings b where b.id=new.source_binding_id
    and b.user_id=new.from_user_id and b.phone_key=new.phone_key and b.policy_fingerprint=new.policy_fingerprint
    and b.unlinked_at is not null and b.unlink_operation_id=new.operation_id and b.unlinked_at<=new.changed_at) then
    raise exception 'Phone contact receipt requires its exact unlink' using errcode='23514';
  end if;
  if new.to_user_id is not null and not exists(select 1 from public.phone_contact_bindings b
    where b.id=new.target_binding_id and b.user_id=new.to_user_id and b.phone_key=new.phone_key
      and b.policy_fingerprint=new.policy_fingerprint and b.previous_binding_id=new.source_binding_id
      and b.method='operator_transfer' and b.bind_operation_id=new.operation_id
      and b.unlinked_at is null and b.bound_at<=new.changed_at) then
    raise exception 'Phone transfer receipt requires its exact active target' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger phone_contact_change_guard before insert or update or delete on phone_contact_changes
  for each row execute function citygo_guard_phone_contact_change();

create function citygo_guard_phone_contact_completion() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.method='operator_transfer' then
    if not exists(select 1 from public.phone_contact_changes c
      where c.operation_id=new.bind_operation_id and c.target_binding_id=new.id and c.to_user_id=new.user_id
        and c.source_binding_id=new.previous_binding_id and c.phone_key=new.phone_key) then
      raise exception 'Transferred phone contact requires its committed operator receipt' using errcode='23514';
    end if;
  end if;
  if new.unlinked_at is not null then
    if not exists(select 1 from public.phone_contact_changes c
      where c.operation_id=new.unlink_operation_id and c.source_binding_id=new.id
        and c.from_user_id=new.user_id and c.phone_key=new.phone_key) then
      raise exception 'Unlinked phone contact requires its committed operator receipt' using errcode='23514';
    end if;
  end if;
  return null;
end;
$$;
create constraint trigger phone_contact_binding_completion after insert or update on phone_contact_bindings
  deferrable initially deferred for each row execute function citygo_guard_phone_contact_completion();

-- Refuse broken old proof rather than invent a contact or discard its gift right.
do $$ begin
  if exists(select 1 from phone_welcome_claims w where not exists(
    select 1 from phone_verification_challenges c join ai_credit_entries e on e.operation_id=w.operation_id
    join phone_verification_control p on p.id=1 and p.bound_at is not null and p.policy_fingerprint=c.policy_fingerprint
    where c.id=w.challenge_id and c.user_id=w.user_id and c.phone_key=w.phone_key
      and c.consumed_at is not null and c.consumed_operation_id=w.operation_id and c.delivery='accepted'
      and c.superseded_at is null and c.consumed_at<=c.expires_at and w.claimed_at>=c.consumed_at
      and e.user_id=w.user_id and e.kind='bonus' and e.amount_micros=w.granted_micros))
    or exists(select 1 from phone_verification_challenges c where c.consumed_at is not null
      and not exists(select 1 from phone_welcome_claims w where w.challenge_id=c.id
        and w.user_id=c.user_id and w.phone_key=c.phone_key and w.operation_id=c.consumed_operation_id)) then
    raise exception 'Existing phone gift evidence requires review before contact projection' using errcode='23514';
  end if;
end $$;
insert into phone_contact_bindings(id,user_id,phone_key,proof_user_id,source_challenge_id,
  source_claim_operation_id,policy_fingerprint,bind_operation_id,bound_at)
  select w.operation_id,w.user_id,w.phone_key,w.user_id,w.challenge_id,w.operation_id,c.policy_fingerprint,w.operation_id,w.claimed_at
    from phone_welcome_claims w join phone_verification_challenges c on c.id=w.challenge_id
    join users u on u.id=w.user_id and u.status='active';

commit;
