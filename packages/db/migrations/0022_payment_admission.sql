begin;

-- New checkouts default closed. Settlement, refunds, history and manual NPD
-- evidence do not depend on this switch. Responsibility is an operator report,
-- never evidence of a registered/delivered tax receipt or legal compliance.
create table payment_admission (
  id smallint primary key check(id=1),
  revision integer not null default 1 check(revision>0),
  merchant_id text check(merchant_id ~ '^[1-9][0-9]{0,19}$'),
  runtime_policy_id text check(runtime_policy_id ~ '^[a-f0-9]{64}$'),
  accepting_new_checkouts boolean not null default false,
  reconciliation_enabled boolean not null default false,
  mode text not null default 'closed' check(mode in ('closed','lease','continuous')),
  owner_user_id bigint references users(id),
  lease_session_token_hash text check(lease_session_token_hash ~ '^[a-f0-9]{64}$'),
  lease_until timestamptz,
  manual_npd_responsibility_accepted boolean not null default false,
  reconciliation_checked_at timestamptz,
  reconciliation_ok boolean not null default false,
  reconciliation_run_id uuid,
  reconciliation_run_revision integer,
  reconciliation_run_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check((merchant_id is null)=(runtime_policy_id is null)),
  check(not reconciliation_enabled or merchant_id is not null),
  check((mode='closed' and not accepting_new_checkouts and lease_until is null and lease_session_token_hash is null)
    or(mode='lease' and accepting_new_checkouts and owner_user_id is not null and merchant_id is not null
      and lease_until is not null and lease_session_token_hash is not null)
    or(mode='continuous' and accepting_new_checkouts and owner_user_id is not null and merchant_id is not null
      and lease_until is null and lease_session_token_hash is null and manual_npd_responsibility_accepted)),
  check((reconciliation_run_id is null and reconciliation_run_revision is null and reconciliation_run_until is null)
    or(reconciliation_run_id is not null and reconciliation_run_revision is not null and reconciliation_run_until is not null)),
  check(not reconciliation_ok or reconciliation_checked_at is not null)
);
insert into payment_admission(id) values(1);
create table payment_admission_commands (
  request_id uuid primary key,
  actor_user_id bigint not null references users(id),
  merchant_id text not null check(merchant_id ~ '^[1-9][0-9]{0,19}$'),
  runtime_policy_id text not null check(runtime_policy_id ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=4096),
  result_revision integer not null unique check(result_revision>1),
  result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=8192),
  created_at timestamptz not null default clock_timestamp()
);
create table payment_admission_reconciliation_events (
  run_id uuid primary key,
  admission_revision integer not null check(admission_revision>0),
  merchant_id text not null check(merchant_id ~ '^[1-9][0-9]{0,19}$'),
  runtime_policy_id text not null check(runtime_policy_id ~ '^[a-f0-9]{64}$'),
  success boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
create function citygo_guard_payment_admission_history() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  raise exception 'Payment admission history is append-only' using errcode='23514';
end;
$$;
create trigger payment_admission_commands_immutable before update or delete on payment_admission_commands
  for each row execute function citygo_guard_payment_admission_history();
create trigger payment_admission_commands_no_truncate before truncate on payment_admission_commands
  for each statement execute function citygo_guard_payment_admission_history();
create trigger payment_admission_reconciliation_immutable before update or delete on payment_admission_reconciliation_events
  for each row execute function citygo_guard_payment_admission_history();
create trigger payment_admission_reconciliation_no_truncate before truncate on payment_admission_reconciliation_events
  for each statement execute function citygo_guard_payment_admission_history();
revoke all on payment_admission,payment_admission_commands,payment_admission_reconciliation_events from public;
revoke all on function citygo_guard_payment_admission_history() from public;

commit;
