import type { Sql } from "@citygo/db";

const tables = {
  notices: ["scope", "version", "notice_id", "record"],
  configurations: ["revision", "snapshot", "recorded_at"],
  runtime: ["id", "mode", "configuration_revision", "max_route_revision"],
  commands: [
    "owner_id",
    "scope",
    "request_id",
    "fingerprint",
    "command",
    "event_id",
    "result_revision",
    "configuration_revision",
    "recorded_at",
  ],
  decisions: ["owner_id", "scope", "revision", "event_id"],
} as const;
const keys = {
  notices: ["PRIMARY KEY (scope, version)", "UNIQUE (notice_id)"],
  configurations: ["PRIMARY KEY (revision)"],
  runtime: [
    "PRIMARY KEY (id)",
    "FOREIGN KEY (configuration_revision) REFERENCES cg018_synthetic.configurations(revision)",
  ],
  commands: [
    "PRIMARY KEY (owner_id, scope, request_id)",
    "UNIQUE (event_id)",
    "UNIQUE (owner_id, scope, result_revision, event_id)",
    "UNIQUE (owner_id, scope, result_revision)",
    "FOREIGN KEY (configuration_revision) REFERENCES cg018_synthetic.configurations(revision)",
  ],
  decisions: [
    "PRIMARY KEY (owner_id, scope)",
    "FOREIGN KEY (owner_id, scope, revision, event_id) REFERENCES cg018_synthetic.commands(owner_id, scope, result_revision, event_id)",
  ],
} as const;
const canonical = (value: string) => value.replace(/\s/g, "");

// Check effective privileges on the SAME pinned transaction as the command.
// No migrations, grants, raw diagnostics, or cached readiness. This is not a
// full production DDL/security audit or a proof about the pool's login role.
export async function verifyR1SyntheticPermissionReadiness(
  tx: Sql,
): Promise<boolean> {
  try {
    const safeRole = (
      await tx.query<{ safe: boolean }>(`select
      not (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls)
      and has_schema_privilege(current_user,'cg018_synthetic','USAGE')
      and not has_schema_privilege(current_user,'cg018_synthetic','CREATE')
      and not exists (select 1 from pg_auth_members m where m.member=r.oid)
      and not pg_has_role(current_user,n.nspowner,'MEMBER') as safe
      from pg_roles r join pg_namespace n on n.nspname='cg018_synthetic' where r.rolname=current_user`)
    ).rows[0];
    if (!safeRole?.safe) return false;
    for (const [table, columns] of Object.entries(tables)) {
      const name = "cg018_synthetic." + table;
      const access = (
        await tx.query<{ safe: boolean }>(
          `select
        has_table_privilege(current_user,$1,'SELECT')
        and not has_table_privilege(current_user,$1,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        and not has_any_column_privilege(current_user,$1,'REFERENCES')
        and not pg_has_role(current_user,c.relowner,'MEMBER') as safe
        from pg_class c where c.oid=to_regclass($1) and c.relkind='r'`,
          [name],
        )
      ).rows[0];
      if (!access?.safe) return false;
      const actualColumns = (
        await tx.query<{
          name: string;
          insertable: boolean;
          updatable: boolean;
        }>(
          `select
        a.attname as name,has_column_privilege(current_user,a.attrelid,a.attname,'INSERT') as insertable,
        has_column_privilege(current_user,a.attrelid,a.attname,'UPDATE') as updatable
        from pg_attribute a where a.attrelid=to_regclass($1) and a.attnum>0 and not a.attisdropped`,
          [name],
        )
      ).rows;
      if (actualColumns.length !== columns.length) return false;
      for (const column of columns) {
        const actual = actualColumns.find((entry) => entry.name === column);
        const insertable =
          table === "decisions" ||
          (table === "commands" && column !== "recorded_at");
        const updatable =
          (table === "runtime" && column === "id") ||
          (table === "decisions" && ["revision", "event_id"].includes(column));
        if (
          !actual ||
          actual.insertable !== insertable ||
          actual.updatable !== updatable
        )
          return false;
      }
      const constraints = (
        await tx.query<{ definition: string; valid: boolean }>(
          `select
        pg_get_constraintdef(c.oid) as definition,
        c.convalidated and coalesce(i.indisvalid and i.indisready,true) as valid
        from pg_constraint c left join pg_index i on i.indexrelid=c.conindid
        where c.conrelid=to_regclass($1) and c.contype in ('p','u','f')`,
          [name],
        )
      ).rows;
      const expected = keys[table as keyof typeof keys];
      if (
        constraints.length !== expected.length ||
        expected.some(
          (key) =>
            !constraints.some(
              (entry) =>
                entry.valid && canonical(entry.definition) === canonical(key),
            ),
        )
      )
        return false;
    }
    // Flat grants only: no role memberships, even NOINHERIT/SET FALSE. This
    // exact disposable schema has one non-executable invoker trigger function.
    // Reject extra routines/overloads rather than claiming a general audit of
    // arbitrary SECURITY DEFINER functions or the privileged harness login.
    const functions = (
      await tx.query<{ oid: string; safe: boolean }>(`select p.oid::text as oid,
      p.proname='keep_history' and p.pronargs=0 and p.prokind='f'
      and p.prorettype='pg_catalog.trigger'::regtype
      and not p.prosecdef and p.proconfig=array['search_path=pg_catalog']::text[]
      and not pg_has_role(current_user,p.proowner,'MEMBER')
      and not has_function_privilege(current_user,p.oid,'EXECUTE') as safe
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='cg018_synthetic'`)
    ).rows;
    if (functions.length !== 1 || !functions[0]!.safe) return false;
    const history = (
      await tx.query<{ table_name: string; safe: boolean }>(
        `select
      c.relname as table_name,
      t.tgname=c.relname || '_immutable' and t.tgenabled='O' and t.tgtype=27
      and t.tgqual is null and cardinality(t.tgattr::int2[])=0
      and p.oid=$1::oid
      and not p.prosecdef and p.proconfig=array['search_path=pg_catalog']::text[]
      and p.proname='keep_history' and n.nspname='cg018_synthetic'
      and not pg_has_role(current_user,p.proowner,'MEMBER')
      and not has_function_privilege(current_user,p.oid,'EXECUTE') as safe
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace ns on ns.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
      where ns.nspname='cg018_synthetic' and not t.tgisinternal`,
        [functions[0]!.oid],
      )
    ).rows;
    return (
      history.length === 3 &&
      ["notices", "configurations", "commands"].every((table) =>
        history.some((entry) => entry.table_name === table && entry.safe),
      )
    );
  } catch {
    return false;
  }
}
