import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database, Sql } from "@citygo/db";
import { R1SyntheticPermissionStore } from "./r1-permission-store.js";
import { R1SyntheticPermissionRecovery } from "./r1-permission-recovery.js";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  permissionHttpFixture,
  syntheticPermissionRoleFixture,
  syntheticGrant,
  syntheticRevoke,
  syntheticContext,
  syntheticAi,
  syntheticRoute,
  syntheticRegistry,
} from "./r1-permission-http.fixture.js";

// Reused unchanged by memory tests AND the explicit disposable PG entry.
// No env, inherited URLs, actual data or provider calls.
const registry = (context = syntheticContext, ai = syntheticAi) =>
  new R1SyntheticNoticeRegistry({
    notices: [context, ai],
    current: { citygo_context: context.reference, ai_transfer: ai.reference },
  });
const empty = () =>
  new R1SyntheticNoticeRegistry({
    notices: [],
    current: { citygo_context: null, ai_transfer: null },
  });
type Scenario = {
  name: string;
  run: (t: TestContext, base?: Database) => Promise<void>;
};
async function withReviewRestoration(
  work: () => Promise<void>,
  restore: () => Promise<void>,
) {
  const failures: unknown[] = [];
  try {
    await work();
  } catch (error) {
    failures.push(error);
  }
  try {
    await restore();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Synthetic test and restoration failed");
}
async function expectNotReady(
  f: Awaited<ReturnType<typeof permissionHttpFixture>>,
  token: string,
  command: ReturnType<typeof syntheticGrant>,
) {
  const before = await f.counts();
  for (const response of [
    await f.call(token, command),
    await f.current(token),
    await f.lookup(token, command.scope, command.requestId),
  ]) {
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "rejected",
      code: "STORE_NOT_READY",
    });
  }
  assert.deepEqual(await f.counts(), before);
}
async function expectStoredDataInvalid(
  f: Awaited<ReturnType<typeof permissionHttpFixture>>,
  token: string,
  commands: readonly (
    ReturnType<typeof syntheticGrant> | ReturnType<typeof syntheticRevoke>
  )[],
) {
  const before = await f.counts();
  for (const command of commands)
    for (const response of [
      await f.call(token, command),
      await f.lookup(token, command.scope, command.requestId),
    ]) {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        status: "rejected",
        code: "STORED_DATA_INVALID",
      });
    }
  for (const response of [
    await f.current(token),
    await f.lookup(token, "citygo_context", randomUUID()),
  ]) {
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "rejected",
      code: "STORED_DATA_INVALID",
    });
  }
  assert.deepEqual(await f.counts(), before);
}
async function expectRecordedReplay(
  f: Awaited<ReturnType<typeof permissionHttpFixture>>,
  token: string,
  command: ReturnType<typeof syntheticGrant>,
  originalReceipt: unknown,
) {
  const before = await f.counts();
  const replay = await f.call(token, command);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().receipt, originalReceipt);
  assert.equal((await f.current(token)).statusCode, 200);
  const lookup = await f.lookup(token, command.scope, command.requestId);
  assert.equal(lookup.statusCode, 200, lookup.body);
  assert.deepEqual(lookup.json().receipt, originalReceipt);
  assert.deepEqual(await f.counts(), before);
}
async function fixtureAclSnapshot(base: Database) {
  const rows = (
    await base.query<{
      object_name: string;
      owner: string | null;
      acl: string[] | null;
    }>(
      "select 'schema' as object_name,n.nspowner::text as owner,n.nspacl::text[] as acl " +
        "from pg_namespace n where n.nspname='cg018_synthetic' union all " +
        "select 'commands',c.relowner::text,c.relacl::text[] from pg_class c " +
        "where c.oid='cg018_synthetic.commands'::regclass union all " +
        "select 'column.' || a.attname,null::text,a.attacl::text[] from pg_attribute a " +
        "where a.attrelid='cg018_synthetic.commands'::regclass and a.attnum>0 and not a.attisdropped union all " +
        "select 'function',p.proowner::text,p.proacl::text[] from pg_proc p " +
        "where p.oid='cg018_synthetic.keep_history()'::regprocedure order by object_name",
    )
  ).rows;
  // ACL entry order is not authority; preserve entries, grantors and NULL.
  return rows.map((row) => ({
    ...row,
    acl: row.acl === null ? null : [...row.acl].sort(),
  }));
}
export const permissionReviewScenarios: readonly Scenario[] = [
  {
    name: "first draft may be approved, but withdrawal/deselection cannot be undone through draft",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const draft = prepareR1SyntheticNotice({
        ...syntheticContext.definition,
        version: "fixture-v2",
        status: "draft_fixture",
      });
      const approved = prepareR1SyntheticNotice({
        ...draft.definition,
        status: "approved_fixture",
      });
      const withdrawn = prepareR1SyntheticNotice({
        ...draft.definition,
        status: "withdrawn_fixture",
      });
      assert.equal(
        (
          await f.control.replaceConfiguration(
            2,
            registry(draft),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      assert.equal(
        (
          await f.control.replaceConfiguration(
            3,
            registry(approved),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      assert.equal(
        (
          await f.call(user.token, {
            ...syntheticGrant(),
            notice: approved.reference,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await f.control.replaceConfiguration(
            4,
            registry(withdrawn),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      assert.equal(
        (
          await f.control.replaceConfiguration(
            5,
            registry(draft),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      assert.deepEqual(
        await f.control.replaceConfiguration(
          6,
          registry(approved),
          syntheticRoute,
        ),
        { status: "rejected", code: "NOTICE_VERSION_RETIRED" },
      );
      assert.equal(
        (await f.current(user.token)).json().scopes.citygo_context.resolution,
        "requires_new_action",
      );
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "withdrawn or demoted notice cannot resurrect a prior grant in either scope",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      assert.equal(
        (await f.call(user.token, syntheticGrant())).statusCode,
        200,
      );
      assert.equal(
        (await f.call(user.token, syntheticGrant("ai_transfer"))).statusCode,
        200,
      );
      const withdrawn = prepareR1SyntheticNotice({
        ...syntheticContext.definition,
        status: "withdrawn_fixture",
      });
      const draft = prepareR1SyntheticNotice({
        ...syntheticAi.definition,
        status: "draft_fixture",
      });
      assert.equal(
        (
          await f.control.replaceConfiguration(
            2,
            registry(withdrawn, draft),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      const read = (await f.current(user.token)).json();
      assert.equal(
        read.scopes.citygo_context.resolution,
        "requires_new_action",
      );
      assert.equal(read.scopes.ai_transfer.resolution, "requires_new_action");
      for (const next of [
        registry(),
        registry(withdrawn, syntheticAi),
        registry(syntheticContext, draft),
      ])
        assert.deepEqual(
          await f.control.replaceConfiguration(3, next, syntheticRoute),
          { status: "rejected", code: "NOTICE_VERSION_RETIRED" },
        );
      const again = (await f.current(user.token)).json();
      assert.equal(again.configurationRevision, 3);
      assert.equal(
        again.scopes.citygo_context.resolution,
        "requires_new_action",
      );
      assert.equal(again.scopes.ai_transfer.resolution, "requires_new_action");
      assert.equal((await f.counts())!.commands, 2);
    },
  },
  {
    name: "deselection retires versions; a new version requires a new explicit grant",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      await f.call(user.token, syntheticGrant());
      await f.call(user.token, syntheticGrant("ai_transfer"));
      await f.control.replaceConfiguration(2, empty(), syntheticRoute);
      assert.deepEqual(
        await f.control.replaceConfiguration(
          3,
          syntheticRegistry,
          syntheticRoute,
        ),
        { status: "rejected", code: "NOTICE_VERSION_RETIRED" },
      );
      const context = prepareR1SyntheticNotice({
        ...syntheticContext.definition,
        version: "fixture-v2",
      });
      const ai = prepareR1SyntheticNotice({
        ...syntheticAi.definition,
        version: "fixture-v2",
      });
      assert.equal(
        (
          await f.control.replaceConfiguration(
            3,
            registry(context, ai),
            syntheticRoute,
          )
        ).status,
        "configuration_updated",
      );
      const read = (await f.current(user.token)).json();
      for (const scope of ["citygo_context", "ai_transfer"] as const)
        assert.equal(read.scopes[scope].resolution, "requires_new_action");
      assert.equal(
        (
          await f.call(user.token, {
            ...syntheticGrant("citygo_context", 1),
            notice: context.reference,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await f.current(user.token)).json().scopes.citygo_context.resolution,
        "current_fixture_grant",
      );
      // Replacing v2 also cannot select a once-approved older v1.
      assert.deepEqual(
        await f.control.replaceConfiguration(
          4,
          syntheticRegistry,
          syntheticRoute,
        ),
        { status: "rejected", code: "NOTICE_VERSION_RETIRED" },
      );
      assert.equal((await f.counts())!.commands, 3);
    },
  },
  {
    name: "POST rejects rolled-back or missing decision pointers without writes or endless unconfirmed retry",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const initial = syntheticGrant();
      const revoke = syntheticRevoke("citygo_context", 1);
      const grant = await f.call(user.token, initial);
      assert.equal(grant.statusCode, 200, grant.body);
      const revoked = await f.call(user.token, revoke);
      assert.equal(revoked.statusCode, 200, revoked.body);
      await f.base.query(
        "update cg018_synthetic.decisions set revision=1,event_id=$1 where owner_id=$2",
        [grant.json().receipt.eventId, user.id],
      );
      const before = await f.counts();
      const command = syntheticRevoke("citygo_context", 1);
      await expectStoredDataInvalid(f, user.token, [
        initial, // Identical replay must not bypass the corrupted pointer.
        revoke,
        command,
        command,
        syntheticGrant("citygo_context", 1),
      ]);
      await f.base.query(
        "delete from cg018_synthetic.decisions where owner_id=$1",
        [user.id],
      );
      await expectStoredDataInvalid(f, user.token, [
        initial,
        revoke,
        syntheticRevoke("citygo_context", 0),
        syntheticGrant(),
      ]);
      assert.equal((await f.counts())!.commands, before!.commands);
    },
  },
  {
    name: "POST and configuration control detect configuration/route high-water rollback",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const initial = syntheticGrant();
      const revoke = syntheticRevoke("citygo_context", 1);
      assert.equal((await f.call(user.token, initial)).statusCode, 200);
      assert.equal((await f.call(user.token, revoke)).statusCode, 200);
      await f.control.replaceConfiguration(2, empty(), {
        ...syntheticRoute,
        revision: 3,
      });
      await f.base.query(
        "update cg018_synthetic.runtime set configuration_revision=2 where id=1",
      );
      await expectStoredDataInvalid(f, user.token, [
        initial,
        revoke,
        syntheticGrant(),
        syntheticRevoke("citygo_context", 0),
      ]);
      assert.deepEqual(
        await f.control.replaceConfiguration(
          2,
          syntheticRegistry,
          syntheticRoute,
        ),
        { status: "rejected", code: "STORED_DATA_INVALID" },
      );
      await f.base.query(
        "update cg018_synthetic.runtime set configuration_revision=3,max_route_revision=2 where id=1",
      );
      await expectStoredDataInvalid(f, user.token, [
        initial,
        revoke,
        syntheticGrant(),
        syntheticRevoke("citygo_context", 0),
      ]);
      assert.deepEqual(
        await f.control.replaceConfiguration(
          3,
          syntheticRegistry,
          syntheticRoute,
        ),
        { status: "rejected", code: "STORED_DATA_INVALID" },
      );
      assert.equal((await f.counts())!.commands, 2);
      assert.equal(
        (
          await f.base.query(
            "select count(*)::int as n from cg018_synthetic.configurations",
          )
        ).rows[0]!.n,
        3,
      );
    },
  },
  {
    name: "pre-COMMIT constraint failure is definite, but a lost COMMIT acknowledgement remains uncertain",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const duplicate: Database = {
        ...f.scoped,
        transaction: (work) =>
          f.scoped.transaction((tx) =>
            work({
              ...tx,
              async query<T>(sql: string, values?: unknown[]) {
                const result = await tx.query<T>(sql, values);
                if (sql.includes("insert into cg018_synthetic.commands"))
                  await tx.query(sql, values);
                return result;
              },
            }),
          ),
      };
      const store = new R1SyntheticPermissionStore(duplicate, "synthetic_only");
      assert.deepEqual(await store.execute(syntheticGrant(), user.id), {
        status: "rejected",
        code: "STORED_DATA_INVALID",
      });
      assert.equal((await f.counts())!.commands, 0);
      const connectionLoss: Database = {
        ...f.scoped,
        transaction: (work) =>
          f.scoped.transaction((tx) =>
            work({
              ...tx,
              async query<T>(sql: string, values?: unknown[]) {
                const result = await tx.query<T>(sql, values);
                if (sql.includes("insert into cg018_synthetic.commands"))
                  throw new Error("synthetic statement failed");
                return result;
              },
            }),
          ),
      };
      assert.deepEqual(
        await new R1SyntheticPermissionStore(
          connectionLoss,
          "synthetic_only",
        ).execute(syntheticGrant(), user.id),
        { status: "rejected", code: "WRITE_NOT_COMMITTED" },
      );
      assert.equal((await f.counts())!.commands, 0);
      const lostAck: Database = {
        ...f.scoped,
        async transaction(work) {
          await f.scoped.transaction(work);
          throw Object.assign(new Error("synthetic lost COMMIT response"), {
            code: "23505",
          });
        },
      };
      const command = syntheticGrant();
      assert.deepEqual(
        await new R1SyntheticPermissionStore(lostAck, "synthetic_only").execute(
          command,
          user.id,
        ),
        { status: "unconfirmed", code: "STORAGE_UNAVAILABLE" },
      );
      const receipt = await f.call(user.token, command);
      assert.equal(receipt.json().replayed, true);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "conditional and UPDATE OF history triggers fail readiness on all three history tables",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const first = await f.call(user.token, command);
      assert.equal(first.statusCode, 200, first.body);
      const originalReceipt = first.json().receipt;
      for (const [table, column, oldColumn] of [
        ["commands", "recorded_at", "scope"],
        ["configurations", "recorded_at", "revision"],
        ["notices", "version", "scope"],
      ]) {
        const replace = (update: string, condition = "") =>
          f.base.transaction(async (tx) => {
            await tx.query(
              `drop trigger ${table}_immutable on cg018_synthetic.${table}`,
            );
            await tx.query(
              `create trigger ${table}_immutable before ${update} or delete on cg018_synthetic.${table} ` +
                `for each row ${condition} execute function cg018_synthetic.keep_history()`,
            );
          });
        for (const conditional of [true, false]) {
          try {
            await replace(
              conditional ? "update" : "update of " + column,
              conditional ? `when (old.${oldColumn} is null)` : "",
            );
            assert.deepEqual(
              (
                await f.scoped.query(
                  "select t.tgtype::int as kind,t.tgenabled='O' as enabled, " +
                    "t.tgfoid='cg018_synthetic.keep_history()'::regprocedure as same_function, " +
                    "t.tgqual is not null as conditional,cardinality(t.tgattr::int2[]) as columns " +
                    "from pg_trigger t where t.tgrelid=to_regclass($1) and not t.tgisinternal",
                  ["cg018_synthetic." + table],
                )
              ).rows,
              [
                {
                  kind: 27,
                  enabled: true,
                  same_function: true,
                  conditional,
                  columns: conditional ? 0 : 1,
                },
              ],
            );
            await expectNotReady(f, user.token, command);
          } finally {
            await replace("update");
          }
          await expectRecordedReplay(f, user.token, command, originalReceipt);
        }
      }
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "direct schema ownership fails readiness even with only USAGE and no memberships",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const first = await f.call(user.token, command);
      assert.equal(first.statusCode, 200, first.body);
      const originalReceipt = first.json().receipt;
      const originalAcl = await fixtureAclSnapshot(f.base);
      await withReviewRestoration(
        async () => {
          await f.base.exec(
            "alter schema cg018_synthetic owner to " +
              f.roles.citygo_api +
              "; revoke create on schema cg018_synthetic from " +
              f.roles.citygo_api,
          );
          assert.deepEqual(
            (
              await f.scoped.query(
                "select n.nspowner=r.oid as owns, " +
                  "not exists (select 1 from pg_auth_members m where m.member=r.oid) as flat, " +
                  "has_schema_privilege(current_user,n.oid,'USAGE') as usage, " +
                  "has_schema_privilege(current_user,n.oid,'CREATE') as can_create " +
                  "from pg_roles r join pg_namespace n on n.nspname='cg018_synthetic' where r.rolname=current_user",
              )
            ).rows[0],
            { owns: true, flat: true, usage: true, can_create: false },
          );
          await expectNotReady(f, user.token, command);
        },
        async () => {
          await f.base.exec(
            "alter schema cg018_synthetic owner to current_user; " +
              "grant all on schema cg018_synthetic to current_user; " +
              "grant usage on schema cg018_synthetic to " +
              f.roles.citygo_api,
          );
          assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
        },
      );
      await expectRecordedReplay(f, user.token, command, originalReceipt);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "direct command-table ownership fails readiness with otherwise exact narrow column grants",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const first = await f.call(user.token, command);
      assert.equal(first.statusCode, 200, first.body);
      const originalReceipt = first.json().receipt;
      const originalAcl = await fixtureAclSnapshot(f.base);
      const columns = [
        "owner_id",
        "scope",
        "request_id",
        "fingerprint",
        "command",
        "event_id",
        "result_revision",
        "configuration_revision",
        "recorded_at",
      ];
      const narrowGrants =
        "revoke all on cg018_synthetic.commands from " +
        f.roles.citygo_api +
        "; grant select on cg018_synthetic.commands to " +
        f.roles.citygo_api +
        "; grant insert (" +
        columns.slice(0, -1).join(",") +
        ") on cg018_synthetic.commands to " +
        f.roles.citygo_api;
      await withReviewRestoration(
        async () => {
          await f.base.exec(
            "alter table cg018_synthetic.commands owner to " +
              f.roles.citygo_api +
              "; " +
              narrowGrants,
          );
          assert.deepEqual(
            (
              await f.scoped.query(
                "select c.relowner=r.oid as owns, " +
                  "not exists (select 1 from pg_auth_members m where m.member=r.oid) as flat, " +
                  "has_table_privilege(current_user,c.oid,'SELECT') as selectable, " +
                  "has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as unsafe " +
                  "from pg_roles r join pg_class c on c.oid='cg018_synthetic.commands'::regclass where r.rolname=current_user",
              )
            ).rows[0],
            { owns: true, flat: true, selectable: true, unsafe: false },
          );
          assert.deepEqual(
            (
              await f.scoped.query(
                "select a.attname as name, " +
                  "has_column_privilege(current_user,a.attrelid,a.attnum,'INSERT') as insertable, " +
                  "has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE') as updatable, " +
                  "has_column_privilege(current_user,a.attrelid,a.attnum,'REFERENCES') as referenceable " +
                  "from pg_attribute a where a.attrelid='cg018_synthetic.commands'::regclass " +
                  "and a.attnum>0 and not a.attisdropped order by a.attnum",
              )
            ).rows,
            columns.map((name) => ({
              name,
              insertable: name !== "recorded_at",
              updatable: false,
              referenceable: false,
            })),
          );
          await expectNotReady(f, user.token, command);
        },
        async () => {
          await f.base.exec(
            "alter table cg018_synthetic.commands owner to current_user; " +
              "revoke all (" +
              columns.join(",") +
              ") on cg018_synthetic.commands from current_user," +
              f.roles.citygo_api +
              "; grant all on cg018_synthetic.commands to current_user; " +
              narrowGrants,
          );
          assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
        },
      );
      await expectRecordedReplay(f, user.token, command, originalReceipt);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "direct history-function ownership fails readiness without EXECUTE or memberships",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const first = await f.call(user.token, command);
      assert.equal(first.statusCode, 200, first.body);
      const originalReceipt = first.json().receipt;
      const originalAcl = await fixtureAclSnapshot(f.base);
      await withReviewRestoration(
        async () => {
          await f.base.exec(
            "alter function cg018_synthetic.keep_history() owner to " +
              f.roles.citygo_api +
              "; revoke all on function cg018_synthetic.keep_history() from " +
              f.roles.citygo_api,
          );
          assert.deepEqual(
            (
              await f.scoped.query(
                "select p.proowner=r.oid as owns, " +
                  "not exists (select 1 from pg_auth_members m where m.member=r.oid) as flat, " +
                  "has_function_privilege(current_user,p.oid,'EXECUTE') as executable " +
                  "from pg_roles r join pg_proc p on p.oid='cg018_synthetic.keep_history()'::regprocedure where r.rolname=current_user",
              )
            ).rows[0],
            { owns: true, flat: true, executable: false },
          );
          await expectNotReady(f, user.token, command);
        },
        async () => {
          await f.base.exec(
            "alter function cg018_synthetic.keep_history() owner to current_user; " +
              "grant all on function cg018_synthetic.keep_history() to current_user; " +
              "revoke all on function cg018_synthetic.keep_history() from " +
              f.roles.citygo_api,
          );
          assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
        },
      );
      await expectRecordedReplay(f, user.token, command, originalReceipt);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "fixture cleanup rescues stranded owners and continues after one cleanup failure without dropping history",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const first = await f.call(user.token, command);
      assert.equal(first.statusCode, 200, first.body);
      const originalReceipt = first.json().receipt;
      const originalAcl = await fixtureAclSnapshot(f.base);
      const before = await f.counts();
      const owner = "cg018_http_" + randomUUID().replaceAll("-", "");
      const other = "cg018_worker_" + randomUUID().replaceAll("-", "");
      let failReassign = false;
      const cleanupFailure = new Error("synthetic cleanup statement failed");
      const cleanupBase: Database = {
        ...f.base,
        async exec(sql) {
          if (
            failReassign &&
            sql === "reassign owned by " + owner + " to current_user"
          )
            throw cleanupFailure;
          return f.base.exec(sql);
        },
      };
      const roleFixture = syntheticPermissionRoleFixture(cleanupBase);
      await withReviewRestoration(
        async () => {
          for (const role of [owner, other]) await roleFixture.create(role);
          const restorationFailure = new Error("synthetic restoration failed");
          const failRestoration = async () => {
            throw restorationFailure;
          };
          await assert.rejects(
            withReviewRestoration(async () => {
              await f.base.exec(
                "alter schema cg018_synthetic owner to " +
                  owner +
                  "; alter table cg018_synthetic.commands owner to " +
                  owner +
                  "; alter function cg018_synthetic.keep_history() owner to " +
                  owner,
              );
            }, failRestoration),
            (error) => error === restorationFailure,
          );
          assert.equal(
            (
              await f.base.query(
                "select n.nspowner=r.oid and c.relowner=r.oid and p.proowner=r.oid as stranded " +
                  "from pg_roles r join pg_namespace n on n.nspname='cg018_synthetic' " +
                  "join pg_class c on c.oid='cg018_synthetic.commands'::regclass " +
                  "join pg_proc p on p.oid='cg018_synthetic.keep_history()'::regprocedure where r.rolname=$1",
                [owner],
              )
            ).rows[0]!.stranded,
            true,
          );
          // A failed role must not stop teardown of the other exact owned role.
          failReassign = true;
          await assert.rejects(
            roleFixture.cleanup([other, owner]),
            (error) =>
              error instanceof AggregateError &&
              error.errors.length === 1 &&
              error.errors[0] === cleanupFailure,
          );
          assert.deepEqual(
            (
              await f.base.query(
                "select exists(select 1 from pg_roles where rolname=$1) as stranded, " +
                  "exists(select 1 from pg_roles where rolname=$2) as other, " +
                  "exists(select 1 from pg_roles where rolname=$3) as api",
                [owner, other, f.roles.citygo_api],
              )
            ).rows[0],
            { stranded: true, other: false, api: true },
          );
          failReassign = false;
          await roleFixture.cleanup();
          assert.equal(
            (
              await f.base.query(
                "select count(*)::int as n from pg_roles where rolname=$1 or rolname=$2",
                [owner, other],
              )
            ).rows[0]!.n,
            0,
          );
          assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
          assert.deepEqual(await f.counts(), before);
          await expectRecordedReplay(f, user.token, command, originalReceipt);
          await assert.rejects(roleFixture.cleanup(["citygo_api"]), {
            name: "AssertionError",
            code: "ERR_ASSERTION",
          });
        },
        async () => {
          failReassign = false;
          await roleFixture.cleanup();
        },
      );
    },
  },
  {
    name: "restoration preserves both assertion failures and each single failure without masking the primary error",
    async run() {
      const primary = new assert.AssertionError({
        message: "synthetic readiness assertion failed",
        actual: 200,
        expected: 503,
        operator: "strictEqual",
      });
      const restoration = new assert.AssertionError({
        message: "synthetic ACL assertion failed",
        actual: "changed",
        expected: "original",
        operator: "strictEqual",
      });
      const order: string[] = [];
      await assert.rejects(
        withReviewRestoration(
          async () => {
            order.push("test");
            throw primary;
          },
          async () => {
            order.push("restore");
            throw restoration;
          },
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.equal(error.errors[0], primary);
          assert.equal(error.errors[1], restoration);
          return true;
        },
      );
      assert.deepEqual(order, ["test", "restore"]);
      let restored = false;
      await assert.rejects(
        withReviewRestoration(
          async () => {
            throw primary;
          },
          async () => {
            restored = true;
          },
        ),
        (error) => error === primary,
      );
      assert.equal(restored, true);
      await assert.rejects(
        withReviewRestoration(
          async () => {},
          async () => {
            throw restoration;
          },
        ),
        (error) => error === restoration,
      );
      await withReviewRestoration(
        async () => {
          order.push("success");
        },
        async () => {
          order.push("restored");
        },
      );
      assert.deepEqual(order, ["test", "restore", "success", "restored"]);
    },
  },
  {
    name: "role cleanup rejects a mixed invalid selection, another fixture, LOGIN and current_user without destructive SQL",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const before = await f.counts();
      const originalAcl = await fixtureAclSnapshot(f.base);
      const own = "cg018_backup_" + randomUUID().replaceAll("-", "");
      const neighbor = "cg018_worker_" + randomUUID().replaceAll("-", "");
      let currentRole: string | null = null;
      let queries = 0;
      let writes = 0;
      let transactions = 0;
      let ownCreated = false;
      const observedBase: Database = {
        ...f.base,
        query: <T>(sql: string, values?: unknown[]) => {
          queries++;
          const role = currentRole;
          if (role === null) return f.base.query<T>(sql, values);
          // The current_user guard sees an actual SET LOCAL ROLE, not a
          // fabricated catalog result. Cleanup must not reach exec here.
          return f.base.transaction(async (tx) => {
            await tx.query("set local role " + role);
            return tx.query<T>(sql, values);
          });
        },
        exec: async (sql) => {
          writes++;
          await f.base.exec(sql);
        },
        transaction: <T>(work: (tx: Sql) => Promise<T>) => {
          // Observe entry through the cleanup-facing Database. The query
          // wrapper's internal SET LOCAL ROLE uses f.base directly.
          transactions++;
          return f.base.transaction(work);
        },
      };
      const ownFixture = syntheticPermissionRoleFixture(observedBase);
      const neighborFixture = syntheticPermissionRoleFixture(f.base);
      const guardFailure = (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.ok(error.errors[0] instanceof assert.AssertionError);
        assert.equal(error.errors[0].code, "ERR_ASSERTION");
        return true;
      };
      await withReviewRestoration(
        async () => {
          const beforeProbe = { queries, writes, transactions };
          const probeResult = { observed: true };
          assert.equal(
            await observedBase.transaction(async () => probeResult),
            probeResult,
          );
          assert.deepEqual(
            { queries, writes, transactions },
            { ...beforeProbe, transactions: beforeProbe.transactions + 1 },
          );
          await ownFixture.create(own);
          ownCreated = true;
          await neighborFixture.create(neighbor);
          const untouched = { queries, writes, transactions };
          await assert.rejects(ownFixture.cleanup([own, "citygo_api"]), {
            name: "AssertionError",
            code: "ERR_ASSERTION",
          });
          assert.deepEqual({ queries, writes, transactions }, untouched);
          await assert.rejects(ownFixture.cleanup([own, neighbor]), {
            name: "AssertionError",
            code: "ERR_ASSERTION",
            message: "Role was not created by this fixture",
          });
          assert.deepEqual({ queries, writes, transactions }, untouched);
          assert.equal(
            (
              await f.base.query(
                "select count(*)::int as n from pg_roles where rolname=$1 or rolname=$2",
                [own, neighbor],
              )
            ).rows[0]!.n,
            2,
          );

          await f.base.exec("alter role " + own + " login");
          const beforeLogin = { queries, writes, transactions };
          await assert.rejects(ownFixture.cleanup([own]), guardFailure);
          assert.equal(queries, beforeLogin.queries + 1);
          assert.equal(writes, beforeLogin.writes);
          assert.equal(transactions, beforeLogin.transactions);
          assert.equal(
            (
              await f.base.query(
                "select rolcanlogin as login from pg_roles where rolname=$1",
                [own],
              )
            ).rows[0]!.login,
            true,
          );
          await f.base.exec("alter role " + own + " nologin");

          currentRole = own;
          const beforeActive = { queries, writes, transactions };
          await assert.rejects(ownFixture.cleanup([own]), guardFailure);
          assert.equal(queries, beforeActive.queries + 1);
          assert.equal(writes, beforeActive.writes);
          assert.equal(transactions, beforeActive.transactions);
          currentRole = null;
          assert.equal(
            (
              await f.base.query(
                "select count(*)::int as n from pg_roles where rolname=$1 or rolname=$2",
                [own, neighbor],
              )
            ).rows[0]!.n,
            2,
          );
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
        },
        async () => {
          currentRole = null;
          await withReviewRestoration(
            async () => {
              if (ownCreated)
                await f.base.exec("alter role " + own + " nologin");
              await ownFixture.cleanup();
            },
            () => neighborFixture.cleanup(),
          );
        },
      );
      assert.equal(
        (
          await f.base.query(
            "select count(*)::int as n from pg_roles where rolname=$1 or rolname=$2",
            [own, neighbor],
          )
        ).rows[0]!.n,
        0,
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await fixtureAclSnapshot(f.base), originalAcl);
    },
  },
  {
    name: "MAINTAIN and NOINHERIT membership of schema/function owners fail readiness",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      assert.equal((await f.call(user.token, command)).statusCode, 200);
      await f.base.exec(
        "grant maintain on cg018_synthetic.commands to " + f.roles.citygo_api,
      );
      await expectNotReady(f, user.token, command);
      await f.base.exec(
        "revoke maintain on cg018_synthetic.commands from " +
          f.roles.citygo_api,
      );
      const owner = "cg018_notice_owner_" + randomUUID().replaceAll("-", "");
      await f.base.exec(
        "create role " +
          owner +
          " nologin; grant usage on schema cg018_synthetic to " +
          owner,
      );
      try {
        await f.base.exec(
          "alter function cg018_synthetic.keep_history() owner to " +
            owner +
            "; grant " +
            owner +
            " to " +
            f.roles.citygo_api +
            " with inherit false",
        );
        await expectNotReady(f, user.token, command);
        await f.base.exec("revoke " + owner + " from " + f.roles.citygo_api);
        assert.equal((await f.call(user.token, command)).json().replayed, true);
        await f.base.exec(
          "alter function cg018_synthetic.keep_history() owner to current_user; " +
            "alter schema cg018_synthetic owner to " +
            owner +
            "; grant " +
            owner +
            " to " +
            f.roles.citygo_api +
            " with inherit false",
        );
        await expectNotReady(f, user.token, command);
        await f.base.exec("revoke " + owner + " from " + f.roles.citygo_api);
        assert.equal((await f.call(user.token, command)).json().replayed, true);
        assert.equal((await f.counts())!.commands, 1);
      } finally {
        await f.base.exec(
          "alter schema cg018_synthetic owner to current_user; " +
            "alter function cg018_synthetic.keep_history() owner to current_user; drop owned by " +
            owner +
            "; drop role " +
            owner,
        );
      }
    },
  },
  {
    name: "non-owner NOINHERIT writer, built-in and SET-disabled memberships fail the flat-role guard",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      assert.equal((await f.call(user.token, command)).statusCode, 200);
      const role = "cg018_review_writer_" + randomUUID().replaceAll("-", "");
      await f.base.exec("create role " + role + " nologin");
      try {
        await f.base.exec(
          "grant delete on cg018_synthetic.commands to " +
            role +
            "; grant " +
            role +
            " to " +
            f.roles.citygo_api +
            " with inherit false, set true",
        );
        assert.deepEqual(
          (
            await f.scoped.query(
              "select has_table_privilege(current_user,'cg018_synthetic.commands','DELETE') as inherited, " +
                "pg_has_role(current_user,$1,'SET') as can_set",
              [role],
            )
          ).rows[0],
          { inherited: false, can_set: true },
        );
        await expectNotReady(f, user.token, command);
        await f.base.exec("revoke " + role + " from " + f.roles.citygo_api);
        assert.equal((await f.call(user.token, command)).json().replayed, true);

        await f.base.exec(
          "grant pg_write_all_data to " +
            f.roles.citygo_api +
            " with inherit false, set true",
        );
        try {
          await expectNotReady(f, user.token, command);
        } finally {
          await f.base.exec(
            "revoke pg_write_all_data from " + f.roles.citygo_api,
          );
        }
        assert.equal((await f.current(user.token)).statusCode, 200);

        // The exact synthetic role permits no memberships, including a
        // currently unusable one. This is intentionally stricter than SET.
        await f.base.exec(
          "grant " +
            role +
            " to " +
            f.roles.citygo_api +
            " with inherit false, set false",
        );
        assert.deepEqual(
          (
            await f.scoped.query(
              "select pg_has_role(current_user,$1,'USAGE') as inherited, " +
                "pg_has_role(current_user,$1,'SET') as can_set",
              [role],
            )
          ).rows[0],
          { inherited: false, can_set: false },
        );
        await expectNotReady(f, user.token, command);
      } finally {
        await f.base.exec(
          "revoke " +
            role +
            " from " +
            f.roles.citygo_api +
            "; drop owned by " +
            role +
            "; drop role " +
            role,
        );
      }
      assert.equal((await f.call(user.token, command)).json().replayed, true);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "column-only REFERENCES on every fixture table fails readiness without table-level rights",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      assert.equal((await f.call(user.token, command)).statusCode, 200);
      for (const [table, column] of [
        ["notices", "scope"],
        ["configurations", "revision"],
        ["runtime", "id"],
        ["commands", "owner_id"],
        ["decisions", "owner_id"],
      ]) {
        const name = "cg018_synthetic." + table;
        await f.base.exec(
          "grant references (" +
            column +
            ") on " +
            name +
            " to " +
            f.roles.citygo_api,
        );
        try {
          assert.deepEqual(
            (
              await f.scoped.query(
                "select has_table_privilege(current_user,$1,'REFERENCES') as table_reference, " +
                  "has_any_column_privilege(current_user,$1,'REFERENCES') as column_reference",
                [name],
              )
            ).rows[0],
            { table_reference: false, column_reference: true },
          );
          await expectNotReady(f, user.token, command);
        } finally {
          await f.base.exec(
            "revoke references (" +
              column +
              ") on " +
              name +
              " from " +
              f.roles.citygo_api,
          );
        }
        assert.equal((await f.call(user.token, command)).json().replayed, true);
        assert.equal((await f.current(user.token)).statusCode, 200);
      }
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "extra SECURITY DEFINER function, inaccessible routine and keep_history overload fail the exact inventory",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      assert.equal((await f.call(user.token, command)).statusCode, 200);
      await f.base.exec(
        "create function cg018_synthetic.review_extra() returns integer " +
          "language sql security definer as 'select 1'",
      );
      try {
        assert.equal(
          (
            await f.scoped.query(
              "select has_function_privilege(current_user,'cg018_synthetic.review_extra()','EXECUTE') as executable",
            )
          ).rows[0]!.executable,
          true,
        );
        await expectNotReady(f, user.token, command);
        await f.base.exec(
          "revoke all on function cg018_synthetic.review_extra() from public",
        );
        assert.equal(
          (
            await f.scoped.query(
              "select has_function_privilege(current_user,'cg018_synthetic.review_extra()','EXECUTE') as executable",
            )
          ).rows[0]!.executable,
          false,
        );
        await expectNotReady(f, user.token, command);
      } finally {
        await f.base.exec("drop function cg018_synthetic.review_extra()");
      }
      assert.equal((await f.call(user.token, command)).json().replayed, true);
      await f.base.exec(
        "create function cg018_synthetic.keep_history(integer) returns integer " +
          "language sql security invoker as 'select 1'; " +
          "revoke all on function cg018_synthetic.keep_history(integer) from public",
      );
      try {
        await expectNotReady(f, user.token, command);
      } finally {
        await f.base.exec(
          "drop function cg018_synthetic.keep_history(integer)",
        );
      }
      assert.equal((await f.call(user.token, command)).json().replayed, true);
      assert.equal((await f.current(user.token)).statusCode, 200);
      assert.equal((await f.counts())!.commands, 1);
    },
  },
  {
    name: "historical lookup is authenticated, owner/scope-bound, read-only and does not imply current grant",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const other = await f.person();
      const command = syntheticGrant("ai_transfer");
      const sent = await f.call(user.token, command);
      await f.call(user.token, syntheticRevoke("ai_transfer", 1));
      await f.control.replaceConfiguration(2, empty(), null);
      const before = await f.counts();
      const found = await f.lookup(
        user.token,
        command.scope,
        command.requestId,
      );
      assert.equal(found.statusCode, 200);
      assert.match(found.headers["cache-control"] as string, /no-store/);
      assert.deepEqual(found.json().receipt, sent.json().receipt);
      for (const [token, scope] of [
        [other.token, command.scope],
        [user.token, "citygo_context"],
      ]) {
        const read = await f.lookup(token!, scope!, command.requestId);
        assert.equal(read.json().status, "not_recorded_at_read");
        assert.equal(read.json().receipt, undefined);
      }
      assert.equal(
        (await f.lookup(user.token, "invalid", command.requestId)).statusCode,
        400,
      );
      assert.equal(
        (await f.lookup(user.token, command.scope, "invalid")).statusCode,
        400,
      );
      assert.equal(
        (
          await f.lookup(
            user.token,
            command.scope,
            command.requestId,
            "?ownerId=other",
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: `/v1/synthetic/permissions/commands/${command.scope}/${command.requestId}`,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (await f.current(user.token)).json().scopes.ai_transfer.resolution,
        "revoked",
      );
      assert.deepEqual(await f.counts(), before);
    },
  },
  {
    name: "lookup absence is not cancellation; restored grant needs freshly shown matching text and explicit retry",
    async run(t, base) {
      const f = await permissionHttpFixture(t, { base });
      const user = await f.person();
      const command = syntheticGrant();
      const client = new R1SyntheticPermissionRecovery(
        user.id,
        "citygo_context",
      );
      assert.equal(
        client.restorePending({
          schemaVersion: 1,
          mode: "synthetic_only",
          ownerId: user.id,
          command,
        }),
        true,
      );
      const lookup = client.beginLookup()!;
      const missing = await f.lookup(
        user.token,
        lookup.scope,
        lookup.requestId,
      );
      assert.equal(
        client.acceptLookup(lookup.ticket, missing.statusCode, missing.json()),
        false,
      );
      assert.equal(client.state().status, "uncertain");
      assert.equal(
        client.retryCommand({
          requestId: command.requestId,
          notice: command.notice,
        }),
        null,
      );
      const current = await f.current(user.token);
      client.acceptRead(client.beginRead(), current.statusCode, current.json());
      assert.equal(client.retryCommand(), null);
      const retry = client.retryCommand({
        requestId: command.requestId,
        notice: command.notice,
      })!;
      assert.deepEqual(retry.command, command);
      const write = await f.call(user.token, retry.command);
      assert.equal(write.json().replayed, false);
      assert.equal(
        client.acceptWrite(retry.ticket, write.statusCode, write.json()),
        true,
      );
      assert.equal((await f.counts())!.commands, 1);
    },
  },
];
