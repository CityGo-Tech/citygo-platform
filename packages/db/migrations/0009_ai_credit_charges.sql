begin;

-- No grants, backfill, network calls or activation. Existing holds are untouched.
create table ai_credit_charges (
  hold_id uuid primary key references ai_credit_entries(operation_id),
  user_id bigint not null references ai_credit_accounts(user_id),
  thread_id bigint not null,
  request_id uuid not null,
  attempt_number smallint not null check (attempt_number=1),
  model text not null check (length(model) between 1 and 200),
  upstream text not null check (upstream ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  dispatched boolean not null default false,
  generation_id text unique check (generation_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
  response_complete boolean not null default false,
  receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(thread_id,request_id,attempt_number),
  foreign key(thread_id,request_id,attempt_number) references ai_model_attempts(thread_id,request_id,attempt_number),
  check (generation_id is null or dispatched),
  check (not response_complete or dispatched),
  check (receipt is null or (response_complete and generation_id is not null))
);
create index ai_credit_charges_user on ai_credit_charges(user_id,created_at desc);

commit;
