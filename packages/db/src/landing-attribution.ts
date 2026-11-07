import { landingAttributionSchema } from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

/** Called only alongside a newly created account, in that same transaction.
 * The null row also fixes an unattributed registration; it is never upserted.
 */
export async function recordUserAcquisition(
  tx: Sql,
  userId: string,
  raw?: unknown,
) {
  const parsed = landingAttributionSchema.nullish().safeParse(raw);
  if (!parsed.success)
    throw new DomainError(400, "Некорректная метка источника регистрации");
  await tx.query(
    "insert into user_acquisition(user_id,landing_attribution) values($1,$2::jsonb)",
    [userId, parsed.data ? JSON.stringify(parsed.data) : null],
  );
}
