import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

type ModeState = { test_payments_seen: boolean; real_ai_admitted: boolean };
const unavailable = () =>
  new DomainError(
    503,
    "Эта база изолирована для тестовых платежей. Реальные запросы AI запрещены до полного закрытого сброса тестовых данных.",
  );

// Startup is a useful early diagnostic, not the admission boundary: another
// process can change the durable mode after this read. reserveAiAttempt/hold and
// the insert triggers recheck under the shared security -> user lock order.
export async function assertRealAiDatabaseSafety(sql: Sql) {
  const row = (
    await sql.query<ModeState>(
      "select test_payments_seen,real_ai_admitted from account_security_state where id=1",
    )
  ).rows[0];
  if (!row || row.test_payments_seen) throw unavailable();
}

export async function assertTestPaymentsDatabaseSafety(sql: Sql) {
  const row = (
    await sql.query<ModeState>(
      "select test_payments_seen,real_ai_admitted from account_security_state where id=1",
    )
  ).rows[0];
  if (!row || row.real_ai_admitted)
    throw new DomainError(
      409,
      "База уже использовалась для реального AI или оплаченного баланса; тестовым платежам нужна отдельная пустая база",
    );
}

export async function lockPaymentMode(sql: Sql, mode: "real" | "test") {
  const row = (
    await sql.query<ModeState>(
      "select test_payments_seen,real_ai_admitted from account_security_state where id=1 for update",
    )
  ).rows[0];
  if (!row) throw new DomainError(503, "Состояние изоляции базы не готово");
  if (mode === "real" && row.test_payments_seen) throw unavailable();
  if (mode === "test" && row.real_ai_admitted)
    throw new DomainError(
      409,
      "База уже используется для реального AI или оплаченного баланса; тестовые платежи требуют отдельной пустой базы",
    );
  const column = mode === "real" ? "real_ai_admitted" : "test_payments_seen";
  if (!row[column])
    await sql.query(
      `update account_security_state set ${column}=true where id=1`,
    );
}
