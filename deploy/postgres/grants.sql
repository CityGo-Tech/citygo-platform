\set ON_ERROR_STOP on
-- Apply as citygo_migrator after EACH successful migration, before API startup.
begin;
revoke all on all tables in schema public from citygo_api, citygo_worker;
grant select on users, user_credentials, sessions, relocation_profiles,
  questionnaire_answers, relocation_plans, quests, user_quests, xp_events,
  agent_threads, messages, agent_handoffs, consent_events, analytics_events,
  ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing, audit_log,
  chat_requests, ai_model_attempt_daily, ai_user_model_attempt_daily,
  ai_model_attempts, ai_budget, ai_budget_daily, ai_credit_accounts, ai_credit_entries,
  citygo_migrations to citygo_api;
grant insert on users, user_credentials, sessions, relocation_profiles,
  questionnaire_answers, relocation_plans, user_quests, xp_events,
  agent_threads, messages, agent_handoffs, consent_events, analytics_events,
  ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing, audit_log,
  chat_requests, ai_model_attempt_daily, ai_user_model_attempt_daily,
  ai_model_attempts, ai_budget_daily, ai_credit_accounts, ai_credit_entries to citygo_api;
-- UPDATE on users is needed by existing SELECT ... FOR UPDATE row locks.
grant update on users, relocation_plans, user_quests, agent_threads,
  chat_requests, ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing,
  ai_model_attempt_daily, ai_user_model_attempt_daily, ai_budget, ai_budget_daily,
  ai_credit_accounts to citygo_api;
grant delete on sessions to citygo_api;
grant usage, select on all sequences in schema public to citygo_api;
grant select, delete on sessions, analytics_events to citygo_worker;
grant select, update on agent_threads, chat_requests to citygo_worker;
grant select on all tables in schema public to citygo_backup;
grant select on all sequences in schema public to citygo_backup;
commit;
