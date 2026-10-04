import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

// This is a readiness check, never a grant/migration executor.
export const HOUSING_MIGRATION = "0012_housing_answer_history.sql";
export const HOUSING_MIGRATION_SHA256 =
  "f92f1055bcffc8d690b090e2a52e1d8b04911024f323f35b8a16a8f2455e3d74";
export const housingTables = [
  "r1_housing_briefs",
  "r1_housing_commands",
  "r1_housing_brief_revisions",
] as const;

export async function verifyHousingReadiness(db: Database) {
  try {
    await db.transaction(async (tx) => {
      const migration = await tx.query<{ checksum: string }>(
        "select checksum from citygo_migrations where name=$1",
        [HOUSING_MIGRATION],
      );
      if (migration.rows[0]?.checksum !== HOUSING_MIGRATION_SHA256)
        throw new Error("Housing migration is not ready");
      const role = (
        await tx.query<{ elevated: boolean }>(
          "select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls as elevated from pg_roles where rolname=current_user",
        )
      ).rows[0];
      if (!role || role.elevated) throw new Error("Unsafe housing role");
      const required = (
        await tx.query<{ allowed: boolean }>(
          `select has_schema_privilege(current_user,'public','USAGE')
          and not has_schema_privilege(current_user,'public','CREATE')
          and has_table_privilege(current_user,'public.users','SELECT')
          and has_any_column_privilege(current_user,'public.users','UPDATE')
          and has_table_privilege(current_user,'public.relocation_plans','SELECT')
          and has_any_column_privilege(current_user,'public.relocation_plans','UPDATE')
          and has_sequence_privilege(current_user,pg_get_serial_sequence('public.r1_housing_briefs','id'),'USAGE')
          and not has_sequence_privilege(current_user,pg_get_serial_sequence('public.r1_housing_briefs','id'),'UPDATE')
          as allowed`,
        )
      ).rows[0];
      if (!required?.allowed)
        throw new Error("Housing privileges are not ready");
      for (const table of housingTables) {
        const access = (
          await tx.query<{ allowed: boolean }>(
            `select has_table_privilege(current_user,$1,'SELECT')
            and has_table_privilege(current_user,$1,'INSERT')
            and not has_any_column_privilege(current_user,$1,'UPDATE')
            and not has_table_privilege(current_user,$1,'DELETE,TRUNCATE')
            as allowed`,
            ["public." + table],
          )
        ).rows[0];
        if (!access?.allowed)
          throw new Error("Housing privileges are not ready");
      }
      // Check the actual columns too: a recorded migration is not enough.
      await tx.query(`select b.id,b.user_id,b.plan_id,b.plan_version,b.created_at,
        r.revision,r.content,r.created_at,c.command_id,c.request,c.event_id
        from r1_housing_briefs b
        join r1_housing_brief_revisions r on r.brief_id=b.id
        join r1_housing_commands c on c.brief_id=b.id limit 0`);
    });
  } catch {
    // No role name, SQL, row contents, raw database error or connection details.
    throw new DomainError(503, "Хранилище брифов не готово");
  }
}
