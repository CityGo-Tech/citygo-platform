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
  ai_credit_charges, ai_credit_topups, payment_topup_orders, account_security_state, citygo_migrations to citygo_api;
-- Receipt duties and manual evidence are server-owned. Worker has no access.
grant select, insert on npd_receipt_tasks, npd_receipt_commands,
  npd_receipt_evidence, npd_refund_observations to citygo_api;
-- Source-aware reservations and the monetary refund journal stay server-owned.
-- Financial identity is immutable; history/events have no deletion privileges.
grant select, insert on credit_source_lots, credit_hold_allocations,
  credit_refund_allocations, payment_refunds, payment_refund_events to citygo_api;
grant update (spent_micros,held_micros,refund_reserved_micros,refunded_micros)
  on credit_source_lots to citygo_api;
grant update (spent_micros,state) on credit_hold_allocations to citygo_api;
grant update (state) on credit_refund_allocations to citygo_api;
grant update (status,provider_refund_id,revision,attempt_count,last_attempt_at,
  dispatch_token,dispatch_lease_until,review_reason,updated_at)
  on payment_refunds to citygo_api;
-- Source identity/contact are immutable; append-only history has no UPDATE,
-- DELETE or TRUNCATE grant. Task INSERT is needed by the invoker top-up trigger.
grant update (cumulative_refunded_kopeks,revision,claimed_by_user_id,
  registration_status,delivery_status,correction_status,active_evidence_id,
  review_reason,updated_at) on npd_receipt_tasks to citygo_api;
grant insert on users, user_credentials, sessions, relocation_profiles,
  questionnaire_answers, relocation_plans, user_quests, xp_events,
  agent_threads, messages, agent_handoffs, consent_events, analytics_events,
  ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing, audit_log,
  chat_requests, ai_model_attempt_daily, ai_user_model_attempt_daily,
  ai_model_attempts, ai_budget_daily, ai_credit_accounts, ai_credit_entries, ai_credit_charges,
  ai_credit_topups, payment_topup_orders to citygo_api;
-- UPDATE on users is needed by existing SELECT ... FOR UPDATE row locks.
grant update on users, relocation_plans, user_quests, agent_threads,
  chat_requests, ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing,
  ai_model_attempt_daily, ai_user_model_attempt_daily, ai_budget, ai_budget_daily,
  ai_credit_accounts, ai_credit_charges to citygo_api;
-- Runtime may observe a provider response, not rewrite the checkout identity,
-- requested amount, immutable create payload or the provider idempotency window.
grant update (provider_payment_id,status,confirmation_url,updated_at)
  on payment_topup_orders to citygo_api;
grant delete on sessions to citygo_api;
-- PostgreSQL requires a column UPDATE privilege for SELECT ... FOR UPDATE.
-- The receipt command transaction locks the actual session to serialize logout.
grant update (expires_at) on sessions to citygo_api;
-- Password rotation and the account-security serialization row only. No DELETE
-- on accounts or accounting data, and no runtime INSERT into the singleton.
grant update (password_hash) on user_credentials to citygo_api;
grant update (bootstrap_completed,test_payments_seen,real_ai_admitted) on account_security_state to citygo_api;
grant usage, select on all sequences in schema public to citygo_api;
grant select, delete on sessions, analytics_events to citygo_worker;
grant select, update on agent_threads, chat_requests to citygo_worker;
grant select on all tables in schema public to citygo_backup;
grant select on all sequences in schema public to citygo_backup;
commit;
