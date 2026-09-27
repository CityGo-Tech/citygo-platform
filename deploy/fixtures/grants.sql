-- Run AFTER migrations as their owner, never as the application's runtime role.
grant select, insert, update, delete on all tables in schema public to citygo_api;
grant usage, select on all sequences in schema public to citygo_api;
revoke all on citygo_migrations, citygo_migration_lock from citygo_api;
grant select on citygo_migrations to citygo_api;
-- Match the production credit ledger's append-only boundary.
revoke update, delete on ai_credit_entries from citygo_api;
revoke delete on ai_credit_accounts from citygo_api;
revoke delete on ai_credit_charges from citygo_api;
grant select, delete on sessions, analytics_events to citygo_worker;
grant select, update on agent_threads, chat_requests to citygo_worker;
