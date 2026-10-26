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
-- Fixed-reserve debt identity and repayments are append-only. Neither runtime
-- role can rewrite/delete a debt or its payment/source attribution.
grant select, insert on credit_charge_debts, credit_debt_repayments to citygo_api;
-- Migrator defaults revoke PUBLIC EXECUTE. Runtime debt admission and the
-- invoker new-source trigger call this function explicitly, even with no debt.
-- Do not grant execution of trigger guards or this function to other roles.
grant execute on function citygo_apply_credit_debt_repayments(bigint) to citygo_api;
-- Provider events are durable ID hints, never settlement proof or Worker jobs.
grant select, insert on payment_notification_inbox to citygo_api;
grant update (status,attempt_count,lease_token,lease_until,next_attempt_at,last_reason,processed_at)
  on payment_notification_inbox to citygo_api;
-- New-checkout admission is independent from settlement/refunds. Singleton is
-- migration-owned; history is append-only; Worker has no financial permissions.
grant select on payment_admission to citygo_api;
grant update (revision,merchant_id,runtime_policy_id,accepting_new_checkouts,
  reconciliation_enabled,mode,owner_user_id,lease_session_token_hash,lease_until,
  manual_npd_responsibility_accepted,reconciliation_checked_at,reconciliation_ok,
  reconciliation_run_id,reconciliation_run_revision,reconciliation_run_until,updated_at)
  on payment_admission to citygo_api;
grant select,insert on payment_admission_commands,payment_admission_reconciliation_events to citygo_api;
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
-- Pending email registration is not a user/session. No Worker access or
-- runtime deletion of delivery quotas/verification evidence is granted.
grant select, insert on email_registrations, email_registration_rate_events,
  account_email_verifications to citygo_api;
-- Explicit versioned consent evidence is append-only; no Worker access.
grant select, insert on service_consent_events to citygo_api;
grant update (code_hash,delivery,attempts,expires_at,consumed_user_id,consumed_at)
  on email_registrations to citygo_api;
-- Password recovery keeps immutable identity/lifetime and cumulative attempts.
-- The API can consume/invalidate codes, never delete recovery/quota history.
grant select, insert on password_recovery_challenges to citygo_api;
grant update (code_hash,delivery,attempts,consumed_at,invalidated_at)
  on password_recovery_challenges to citygo_api;
-- Existing-account email proof is retained separately from registration.
grant select, insert on account_email_confirmation_challenges to citygo_api;
grant update (code_hash,delivery,attempts,consumed_at,invalidated_at)
  on account_email_confirmation_challenges to citygo_api;
-- Private user-chosen steps have immutable owner/source/create identity.
-- Runtime may edit content/state or tombstone, never delete or rewrite identity.
grant select, insert on personal_plan_items to citygo_api;
grant update (title,details,status,revision,updated_at,deleted_at)
  on personal_plan_items to citygo_api;
-- Phone identity policy is operator-bound, never writable/bindable by API.
-- Quotas and spent gift rights are retained append-only; Worker gets no access.
grant select on phone_verification_control to citygo_api;
grant select,insert on phone_verification_challenges,phone_verification_sends,phone_welcome_claims to citygo_api;
grant update (code_hash,delivery,attempts,expires_at,superseded_at,consumed_at,consumed_operation_id)
  on phone_verification_challenges to citygo_api;
-- UPDATE on users is needed by existing SELECT ... FOR UPDATE row locks.
grant update on users, relocation_plans, user_quests, agent_threads,
  chat_requests, ai_consents, ai_usage_daily, ai_user_usage_daily, ai_routing,
  ai_model_attempt_daily, ai_user_model_attempt_daily, ai_budget, ai_budget_daily,
  ai_credit_accounts, ai_credit_charges to citygo_api;
-- Private bookmarks change only message metadata, never text/role/ownership.
grant update(metadata) on messages to citygo_api;
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
