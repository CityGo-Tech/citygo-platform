-- CG-018 synthetic fixture ONLY. Never applied by migrate/release/deploy.
-- No reference to actual users, consents, budgets or housing data; no grants.
create schema cg018_synthetic;
revoke all on schema cg018_synthetic from public;

create table cg018_synthetic.notices (
  scope text not null check (scope in ('citygo_context', 'ai_transfer')),
  version text not null check (length(version) between 1 and 80 and version ~ '^[a-z0-9][a-z0-9._-]*$'),
  notice_id text not null unique check (notice_id ~ '^[a-f0-9]{64}$'),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  primary key (scope, version)
);

create table cg018_synthetic.configurations (
  revision integer primary key check (revision > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  recorded_at timestamptz not null default clock_timestamp()
);
insert into cg018_synthetic.configurations values
  (1, '{"mode":"synthetic_only","notices":[],"current":{"citygo_context":null,"ai_transfer":null},"route":null}', clock_timestamp());

create table cg018_synthetic.runtime (
  id integer primary key check (id = 1),
  mode text not null check (mode = 'synthetic_only'),
  configuration_revision integer not null references cg018_synthetic.configurations(revision),
  max_route_revision integer not null check (max_route_revision >= 0)
);
insert into cg018_synthetic.runtime values (1, 'synthetic_only', 1, 0);

create table cg018_synthetic.commands (
  owner_id text not null check (length(owner_id) between 1 and 200 and owner_id !~ '[[:space:]]'),
  scope text not null check (scope in ('citygo_context', 'ai_transfer')),
  request_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  command jsonb not null check (jsonb_typeof(command) = 'object'),
  event_id uuid not null unique,
  result_revision integer not null check (result_revision > 0),
  configuration_revision integer not null references cg018_synthetic.configurations(revision),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, scope, request_id),
  unique (owner_id, scope, result_revision, event_id),
  unique (owner_id, scope, result_revision)
);

create table cg018_synthetic.decisions (
  owner_id text not null,
  scope text not null,
  revision integer not null check (revision > 0),
  event_id uuid not null,
  primary key (owner_id, scope),
  foreign key (owner_id, scope, revision, event_id)
    references cg018_synthetic.commands(owner_id, scope, result_revision, event_id)
);

create function cg018_synthetic.keep_history() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $history$
begin
  raise exception 'CG018_SYNTHETIC_IMMUTABLE_HISTORY' using errcode = '23514';
end
$history$;
revoke all on function cg018_synthetic.keep_history() from public;
create trigger commands_immutable before update or delete on cg018_synthetic.commands
  for each row execute function cg018_synthetic.keep_history();
create trigger configurations_immutable before update or delete on cg018_synthetic.configurations
  for each row execute function cg018_synthetic.keep_history();
create trigger notices_immutable before update or delete on cg018_synthetic.notices
  for each row execute function cg018_synthetic.keep_history();
-- The history trigger is a fixture invariant, not a production erasure policy.
-- Dropping the disposable test database/container removes the entire fixture.
