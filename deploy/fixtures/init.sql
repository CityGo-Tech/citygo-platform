-- Disposable container CI only. Real DB provisioning belongs to the next phase.
create role citygo_migrator login password 'synthetic-migrator-only';
create role citygo_api login password 'synthetic-api-only';
create role citygo_worker login password 'synthetic-worker-only';
revoke all on database citygo_smoke from public;
grant connect on database citygo_smoke to citygo_migrator, citygo_api, citygo_worker;
revoke all on schema public from public;
grant usage, create on schema public to citygo_migrator;
grant usage on schema public to citygo_api, citygo_worker;
