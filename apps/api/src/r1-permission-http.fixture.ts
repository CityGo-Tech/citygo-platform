import assert from "node:assert/strict";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import { R1SyntheticPermissionStore } from "./r1-permission-store.js";

export const syntheticPermissionPath = "/v1/synthetic/permissions/commands";
export const syntheticPermissionCurrentPath =
  "/v1/synthetic/permissions/current";
export const syntheticRoute = { revision: 2, disclosureId: "b".repeat(64) };
export const syntheticContext = prepareR1SyntheticNotice({
  mode: "synthetic_only",
  scope: "citygo_context",
  version: "fixture-v1",
  body: "Synthetic context only. Not a legal notice.",
  routeDisclosureId: null,
  status: "approved_fixture",
});
export const syntheticAi = prepareR1SyntheticNotice({
  ...syntheticContext.definition,
  scope: "ai_transfer",
  body: "Synthetic AI only. No data leaves this test.",
  routeDisclosureId: syntheticRoute.disclosureId,
});
export const syntheticRegistry = new R1SyntheticNoticeRegistry({
  notices: [syntheticContext, syntheticAi],
  current: {
    citygo_context: syntheticContext.reference,
    ai_transfer: syntheticAi.reference,
  },
});
export const syntheticGrant = (
  scope: "citygo_context" | "ai_transfer" = "citygo_context",
  expectedRevision = 0,
) => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  expectedRevision,
  action: "grant",
  scope,
  notice:
    scope === "citygo_context"
      ? syntheticContext.reference
      : syntheticAi.reference,
  ...(scope === "ai_transfer" ? { route: syntheticRoute } : {}),
});
export const syntheticRevoke = (
  scope: "citygo_context" | "ai_transfer",
  expectedRevision: number,
) => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  expectedRevision,
  action: "revoke",
  scope,
});

// Test-only role lifecycle. Only this closure can record successful creations;
// a matching name alone is never enough to authorize cleanup.
export function syntheticPermissionRoleFixture(base: Database) {
  const created = new Set<string>();
  const validateName = (role: string) =>
    assert.match(role, /^cg018_(http|worker|backup)_[a-f0-9]{32}$/);
  return {
    async create(role: string) {
      validateName(role);
      assert.ok(!created.has(role), "Synthetic role was already created");
      await base.exec("create role " + role + " nologin");
      created.add(role);
    },
    async cleanup(roles: readonly string[] = [...created]) {
      // Validate the entire selection before any query or destructive SQL.
      for (const role of roles) {
        validateName(role);
        assert.ok(created.has(role), "Role was not created by this fixture");
      }
      const failures: unknown[] = [];
      for (const role of [...roles].reverse()) {
        try {
          const state = (
            await base.query<{ login: boolean; active: boolean }>(
              "select rolcanlogin as login,rolname=current_user as active from pg_roles where rolname=$1",
              [role],
            )
          ).rows[0];
          if (!state) continue; // Explicit repeated cleanup is harmless.
          assert.deepEqual(state, { login: false, active: false });
          await base.exec("reassign owned by " + role + " to current_user");
          await base.exec("drop owned by " + role + " restrict");
          await base.exec("drop role " + role);
        } catch (error) {
          failures.push(error); // Still attempt the other own roles.
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Synthetic role cleanup failed");
    },
  };
}

// Always memory-only by default. A PG opt-in may pass its freshly created DB,
// never an inherited URL. No .env, TEST_DATABASE_URL, provider or network calls.
export async function permissionHttpFixture(
  t: TestContext,
  options: {
    base?: Database;
    enabled?: boolean;
    grants?: boolean;
    quota?: number;
    wrap?: (db: Database) => Database;
  } = {},
) {
  const base = options.base ?? (await connectDatabase("pglite://:memory:"));
  const suffix = randomUUID().replaceAll("-", "");
  const roles = {
    citygo_api: "cg018_http_" + suffix,
    citygo_worker: "cg018_worker_" + suffix,
    citygo_backup: "cg018_backup_" + suffix,
  };
  const roleFixture = syntheticPermissionRoleFixture(base);
  const lifecycle: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    const failures: unknown[] = [];
    try {
      if (lifecycle.app) await lifecycle.app.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await roleFixture.cleanup();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!options.base) await base.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic fixture cleanup failed");
  });
  await migrate(base);
  await base.exec(
    await readFile(
      new URL("./fixtures/r1-permissions-synthetic.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const role of Object.values(roles)) {
    await roleFixture.create(role);
    await base.exec("grant usage on schema public to " + role);
  }
  const common = (
    await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    )
  )
    .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
    .replace(
      /\bcitygo_(api|worker|backup)\b/g,
      (name) => roles[name as keyof typeof roles],
    );
  await base.exec(common);
  if (options.grants !== false)
    await base.exec(
      (
        await readFile(
          new URL(
            "./fixtures/r1-permissions-synthetic-grants.sql",
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll("cg018_synthetic_http", roles.citygo_api),
    );
  const control = new R1SyntheticPermissionStore(base, "synthetic_only");
  assert.deepEqual(
    await control.replaceConfiguration(1, syntheticRegistry, syntheticRoute),
    {
      status: "configuration_updated",
      revision: 2,
    },
  );
  const transaction = <T>(work: (tx: Sql) => Promise<T>) =>
    base.transaction(async (tx) => {
      await tx.query("set local role " + roles.citygo_api);
      return work(tx);
    });
  const scoped: Database = {
    transaction,
    query: <T>(sql: string, values?: unknown[]) =>
      transaction((tx) => tx.query<T>(sql, values)),
    exec: (sql) => transaction((tx) => tx.exec(sql)),
    close: async () => {},
  };
  const db = options.wrap?.(scoped) ?? scoped;
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({ NODE_ENV: "test" }),
    ...(options.enabled === false
      ? {}
      : {
          syntheticPermissions: { maxCommandsPerOwner: options.quota ?? 128 },
        }),
  });
  lifecycle.app = app;
  await app.ready();
  const repo = new Repository(base);
  async function person() {
    const id = await registerSyntheticConsentingUser(
      base,
      randomUUID() + "@example.test",
      "synthetic-unused-hash",
    );
    const token = randomUUID();
    await repo.createSession(id, tokenHash(token));
    return { id, token };
  }
  const call = (
    token: string,
    payload: object,
    extra: Record<string, string> = {},
  ) =>
    app!.inject({
      method: "POST",
      url: syntheticPermissionPath,
      payload,
      headers: {
        origin: "http://localhost:3000",
        authorization: "Bearer " + token,
        "X-CityGo-Contract-Version": "1",
        ...extra,
      },
    });
  const current = (
    token: string,
    suffix = "",
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: "GET",
      url: syntheticPermissionCurrentPath + suffix,
      headers: {
        authorization: "Bearer " + token,
        "X-CityGo-Contract-Version": "1",
        ...extra,
      },
    });
  const lookup = (
    token: string,
    scope: string,
    requestId: string,
    suffix = "",
  ) =>
    app.inject({
      method: "GET",
      url: `${syntheticPermissionPath}/${scope}/${requestId}${suffix}`,
      headers: {
        authorization: "Bearer " + token,
        "X-CityGo-Contract-Version": "1",
      },
    });
  async function counts() {
    return (
      await base.query(`select
      (select count(*)::int from cg018_synthetic.commands) as commands,
      (select count(*)::int from cg018_synthetic.decisions) as decisions,
      (select count(*)::int from consent_events) as consents,
      (select count(*)::int from ai_model_attempts) as attempts,
      (select count(*)::int from xp_events) as xp`)
    ).rows[0];
  }
  return {
    base,
    db,
    scoped,
    app,
    roles,
    repo,
    person,
    call,
    current,
    lookup,
    counts,
    control,
  };
}
