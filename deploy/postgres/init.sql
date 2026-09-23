\set ON_ERROR_STOP on
-- First initialization of a NEW, empty volume only. Never rotate existing keys.
do $$
declare item record; secret text;
begin
  for item in select * from (values
    ('citygo_migrator','db_migrate_password'),
    ('citygo_api','db_api_password'),
    ('citygo_worker','db_worker_password'),
    ('citygo_backup','db_backup_password')
  ) as roles(role_name,file_name)
  loop
    secret := btrim(pg_read_file('/run/secrets/' || item.file_name), E'\r\n');
    if secret !~ '^[a-f0-9]{64}$' then raise exception 'Invalid generated DB secret'; end if;
    execute format('create role %I login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', item.role_name, secret);
  end loop;
exception when others then
  raise exception 'CityGo role initialization failed; inspect protected configuration';
end $$;
revoke all on database citygo_pilot from public;
grant connect on database citygo_pilot to citygo_migrator, citygo_api, citygo_worker, citygo_backup;
revoke all on schema public from public;
grant usage, create on schema public to citygo_migrator;
grant usage on schema public to citygo_api, citygo_worker, citygo_backup;
alter role citygo_api connection limit 12;
alter role citygo_worker connection limit 2;
alter role citygo_migrator connection limit 3;
alter role citygo_backup connection limit 2;
alter role citygo_api set statement_timeout = '10s';
alter role citygo_worker set statement_timeout = '10s';
alter role citygo_backup set default_transaction_read_only = on;
-- Defaults apply to the actual migration owner, not the bootstrap superuser.
alter default privileges for role citygo_migrator in schema public grant select on tables to citygo_backup;
alter default privileges for role citygo_migrator in schema public grant select on sequences to citygo_backup;
-- PUBLIC EXECUTE is a global default: a per-schema REVOKE cannot remove it.
alter default privileges for role citygo_migrator revoke execute on functions from public;
-- API/worker permissions are explicit and fail closed for new tables.
