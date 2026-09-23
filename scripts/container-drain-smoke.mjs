// Only called from container-smoke --disposable. No server/deploy entry point.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./env.mjs";
import { assertCleanContainerStop } from "./container-stop-check.mjs";

async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}

// Keep promises handled even when an assertion fails before we await the child.
function startDocker(args, env, timeout) {
  const child = spawn("docker", args, {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout,
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-16384);
  });
  child.stderr.resume(); // Never echo process inputs/configuration on failure.
  child.stdin.on("error", () => {}); // Failure is reported by the exit status.
  const done = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: "spawn-error" }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, done, output: () => output };
}

export async function containerDrainSmoke({
  project,
  base,
  env,
  docker,
  compose,
  psql,
  url,
}) {
  assert.match(project, /^citygo-smoke-[a-f0-9]{12}$/);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const config = JSON.parse(compose(["config", "--format", "json"]));
  assert.equal(config.name, project);
  assert.equal(config.services.api.environment.LLM_PROVIDER, "disabled");
  assert.equal(config.services.api.init, true);
  const inspect = (id) =>
    JSON.parse(
      docker([
        "inspect",
        "--format",
        // PostgreSQL need not set StopTimeout/init. API must set both below.
        '{"Id":{{json .Id}},"Image":{{json .Image}},"RestartCount":{{json .RestartCount}},"State":{{json .State}},"Labels":{{json .Config.Labels}},"StopTimeout":{{json (index .Config "StopTimeout")}},"Init":{{json (index .HostConfig "Init")}}}',
        id,
      ]),
    );
  const target = (service) => {
    const id = compose(["ps", "-q", service]).trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const state = inspect(id);
    assert.equal(state.Labels["com.docker.compose.project"], project);
    assert.equal(state.Labels["com.docker.compose.service"], service);
    return state;
  };
  const api = target("api");
  assert.equal(api.StopTimeout, 330);
  assert.equal(api.Init, true);
  const postgres = target("postgres");
  const request = (path, options) =>
    fetch(url + path, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  const registration = await request("/api/v1/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-citygo-client": "native",
    },
    body: JSON.stringify({
      email: "drain-smoke@example.test",
      password: "Synthetic-drain-only-2026",
    }),
  });
  assert.equal(registration.status, 200);
  const { token, user } = await registration.json();
  assert.match(user.id, /^[1-9]\d*$/);
  const budget = () =>
    psql("select row_to_json(b) from ai_budget b order by id");
  const budgetBefore = budget();
  const profile = {
    originCity: "Казань",
    targetCity: "Москва",
    monthlyBudget: 65000,
    moveTargetDate: "2099-01-01",
    household: "solo",
    aiConsent: true,
  };
  const lock = startDocker(
    [
      "exec",
      "-i",
      postgres.Id,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "citygo_smoke",
    ],
    env,
    25000,
  );
  let pending;
  let stopping;
  try {
    // Deliberate, bounded contention on ONE synthetic user; no schema mutation.
    // Ordinary application transaction/statement timeouts are not relaxed.
    lock.child.stdin.write(
      `begin; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='20s'; select id from users where id=${user.id} for update; select 'citygo-drain-lock-ready:' || pg_backend_pid();\n`,
    );
    await until(
      () => /citygo-drain-lock-ready:\d+/.test(lock.output()),
      "Fixture row lock was not acquired",
    );
    const lockPid = lock.output().match(/citygo-drain-lock-ready:(\d+)/)[1];
    pending = request("/api/v1/questionnaire", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(profile),
    })
      .then(async (response) => ({
        status: response.status,
        body: await response.json(),
      }))
      .catch(() => ({ status: 0 }));
    // Admission is observed in PostgreSQL, not assumed from a sleep.
    await until(
      () =>
        psql(
          `select exists(select 1 from pg_stat_activity where usename='citygo_api' and wait_event_type='Lock' and ${lockPid}=any(pg_blocking_pids(pid)))`,
        ) === "t",
      "API did not reach the fixture lock",
    );
    stopping = startDocker([...base, "stop", "api"], env, 360000);
    stopping.child.stdin.end();
    await until(async () => {
      const response = await request("/api/ready");
      const body = await response.json();
      return response.status === 503 && body.code === "SERVICE_UNAVAILABLE";
    }, "API did not enter drain");
    assert.equal((await request("/api/health")).status, 200);
    const denied = await request("/api/v1/questionnaire", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(profile),
    });
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).retryable, false);
    assert.equal(
      inspect(api.Id).State.Running,
      true,
      "Must wait for accepted work",
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      docker(["kill", `--signal=${signal}`, api.Id]);
    assert.equal(
      psql(`select count(*) from relocation_profiles where user_id=${user.id}`),
      "0",
    );
    lock.child.stdin.end("commit;\n\\q\n");
    assert.deepEqual(await lock.done, { code: 0, signal: null });
    assert.deepEqual(await pending, { status: 200, body: { ok: true } });
    assert.deepEqual(await stopping.done, { code: 0, signal: null });
    assertCleanContainerStop(api, inspect(api.Id));
    const logs = docker(["logs", api.Id]);
    assert.equal((logs.match(/"msg":"API draining"/g) ?? []).length, 1);
    assert.equal(
      (logs.match(/"msg":"API shutdown complete"/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(logs, /API shutdown failed/);
    for (const table of ["relocation_profiles", "relocation_plans"])
      assert.equal(
        psql(`select count(*) from ${table} where user_id=${user.id}`),
        "1",
      );
    assert.equal(
      psql(
        `select count(*) from analytics_events where user_id=${user.id} and name='questionnaire_completed'`,
      ),
      "1",
    );
    assert.equal(psql("select count(*) from ai_model_attempts"), "0");
    assert.equal(budget(), budgetBefore);
  } finally {
    if (!lock.child.stdin.destroyed && !lock.child.stdin.writableEnded)
      lock.child.stdin.end("rollback;\n\\q\n");
    await lock.done;
    // Consume in-flight results before the parent harness removes its own project.
    if (pending) await pending;
    if (stopping) await stopping.done;
  }
  const restart = () =>
    compose([
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "api",
    ]);
  restart();
  const board = await request("/api/v1/dashboard", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(board.status, 200);
  assert.deepEqual((await board.json()).profile, profile);
  // Docker kill succeeds as a COMMAND. The resulting exit 137 must NOT count as
  // a successful application drain (nor permit a later migration/release).
  const killed = target("api");
  docker(["kill", "--signal=SIGKILL", killed.Id]);
  const afterKill = inspect(killed.Id);
  assert.equal(afterKill.State.ExitCode, 137);
  assert.throws(() => assertCleanContainerStop(killed, afterKill));
  assert.equal(psql("select 1"), "1", "PostgreSQL must remain running");
  restart();
  assert.equal((await request("/api/ready")).status, 200);
  console.log(
    "Container drain passed: accepted write persisted once, admission closed, repeated signals, exit 0, SIGKILL exit rejected; AI disabled",
  );
}
