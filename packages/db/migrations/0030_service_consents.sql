begin;

-- Existing users and pending challenges intentionally receive no consent.
alter table email_registrations
  add column consent_choice jsonb,
  add column consent_policy jsonb,
  add column consent_policy_hash text,
  add column consent_recorded_at timestamptz,
  add constraint email_registration_consent_snapshot check (
    (consent_choice is null and consent_policy is null and consent_policy_hash is null and consent_recorded_at is null)
    or (consent_choice is not null and consent_policy is not null
      and consent_policy_hash is not null and consent_policy_hash ~ '^[a-f0-9]{64}$' and consent_recorded_at is not null
      and jsonb_typeof(consent_choice)='object' and jsonb_typeof(consent_policy)='object'
      and (consent_choice->'personalData'='true'::jsonb) is true
      and (jsonb_typeof(consent_choice->'marketing')='boolean') is true
      and (jsonb_typeof(consent_choice->'policyVersion')='string') is true
      and (jsonb_typeof(consent_policy->'version')='string') is true
      and (consent_choice->>'policyVersion'=consent_policy->>'version') is true)
  );

create function citygo_guard_registration_consent() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if row(new.consent_choice,new.consent_policy,new.consent_policy_hash,new.consent_recorded_at)
    is distinct from row(old.consent_choice,old.consent_policy,old.consent_policy_hash,old.consent_recorded_at) then
    raise exception 'Registration consent snapshot is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger email_registration_consent_identity before update on email_registrations
  for each row execute function citygo_guard_registration_consent();

-- Append-only evidence. No raw IP, user agent, OTP or password is retained here.
-- Both the optional decline and its later withdrawal are explicit events.
create table service_consent_events (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  subject_email text not null check (subject_email=lower(subject_email) and char_length(subject_email) between 3 and 254),
  registration_id uuid references email_registrations(id),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot)='object'),
  policy_hash text not null check (policy_hash ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('personal-data','marketing')),
  decision text not null check (decision in ('granted','declined','withdrawn')),
  source text not null check (source in ('signup','email-registration','existing-account')),
  choice_recorded_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  check ((jsonb_typeof(policy_snapshot->'version')='string') is true and (policy_version=policy_snapshot->>'version') is true),
  check (purpose<>'personal-data' or decision='granted'),
  check ((source='email-registration')=(registration_id is not null)),
  check (choice_recorded_at<=created_at)
);
create index service_consent_owner_policy_purpose on service_consent_events(user_id,policy_version,policy_hash,purpose,id desc);
create index service_consent_registration on service_consent_events(registration_id) where registration_id is not null;

create function citygo_guard_service_consent_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  raise exception 'Service consent evidence is append-only' using errcode='23514';
end;
$$;
create trigger service_consent_evidence_immutable before update or delete on service_consent_events
  for each row execute function citygo_guard_service_consent_evidence();
create trigger service_consent_evidence_no_truncate before truncate on service_consent_events
  for each statement execute function citygo_guard_service_consent_evidence();

commit;
