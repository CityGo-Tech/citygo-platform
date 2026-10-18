import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DomainError } from "@citygo/db";
import {
  accountMaintenance,
  prepareAccountMaintenanceConnection,
} from "./account-maintenance.js";

// Fictional connection descriptions only. No test in this file opens a DB or
// supplies all guards necessary to execute bootstrap.
const secretMarker = "SYNTHETIC_PASSWORD_MUST_NOT_APPEAR";
const rawUrl = `postgresql://citygo_migrator:${secretMarker}@db.example.invalid/citygo_test`;
const expectedTarget = "postgresql://db.example.invalid:5432/citygo_test";
const baseArgs = [
  "--expected-environment=test",
  `--expected-target=${expectedTarget}`,
];
const environment = {
  NODE_ENV: "test",
  CITYGO_ACCOUNT_DATABASE_URL: rawUrl,
  // The prepared URI supplies explicit port/options, so these never select an
  // alternate port or search_path through node-postgres's fallback defaults.
  PGPORT: "6543",
  PGOPTIONS: "-csearch_path=untrusted_schema -crole=postgres",
};
const rejected = (error: unknown) =>
  error instanceof DomainError && error.statusCode === 400;

test("maintenance preparation pins implicit 5432 and a controlled startup search_path", () => {
  const prepared = prepareAccountMaintenanceConnection(rawUrl, expectedTarget);
  const connection = new URL(prepared.connectionString);
  assert.equal(prepared.target, expectedTarget);
  assert.equal(connection.hostname, "db.example.invalid");
  assert.equal(connection.port, "5432");
  assert.equal(connection.pathname, "/citygo_test");
  assert.equal(connection.searchParams.size, 1);
  assert.equal(
    connection.searchParams.get("options"),
    "-csearch_path=pg_catalog,public,pg_temp",
  );
  assert.notEqual(connection.port, environment.PGPORT);
  assert.notEqual(
    connection.searchParams.get("options"),
    environment.PGOPTIONS,
  );
  // Original input is never mutated to silently authorize untrusted parameters.
  assert.equal(new URL(rawUrl).port, "");
  assert.equal(new URL(rawUrl).search, "");
});

test("explicit ports survive preparation and mismatched endpoints fail closed", () => {
  const explicit = rawUrl.replace(".invalid/", ".invalid:55438/");
  const target = expectedTarget.replace(":5432/", ":55438/");
  const prepared = prepareAccountMaintenanceConnection(explicit, target);
  assert.equal(new URL(prepared.connectionString).port, "55438");
  assert.equal(prepared.target, target);
  for (const mismatch of [
    target.replace("55438", "55439"),
    target.replace("db.example.invalid", "other.example.invalid"),
    target.replace("citygo_test", "different_database"),
  ])
    assert.throws(
      () => prepareAccountMaintenanceConnection(explicit, mismatch),
      rejected,
    );
});

test("all raw URI query overrides are rejected before driver parsing or connection", async () => {
  const overrides = [
    "?host=other.example.invalid",
    "?hostaddr=127.0.0.1",
    "?port=6543",
    "?options=-csearch_path%3Duntrusted_schema",
    "?user=postgres",
    "?password=another_synthetic_password",
    "?sslmode=disable",
    "?sslrootcert=C%3A%2Fsynthetic-do-not-read.pem",
    "?host=one.example.invalid&host=two.example.invalid",
  ];
  for (const query of overrides) {
    assert.throws(
      () => prepareAccountMaintenanceConnection(rawUrl + query, expectedTarget),
      rejected,
      query,
    );
    // Exercise the actual CLI path too, without relying on an absent database.
    await assert.rejects(
      accountMaintenance(baseArgs, {
        ...environment,
        CITYGO_ACCOUNT_DATABASE_URL: rawUrl + query,
      }),
      rejected,
    );
  }
});

test("expected targets reject credentials, query parameters, fragments and socket-like hosts", () => {
  for (const target of [
    `postgresql://operator:${secretMarker}@db.example.invalid:5432/citygo_test`,
    expectedTarget + "?options=-csearch_path%3Duntrusted_schema",
    expectedTarget + "#fragment",
    "pglite://:memory:",
    "postgresql://%2ftmp:5432/citygo_test",
    "not a connection target",
  ]) {
    assert.throws(
      () => prepareAccountMaintenanceConnection(rawUrl, target),
      (error: unknown) => {
        assert.ok(rejected(error));
        assert.equal((error as Error).message.includes(secretMarker), false);
        assert.equal((error as Error).message.includes(target), false);
        return true;
      },
    );
  }
});

test("reset apply is unavailable even with no valid environment or connection description", async () => {
  await assert.rejects(
    accountMaintenance(["--apply-reset"], {
      CITYGO_ACCOUNT_DATABASE_URL: "THIS_MUST_NEVER_BE_PARSED_OR_CONNECTED",
    }),
    (error: unknown) => {
      assert.ok(rejected(error));
      assert.match((error as Error).message, /Сброс не реализован/);
      return true;
    },
  );
  await assert.rejects(accountMaintenance(["--apply"], environment), rejected);
});

test("destructive fresh-start cannot connect without every exact operator guard", async () => {
  const required = [
    ...baseArgs,
    "--fresh-start",
    "--apply",
    "--erase-test-history",
    "--maintenance-confirmed",
    "--services-stopped-confirmed",
    "--expect-users=5",
    "--expected-snapshot=" + "a".repeat(64),
    "--backup-receipt-sha256=" + "b".repeat(64),
  ];
  for (const missing of required.filter(
    (item) =>
      !baseArgs.includes(item) &&
      item !== "--fresh-start" &&
      item !== "--apply",
  )) {
    await assert.rejects(
      accountMaintenance(
        required.filter((item) => item !== missing),
        {
          ...environment,
          CITYGO_ACCOUNT_BOOTSTRAP_CLOSED: "true",
        },
      ),
      rejected,
    );
  }
  await assert.rejects(accountMaintenance(required, environment), rejected);
  for (const conflicting of [
    "--restart-accounts",
    "--bootstrap-admin",
    "--retained-audits-reviewed",
  ])
    await assert.rejects(
      accountMaintenance([...required, conflicting], {
        ...environment,
        CITYGO_ACCOUNT_BOOTSTRAP_CLOSED: "true",
      }),
      rejected,
    );
  await assert.rejects(
    accountMaintenance([...baseArgs, "--erase-test-history"], environment),
    rejected,
  );
});

test("bootstrap and environment guards reject incomplete authority before connecting", async () => {
  const cases = [
    ["--unknown"],
    [...baseArgs, "--expect-users=5", "--expect-users=5"],
    [...baseArgs, "--expect-users=-1"],
    [...baseArgs, "--expect-users=1001"],
    [...baseArgs, "--bootstrap-admin", "--apply", "--expect-users=0"],
    [
      ...baseArgs,
      "--bootstrap-admin",
      "--apply",
      "--maintenance-confirmed",
      "--expect-users=5",
    ],
    [
      ...baseArgs,
      "--bootstrap-admin",
      "--apply",
      "--maintenance-confirmed",
      "--expect-users=0",
    ],
    [
      "--expected-environment=production",
      `--expected-target=${expectedTarget}`,
    ],
  ];
  for (const args of cases)
    await assert.rejects(accountMaintenance(args, environment), rejected);
  const help = await accountMaintenance(["--help"], {});
  assert.match(JSON.stringify(help), /no automatic startup/);
  assert.equal(JSON.stringify(help).includes(secretMarker), false);
});

test("closed restart requires every explicit apply guard before opening a connection", async () => {
  const args = [
    ...baseArgs,
    "--restart-accounts",
    "--apply",
    "--expect-users=5",
    `--expected-snapshot=${"a".repeat(64)}`,
    `--backup-receipt-sha256=${"b".repeat(64)}`,
    "--maintenance-confirmed",
    "--services-stopped-confirmed",
    "--retained-audits-reviewed",
  ];
  const closedEnvironment = {
    ...environment,
    CITYGO_ACCOUNT_BOOTSTRAP_CLOSED: "true",
  };
  for (const required of args.slice(baseArgs.length + 2))
    await assert.rejects(
      accountMaintenance(
        args.filter((arg) => arg !== required),
        closedEnvironment,
      ),
      rejected,
      `Missing ${required} must fail before connecting`,
    );
  for (const value of [undefined, "", "false", "1", "TRUE"])
    await assert.rejects(
      accountMaintenance(args, {
        ...closedEnvironment,
        CITYGO_ACCOUNT_BOOTSTRAP_CLOSED: value,
      }),
      rejected,
    );
  const help = await accountMaintenance(["--help"], {});
  assert.match(help.restart!, /--restart-accounts \(dry-run\)/);
  assert.match(help.restart!, /--retained-audits-reviewed/);
  assert.match(help.restart!, /do not stop services/);
});

test("restart cannot be confused with bootstrap, the legacy reset or unrelated receipt flags", async () => {
  for (const args of [
    [...baseArgs, "--restart-accounts", "--bootstrap-admin"],
    [...baseArgs, "--restart-accounts", "--apply-reset"],
    [...baseArgs, "--bootstrap-admin", "--services-stopped-confirmed"],
    [...baseArgs, "--bootstrap-admin", "--retained-audits-reviewed"],
    [...baseArgs, `--expected-snapshot=${"a".repeat(64)}`],
    [...baseArgs, `--backup-receipt-sha256=${"b".repeat(64)}`],
    [...baseArgs, "--restart-accounts", "--restart-accounts"],
  ])
    await assert.rejects(accountMaintenance(args, environment), rejected);
  for (const flag of ["--expected-snapshot", "--backup-receipt-sha256"])
    for (const value of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      secretMarker,
    ])
      await assert.rejects(
        accountMaintenance(
          [...baseArgs, "--restart-accounts", `${flag}=${value}`],
          environment,
        ),
        (error: unknown) => {
          assert.ok(rejected(error));
          assert.equal((error as Error).message.includes(secretMarker), false);
          return true;
        },
      );
});

test("operator maintenance has a separate dist entry without becoming API startup", () => {
  const source = new URL("./", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", source), "utf8"),
  ) as {
    files: string[];
    scripts: { build: string; start: string; dev: string };
  };
  assert.deepEqual(manifest.files, ["dist"]);
  assert.match(
    manifest.scripts.build,
    /(?:^|\s)\.\/src\/account-maintenance\.ts(?:\s|$)/,
  );
  assert.doesNotMatch(manifest.scripts.start, /account-maintenance/);
  assert.doesNotMatch(manifest.scripts.dev, /account-maintenance/);
  for (const entry of ["server.ts", "dev.ts"])
    assert.doesNotMatch(
      readFileSync(new URL(entry, source), "utf8"),
      /account-maintenance/,
    );
});

test("CLI entrypoint prints safe failures without URLs, credentials or driver stacks", () => {
  const entry = fileURLToPath(
    new URL("./account-maintenance.ts", import.meta.url),
  );
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  for (const args of [
    ["--apply-reset"],
    baseArgs,
    [...baseArgs, "--restart-accounts", "--apply"],
    [...baseArgs, "--restart-accounts", `--expected-snapshot=${secretMarker}`],
  ]) {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, ...args],
      {
        cwd,
        // Explicit synthetic environment only; no parent secrets or .env loading.
        env: {
          ...environment,
          CITYGO_ACCOUNT_DATABASE_URL: rawUrl + "?host=other.example.invalid",
        },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    const output = child.stdout + child.stderr;
    for (const sensitive of [
      secretMarker,
      rawUrl,
      "db.example.invalid",
      "other.example.invalid",
      "Error:",
      "at accountMaintenance",
    ])
      assert.equal(output.includes(sensitive), false);
    assert.equal(child.stdout, "");
    const failure = JSON.parse(child.stderr.trim()) as {
      error: string;
      status: number;
      accountsDeleted: number;
    };
    assert.equal(failure.status, 400);
    assert.equal(failure.accountsDeleted, 0);
  }
});
