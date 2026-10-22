import assert from "node:assert/strict";

// Read-only assertions for owned synthetic release fixtures. These are not
// admission commands and cannot grant permission to open a real checkout.
export const closedPaymentAdmissionSql = `select count(*)=1 and bool_and(
  id=1 and revision=1 and merchant_id is null and runtime_policy_id is null
  and not accepting_new_checkouts and not reconciliation_enabled and mode='closed'
  and owner_user_id is null and lease_session_token_hash is null and lease_until is null
  and not manual_npd_responsibility_accepted and not reconciliation_ok
  and reconciliation_checked_at is null and reconciliation_run_id is null
  and reconciliation_run_revision is null and reconciliation_run_until is null)
  from payment_admission`;

export const paymentAdmissionAclSql = `select
  has_table_privilege('citygo_api','payment_admission','SELECT')
  and has_column_privilege('citygo_api','payment_admission','revision','UPDATE')
  and has_column_privilege('citygo_api','payment_admission','reconciliation_run_id','UPDATE')
  and not has_table_privilege('citygo_api','payment_admission','UPDATE')
  and not has_column_privilege('citygo_api','payment_admission','id','UPDATE')
  and not has_column_privilege('citygo_api','payment_admission','created_at','UPDATE')
  and not has_table_privilege('citygo_api','payment_admission','INSERT')
  and not has_table_privilege('citygo_api','payment_admission','DELETE')
  and not has_table_privilege('citygo_api','payment_admission','TRUNCATE')
  and has_table_privilege('citygo_backup','payment_admission','SELECT')
  and not has_table_privilege('citygo_worker','payment_admission','SELECT')
  and not has_table_privilege('citygo_worker','payment_admission','INSERT')
  and not has_table_privilege('citygo_worker','payment_admission','UPDATE')
  and not has_table_privilege('citygo_worker','payment_admission','DELETE')
  and not has_table_privilege('citygo_worker','payment_admission','TRUNCATE')
  and (select bool_and(
    has_table_privilege('citygo_api',r,'SELECT')
    and has_table_privilege('citygo_api',r,'INSERT')
    and not has_table_privilege('citygo_api',r,'UPDATE')
    and not has_table_privilege('citygo_api',r,'DELETE')
    and not has_table_privilege('citygo_api',r,'TRUNCATE')
    and has_table_privilege('citygo_backup',r,'SELECT')
    and not has_table_privilege('citygo_worker',r,'SELECT')
    and not has_table_privilege('citygo_worker',r,'INSERT')
    and not has_table_privilege('citygo_worker',r,'UPDATE')
    and not has_table_privilege('citygo_worker',r,'DELETE')
    and not has_table_privilege('citygo_worker',r,'TRUNCATE'))
    from unnest(array['payment_admission_commands','payment_admission_reconciliation_events']) r)
  and not has_function_privilege('citygo_api','citygo_guard_payment_admission_history()','EXECUTE')
  and not has_function_privilege('citygo_worker','citygo_guard_payment_admission_history()','EXECUTE')`;

export function assertClosedPaymentAdmission(psql) {
  assert.equal(
    psql(closedPaymentAdmissionSql),
    "t",
    "New checkout defaults closed",
  );
  for (const table of [
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ])
    assert.equal(psql(`select count(*) from ${table}`), "0");
}

export function assertPaymentAdmissionAcls(psql) {
  assert.equal(
    psql(paymentAdmissionAclSql),
    "t",
    "Admission least-privilege ACLs",
  );
}
