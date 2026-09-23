import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { root, serviceEnv } from "./env.mjs";
import { pilotSmoke } from "./pilot-smoke.mjs";
import {
  candidateDir,
  validateBases,
  validateEvidence,
} from "./release-candidate.mjs";

// Explicitly opt in; this script builds images and deletes ONLY its own disposable volume.
if (!process.argv.includes("--disposable"))
  throw new Error(
    "Container smoke requires --disposable; never run against a real deployment",
  );
assert.ok(
  process.argv
    .slice(2)
    .every((arg) => ["--disposable", "--release-candidate"].includes(arg)),
);
const releaseCandidate = process.argv.includes("--release-candidate");
const bases = releaseCandidate
  ? validateBases(
      JSON.parse(readFileSync(join(candidateDir, "build-inputs.json"), "utf8")),
    )
  : null;
const sourceSha = releaseCandidate
  ? spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: serviceEnv("test"),
      encoding: "utf8",
    }).stdout?.trim()
  : null;
if (releaseCandidate) assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/);
let evidence;
const project = `citygo-smoke-${randomBytes(6).toString("hex")}`;
const env = serviceEnv("test"); // No real root .env or cloud/LLM credentials passed to Docker.
const base = [
  "compose",
  "--env-file",
  "deploy/smoke.env",
  "-p",
  project,
  "-f",
  "deploy/compose.smoke.yml",
  "--profile",
  "jobs",
];
if (bases) {
  const override = join(candidateDir, "build-overrides.json");
  const app = {
    platform: "linux/amd64",
    build: { args: { NODE_IMAGE: bases.node, SOURCE_SHA: sourceSha } },
  };
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        api: app,
        web: app,
        migrator: app,
        worker: app,
        postgres: { image: bases.postgres, platform: "linux/amd64" },
      },
    }),
    { flag: "wx" },
  );
  base.push("-f", override);
}
function docker(args, { fail = false, timeout = 120000 } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (fail) {
    assert.notEqual(result.status, 0, "Expected container rejection");
  } else if (result.status !== 0) {
    // Harness has only fixture credentials. Never use this logger on a real deployment.
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Docker smoke operation failed: ${args[0]}`);
  }
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (fail ? (result.stderr ?? "") : "");
}
const compose = (args, options) => docker([...base, ...args], options);
const psql = (sql) =>
  compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "citygo_smoke",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    sql,
  ]).trim();
let created = false;
const canaryDirectory = mkdtempSync(
  join(root, "apps/container-context-canary-"),
);
try {
  for (const file of [".env", ".env.api", "runtime.key"])
    writeFileSync(
      join(canaryDirectory, file),
      "citygo-container-context-canary-20260923",
    );
  console.log("Building isolated production images (no publication)");
  compose(["build"], { timeout: 30 * 60 * 1000 });
  const config = JSON.parse(compose(["config", "--format", "json"]));
  for (const name of ["api", "postgres", "migrator", "worker"])
    assert.equal(
      config.services[name].ports,
      undefined,
      `${name} must not publish ports`,
    );
  assert.equal(config.services.web.ports[0].host_ip, "127.0.0.1");
  created = true;
  compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres"]);
  compose(["run", "--rm", "--no-deps", "migrator"]);
  const migrations = psql("select count(*) from citygo_migrations");
  assert.equal(migrations, "7");
  compose(["run", "--rm", "--no-deps", "migrator"]);
  assert.equal(psql("select count(*) from citygo_migrations"), migrations);
  compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "citygo_migrator",
    "-d",
    "citygo_smoke",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/fixtures/grants.sql",
  ]);
  assert.equal(
    psql(
      "select has_schema_privilege('citygo_api','public','CREATE') or has_table_privilege('citygo_api','citygo_migrations','UPDATE')",
    ),
    "f",
  );
  assert.equal(
    psql(
      "select bool_or(rolsuper or rolcreaterole or rolcreatedb) from pg_roles where rolname in ('citygo_api','citygo_worker','citygo_migrator')",
    ),
    "f",
  );
  compose(["up", "-d", "--wait", "--wait-timeout", "120", "api", "web"]);
  const url = "http://" + compose(["port", "web", "3000"]).trim();
  const request = (path, options) =>
    fetch(url + path, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/characters/housing-192.webp")).status, 200);
  assert.equal((await request("/figma/housing-navigator.png")).status, 200);
  assert.equal((await (await request("/api/ready")).json()).status, "ok");
  assert.equal((await request("/api/v1/dashboard")).status, 401);
  const credentials = {
    email: "container-smoke@example.test",
    password: "Synthetic-smoke-password-2026",
  };
  const registration = await request("/api/v1/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-citygo-client": "native",
    },
    body: JSON.stringify(credentials),
  });
  assert.equal(registration.status, 200);
  assert.match(
    registration.headers.get("set-cookie"),
    /__Host-citygo=.*Secure/i,
  );
  const { token } = await registration.json();
  assert.ok(token);
  const board = await request("/api/v1/dashboard", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(board.status, 200);
  assert.equal(board.headers.get("x-citygo-contract-version"), "1");
  const forbidden = await request("/api/v1/auth/logout", {
    method: "POST",
    headers: {
      origin: "https://untrusted.example",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(forbidden.status, 403);
  compose(["run", "--rm", "--no-deps", "worker"]);
  for (const mode of ["routerai", "gigachat"]) {
    // Reuse the API container's namespace: a second compose run would collide
    // with its fixed /32 address before it could exercise the provider gate.
    const output = compose(
      [
        "exec",
        "-T",
        "-e",
        "NODE_ENV=development",
        "-e",
        `LLM_PROVIDER=${mode}`,
        "api",
        "node",
        "scripts/container-runtime.mjs",
        "api",
      ],
      { fail: true },
    );
    assert.match(output, /production activation is blocked/);
  }
  const noDb = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-e",
      "DATABASE_URL=pglite://:memory:",
      "migrator",
    ],
    { fail: true },
  );
  assert.match(noDb, /Container startup failed/);
  for (const name of ["api", "web"]) {
    assert.notEqual(compose(["exec", "-T", name, "id", "-u"]).trim(), "0");
    compose([
      "exec",
      "-T",
      name,
      "node",
      "-e",
      "const fs=require('node:fs'); for(const p of ['.env','.env.api','.env.web','.local','node_modules/.bin/pnpm','node_modules/.bin/tsup']) if(fs.existsSync(p)) throw Error('Unexpected runtime file')",
    ]);
  }
  // Test DDL denial using the actual API image and its runtime role.
  compose([
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    "import assert from 'node:assert/strict'; import {connectDatabase} from '@citygo/db'; const db=await connectDatabase(process.env.DATABASE_URL); try { await assert.rejects(db.exec('create table must_not_create(id int)'), e=>e.code==='42501'); } finally { await db.close(); }",
  ]);
  compose(["restart", "postgres"]);
  compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres"]);
  compose([
    "up",
    "-d",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "120",
    "api",
    "web",
  ]);
  const afterUrl = "http://" + compose(["port", "web", "3000"]).trim();
  const persisted = await fetch(afterUrl + "/api/v1/dashboard", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    persisted.status,
    200,
    "User/session must survive DB restart and image recreation",
  );
  console.log(
    "Container smoke passed: migrations, restricted roles, assets, auth, persistence, AI gates",
  );
  const testedImages = {
    apiImage: docker([
      "inspect",
      "--format",
      "{{.Image}}",
      compose(["ps", "-q", "api"]).trim(),
    ]).trim(),
    webImage: docker([
      "inspect",
      "--format",
      "{{.Image}}",
      compose(["ps", "-q", "web"]).trim(),
    ]).trim(),
    jobsImage: docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      `${project}-migrator`,
    ]).trim(),
  };
  // Worker and migrator must be the identical jobs artifact, not separate builds.
  assert.equal(
    docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      `${project}-worker`,
    ]).trim(),
    testedImages.jobsImage,
  );
  await pilotSmoke({ ...testedImages, postgresImage: bases?.postgres });
  if (bases)
    evidence = validateEvidence(
      {
        version: 1,
        sourceSha,
        bases,
        images: {
          api: testedImages.apiImage,
          web: testedImages.webImage,
          jobs: testedImages.jobsImage,
        },
      },
      sourceSha,
    );
} finally {
  // Unique project generated above; never a user-supplied deployment name.
  try {
    if (created) compose(["down", "--volumes", "--remove-orphans"]);
  } finally {
    rmSync(canaryDirectory, { recursive: true, force: true });
  }
}
// No publishable evidence if smoke OR cleanup failed; never reuse stale evidence.
if (evidence)
  writeFileSync(
    join(candidateDir, "tested-images.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { flag: "wx" },
  );
