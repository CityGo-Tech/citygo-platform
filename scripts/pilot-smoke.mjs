// Called only by the disposable container harness, with images it just built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { root, serviceEnv } from "./env.mjs";
import { renderNginx } from "../deploy/render-pilot.mjs";
import { ingressMaintenanceSmoke } from "./ingress-maintenance-smoke.mjs";
import { workerCoordinationSmoke } from "./worker-coordination-smoke.mjs";
import { releasePrepareSmoke } from "./release-prepare-smoke.mjs";
import { releaseMigrationSmoke } from "./release-migration-smoke.mjs";
import { routerAiProfileSmoke } from "./routerai-profile-smoke.mjs";

export async function pilotSmoke({
  apiImage,
  webImage,
  jobsImage,
  postgresImage = "postgres:17-alpine",
}) {
  const project = `citygo-pilot-test-${randomBytes(6).toString("hex")}`;
  const directory = mkdtempSync(join(tmpdir(), "citygo-pilot-test-"));
  const volume = `${project}_database`;
  const origin = "https://pilot.example.test";
  const env = {
    ...serviceEnv("test"),
    CITYGO_API_IMAGE: apiImage,
    CITYGO_WEB_IMAGE: webImage,
    CITYGO_JOBS_IMAGE: jobsImage,
    POSTGRES_IMAGE: postgresImage,
    CITYGO_ORIGIN: origin,
    CITYGO_SECRETS_DIR: directory,
    CITYGO_DB_VOLUME: volume,
  };
  const overrides = join(directory, "overrides.json");
  const base = [
    "compose",
    "--env-file",
    "deploy/smoke.env",
    "-p",
    project,
    "-f",
    "deploy/compose.pilot.yml",
    "-f",
    overrides,
    "--profile",
    "ops",
  ];
  function docker(
    args,
    { input, binary = false, timeout = 120000, fail = false } = {},
  ) {
    const r = spawnSync("docker", args, {
      cwd: root,
      env,
      input,
      encoding: binary ? undefined : "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (fail) assert.notEqual(r.status, 0);
    else if (r.status !== 0)
      throw new Error(
        `Pilot fixture operation failed: ${String(r.stderr).slice(-12000)}`,
      );
    return r.stdout;
  }
  const compose = (args, options) => docker([...base, ...args], options);
  const psql = (sql, database = "citygo_pilot") =>
    compose([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'export PGPASSWORD="$(cat /run/secrets/db_admin_password)"; exec psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"',
      "--",
      database,
      sql,
    ]).trim();
  let created = false;
  try {
    // These random credentials exist only in this disposable test, never user's .env.
    const passwords = {};
    for (const role of ["admin", "api", "migrate", "worker", "backup"]) {
      passwords[role] = randomBytes(32).toString("hex");
      writeFileSync(join(directory, `db_${role}_password`), passwords[role], {
        mode: 0o444,
      });
    }
    for (const mode of ["api", "migrate", "worker"])
      writeFileSync(
        join(directory, `${mode}.json`),
        JSON.stringify({
          DATABASE_URL: `postgresql://citygo_${mode === "migrate" ? "migrator" : mode}:${passwords[mode]}@postgres:5432/citygo_pilot`,
        }),
        { mode: 0o444 },
      );
    writeFileSync(
      overrides,
      JSON.stringify({
        services: {
          // Same runtime limits/secrets/networks, no real public bind or certificates.
          postgres: { restart: "no" },
          api: { restart: "no" },
          web: { restart: "no" },
        },
      }),
    );
    const config = JSON.parse(compose(["config", "--format", "json"]));
    for (const name of ["postgres", "api", "migrator", "worker", "backup"])
      assert.equal(config.services[name].ports, undefined);
    assert.equal(config.services.web.ports[0].host_ip, "127.0.0.1");
    assert.equal(config.services.web.secrets, undefined);
    assert.equal(config.services.api.environment.DATABASE_URL, undefined);
    assert.equal(config.services.api.environment.LLM_PROVIDER, "disabled");
    assert.equal(config.services.backup.secrets.length, 1);
    assert.equal(config.networks.database.internal, true);
    assert.equal(config.volumes.citygo_data.external, true);
    assert.ok(config.services.postgres.mem_limit <= 1024 * 1024 * 1024);
    docker(["volume", "create", volume]);
    created = true;
    compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres"]);
    compose(["run", "--rm", "--no-deps", "migrator"]);
    compose([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'export PGPASSWORD="$(cat /run/secrets/db_migrate_password)"; exec psql -U citygo_migrator -d citygo_pilot -v ON_ERROR_STOP=1 -f /opt/citygo/grants.sql',
    ]);
    await releaseMigrationSmoke({ project, directory, compose, docker, psql });
    await routerAiProfileSmoke({ project, directory, apiImage, docker, psql });
    compose(["up", "-d", "--wait", "--wait-timeout", "120", "api", "web"]);
    console.log("Pilot fixture: mounted-secret startup and migrations ready");
    const url = "http://127.0.0.1:3000";
    const request = (path, options) =>
      fetch(url + path, { ...options, signal: AbortSignal.timeout(10000) });
    const registration = await request("/api/v1/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-citygo-client": "native",
      },
      body: JSON.stringify({
        email: "pilot-fixture@example.test",
        password: "Synthetic-password-1234",
      }),
    });
    assert.equal(registration.status, 200);
    const { token } = await registration.json();
    const board = await request("/api/v1/dashboard", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(board.status, 200);
    const post = (path, body) =>
      request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post("/api/v1/questionnaire", {
          originCity: "Казань",
          targetCity: "Москва",
          monthlyBudget: 65000,
          moveTargetDate: "2099-01-01",
          household: "solo",
          aiConsent: true,
        })
      ).status,
      200,
    );
    const planned = await (
      await request("/api/v1/dashboard", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const questId = planned.quests.find((q) => q.slug === "housing-brief").id;
    assert.match(questId, /^[1-9]\d*$/);
    const started = await post(`/api/v1/quests/${questId}/start`, {});
    assert.equal(started.status, 200);
    const { id: threadId } = await started.json();
    assert.match(threadId, /^[1-9]\d*$/);
    assert.equal(
      (await post(`/api/v1/quests/${questId}/complete`, { confirmed: true }))
        .status,
      409,
    );
    // Explicit DB fixture, NOT a live model response: exercise runtime write grants
    // for completion/XP while production AI remains disabled.
    psql(
      `insert into messages(thread_id,role,content,metadata) values (${threadId},'assistant','Synthetic fixture only','{"agentKey":"housing","status":"complete","source":"model"}')`,
    );
    const completed = await post(`/api/v1/quests/${questId}/complete`, {
      confirmed: true,
    });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).awarded, 60);
    assert.equal(
      (
        await (
          await post(`/api/v1/quests/${questId}/complete`, { confirmed: true })
        ).json()
      ).awarded,
      0,
    );
    assert.equal(
      psql(
        "select bool_or(rolsuper or rolcreatedb or rolcreaterole or rolbypassrls) from pg_roles where rolname like 'citygo_%'",
      ),
      "f",
    );
    for (const table of [
      "citygo_migrations",
      "citygo_migration_lock",
      "audit_log",
      "consent_events",
      "ai_model_attempts",
    ])
      assert.equal(
        psql(`select has_table_privilege('citygo_api','${table}','UPDATE')`),
        "f",
      );
    assert.equal(
      psql(
        "select has_schema_privilege('citygo_api','public','CREATE') or has_schema_privilege('citygo_worker','public','CREATE')",
      ),
      "f",
    );
    assert.equal(psql("show max_connections"), "40");
    compose(["run", "--rm", "--no-deps", "worker"]);
    workerCoordinationSmoke({ directory, project, config, docker, jobsImage });
    // A canary counter proves financial reservations survive a logical restore.
    psql(
      "update ai_budget set total_limit_micros=123456,total_reserved_micros=123456 where id=1",
    );
    const backupEnv = join(directory, "backup.env");
    writeFileSync(
      backupEnv,
      Object.entries(env)
        .filter(
          ([key]) => key.startsWith("CITYGO_") || key === "POSTGRES_IMAGE",
        )
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      { mode: 0o600 },
    );
    const backupFixture = join(directory, "backup-fixture.json");
    const source = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(source.status, 0);
    writeFileSync(
      backupFixture,
      JSON.stringify({
        source_sha: source.stdout.trim(),
        project,
        compose_file: join(root, "deploy/compose.pilot.yml"),
        compose_env: backupEnv,
      }),
      { mode: 0o600 },
    );
    const encrypted = spawnSync(
      "python3",
      ["-B", "deploy/backup/smoke.py", "--disposable", backupFixture],
      { cwd: root, env, timeout: 180000, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(encrypted.status, 0, encrypted.stderr?.toString());
    console.log(
      "Release checkpoint passed: real pg_dump/age under continuous lock, retained pending, no migration; local S3 fixture only",
    );
    const dump = encrypted.stdout;
    assert.equal(dump.subarray(0, 5).toString(), "PGDMP");
    psql("create database citygo_restore_check owner citygo_migrator");
    compose(
      [
        "exec",
        "-T",
        "postgres",
        "sh",
        "-c",
        'export PGPASSWORD="$(cat /run/secrets/db_migrate_password)"; exec pg_restore -U citygo_migrator -d citygo_restore_check --no-owner --no-acl --exit-on-error',
      ],
      { input: dump },
    );
    for (const sql of [
      "select count(*) from users",
      "select count(*) from sessions",
      "select count(*) from citygo_migrations",
      "select sum(points) from xp_events",
      "select total_reserved_micros from ai_budget where id=1",
    ])
      assert.equal(psql(sql, "citygo_restore_check"), psql(sql));
    // New migration-owned tables are readable by backup, not writable by API.
    psql("set role citygo_migrator; create table future_fixture(id int)");
    assert.equal(
      psql(
        "select has_table_privilege('citygo_backup','future_fixture','SELECT') and not has_table_privilege('citygo_api','future_fixture','INSERT')",
      ),
      "t",
    );
    psql(
      "set role citygo_migrator; create function future_function_fixture() returns int language sql as $$ select 1 $$",
    );
    for (const role of ["citygo_api", "citygo_worker", "citygo_backup"])
      assert.equal(
        psql(
          `select has_function_privilege('${role}','future_function_fixture()','EXECUTE')`,
        ),
        "f",
      );
    console.log(
      "Pilot fixture: restricted-role journey and age-encrypted backup/restore passed (local S3 transport fixture)",
    );
    const persisted = async () => {
      const response = await request("/api/v1/dashboard", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(
        response.status,
        200,
        "Original session must survive release/restart",
      );
      const { user, profile, xp, quests, thread, provider } =
        await response.json();
      assert.equal(provider, "unconfigured", "Restart must not enable AI");
      return { user, profile, xp, quests, thread };
    };
    const beforeRestart = await persisted();
    assert.equal(beforeRestart.xp, 60);
    assert.ok(
      beforeRestart.thread.messages.some(
        (m) => m.content === "Synthetic fixture only",
      ),
    );
    assert.ok(
      beforeRestart.quests.some(
        (q) => q.id !== questId && q.state === "available",
      ),
    );
    await ingressSmoke({
      docker,
      compose,
      directory,
      project,
      verifyPersisted: async () => {
        assert.deepEqual(await persisted(), beforeRestart);
        const duplicate = await post(`/api/v1/quests/${questId}/complete`, {
          confirmed: true,
        });
        assert.equal(duplicate.status, 200);
        assert.equal(
          (await duplicate.json()).awarded,
          0,
          "Restart must not award XP twice",
        );
        assert.deepEqual(await persisted(), beforeRestart);
        console.log(
          "Closed restart persistence passed: original session/profile/quest/history/+60 XP/next quest, no duplicate reward, AI still disabled",
        );
      },
    });
    console.log(
      "Pilot smoke passed: mounted secrets, runtime limits, least-privilege roles, dump/restore, TLS/headers/SSE",
    );
  } catch (error) {
    if (created) {
      try {
        // Strictly disposable fixture data. Never reuse this log collector on a host.
        process.stderr.write(compose(["logs", "--no-color", "--tail", "60"]));
      } catch {
        /* Preserve the original failure if diagnostic collection also fails. */
      }
    }
    throw error;
  } finally {
    try {
      if (created) {
        compose(["down", "--remove-orphans"]);
        docker(["volume", "rm", volume]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function ingressSmoke({
  docker,
  compose,
  directory,
  project,
  verifyPersisted,
}) {
  const host = "pilot.example.test";
  const certificates = join(directory, "tls", host);
  mkdirSync(certificates, { recursive: true });
  const certificate = join(certificates, "fullchain.pem");
  const key = join(certificates, "privkey.pem");
  const cert = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cert.status, 0, "Could not generate disposable TLS fixture");
  const nginx = join(directory, "nginx.conf");
  writeFileSync(nginx, renderNginx(host));
  const ingressDirectory = join(directory, "ingress");
  mkdirSync(ingressDirectory, { mode: 0o755 });
  const trafficFile = join(ingressDirectory, "traffic-open");
  const challenges = join(directory, "acme", ".well-known", "acme-challenge");
  mkdirSync(challenges, { recursive: true });
  writeFileSync(join(challenges, "fixture"), "synthetic-acme-proof");
  const name = `${project}-ingress`;
  // Linux CI host networking reproduces the planned HOST Nginx -> loopback Web.
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    "-v",
    `${nginx}:/etc/nginx/conf.d/default.conf:ro`,
    "-v",
    `${join(directory, "tls")}:/etc/letsencrypt/live:ro`,
    "-v",
    `${ingressDirectory}:/var/lib/citygo/ingress:ro`,
    "-v",
    `${join(directory, "acme")}:/var/lib/letsencrypt:ro`,
    "nginx:stable-alpine",
  ]);
  try {
    docker(["exec", name, "nginx", "-t"]);
    function curl(
      path,
      { fail = false, headers = [], local = "127.0.0.1" } = {},
    ) {
      const r = spawnSync(
        "curl",
        [
          "--silent",
          "--show-error",
          "--noproxy",
          "*",
          "--cacert",
          certificate,
          "--resolve",
          `${host}:443:127.0.0.1`,
          "--interface",
          local,
          "--max-time",
          "10",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          ...headers.flatMap((h) => ["-H", h]),
          `https://${host}${path}`,
        ],
        { encoding: "utf8" },
      );
      if (!fail) assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    }
    // Nginx -t does not guarantee listen readiness yet.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (curl("/api/ready", { fail: true }) === "503") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      curl("/api/ready"),
      "503",
      "Missing operator marker must fail closed",
    );
    assert.equal(curl("/"), "503");
    const acme = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--resolve",
        `${host}:80:127.0.0.1`,
        "--max-time",
        "10",
        `http://${host}/.well-known/acme-challenge/fixture`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(acme.status, 0, acme.stderr);
    assert.equal(
      acme.stdout,
      "synthetic-acme-proof",
      "ACME must work during maintenance",
    );
    writeFileSync(trafficFile, "", { flag: "wx", mode: 0o644 });
    assert.equal(curl("/api/ready"), "200");
    // Spoofing XFF must not create fresh identities. A genuinely different socket
    // client must still get its own rate-limit bucket through the complete chain.
    let status;
    for (let i = 0; i < 125; i++)
      status = curl("/api/health", {
        headers: [
          `X-Forwarded-For: 192.0.2.${(i % 250) + 1}`,
          "Forwarded: for=198.51.100.1",
        ],
      });
    assert.equal(status, "429");
    assert.equal(curl("/api/health", { local: "127.0.0.2" }), "200");
    await releasePrepareSmoke({
      project,
      directory,
      origin: `https://${host}`,
      ingressDirectory,
      certificate,
      docker,
      compose,
    });
    assert.equal(curl("/api/ready"), "503");
    await verifyPersisted();
    // Reset ONLY this disposable harness for its existing SSE tests. The real
    // preparation module has no restart/reopen/unlock path.
    compose([
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "120",
      "api",
    ]);
    writeFileSync(trafficFile, "", { flag: "wx", mode: 0o644 });
    assert.equal(curl("/api/ready"), "200");
    // Replace ONLY the disposable API with a fixture bound to the same container
    // namespace. No test route enters the production application or image.
    compose(["stop", "api"]);
    const apiContainer = compose(["ps", "-aq", "api"]).trim();
    const network = JSON.parse(docker(["inspect", apiContainer]))[0]
      .NetworkSettings.Networks;
    const front = Object.keys(network).find((n) => n.endsWith("_web_api"));
    compose(["rm", "-f", "api"]);
    const fixtureName = `${project}-stream`;
    const script = `let writes=0;require('node:http').createServer((q,s)=>{if(q.url==='/maintenance-stream'){s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: first\\n\\n');setTimeout(()=>s.end('data: last\\n\\n'),5000)}else if(q.url==='/slow'){setTimeout(()=>{s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: first\\n\\n');setTimeout(()=>s.end('data: last\\n\\n'),1100)},35000)}else if(q.url==='/upstream-unavailable'){s.writeHead(503,{'content-type':'application/json'});s.end(JSON.stringify({fixtureUpstream:true}))}else{if(q.method==='POST')writes++;s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({status:'ok',writes}))}}).listen(4000,'0.0.0.0')`;
    docker([
      "run",
      "-d",
      "--name",
      fixtureName,
      "--network",
      front,
      "--ip",
      "172.30.92.11",
      "--network-alias",
      "api",
      "node:24-bookworm-slim",
      "node",
      "-e",
      script,
    ]);
    try {
      // Recreate Web to clear any pooled connection/DNS cache of the stopped API.
      compose(["up", "-d", "--no-deps", "--force-recreate", "--wait", "web"]);
      await ingressMaintenanceSmoke({ certificate, trafficFile });
      const r = spawnSync(
        "curl",
        [
          "--silent",
          "--show-error",
          "--no-buffer",
          "--noproxy",
          "*",
          "--cacert",
          certificate,
          "--resolve",
          `${host}:443:127.0.0.1`,
          "--max-time",
          "50",
          "-w",
          "\\n%{time_starttransfer} %{time_total}",
          `https://${host}/api/slow`,
        ],
        { encoding: "utf8", timeout: 55000 },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /data: first/);
      assert.match(r.stdout, /data: last/);
      const times = r.stdout.trim().split("\n").at(-1).split(" ").map(Number);
      assert.ok(
        times[0] >= 34 && times[0] < times[1] - 0.5,
        "SSE must survive 30s silence and flush before completion",
      );
    } finally {
      docker(["rm", "-f", fixtureName]);
    }
  } finally {
    docker(["rm", "-f", name]);
  }
}
