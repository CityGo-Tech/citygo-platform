// Called only by the disposable Linux harness; no deployment/server entry point.
import assert from "node:assert/strict";
import { until, startDocker } from "./container-drain-smoke.mjs";
import { assertCleanContainerStop } from "./container-stop-check.mjs";

export async function workerDrainSmoke({
  project,
  base,
  env,
  docker,
  compose,
  psql,
}) {
  assert.match(project, /^citygo-smoke-[a-f0-9]{12}$/);
  const config = JSON.parse(compose(["config", "--format", "json"]));
  assert.equal(config.name, project);
  assert.equal(config.services.api.environment.LLM_PROVIDER, "disabled");
  assert.deepEqual(config.services.worker.command, ["worker"]);
  const inspect = (id) =>
    JSON.parse(
      docker([
        "inspect",
        "--format",
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
  const postgres = target("postgres");
  const userId = psql(
    "insert into users(auth_subject) values ('worker-drain-fixture') returning id::text",
  ).split("\n")[0];
  assert.match(userId, /^[1-9]\d*$/);
  const budgetBefore = psql(
    "select row_to_json(b) from ai_budget b order by id",
  );
  psql(
    `insert into sessions(token_hash,user_id,expires_at) values ('worker-drain-live',${userId},now()+interval '1 day')`,
  );

  for (const outcome of ["complete", "timeout"]) {
    const hash = `worker-drain-${outcome}`;
    psql(
      `insert into sessions(token_hash,user_id,expires_at) values ('${hash}',${userId},now()-interval '1 day')`,
    );
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
      30000,
    );
    let stopping;
    try {
      // One synthetic row only. Keep production statement_timeout (10s) intact.
      lock.child.stdin.write(
        `begin; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='25s'; select token_hash from sessions where token_hash='${hash}' for update; select 'worker-lock-ready:' || pg_backend_pid();\n`,
      );
      await until(
        () => /worker-lock-ready:\d+/.test(lock.output()),
        "Worker fixture lock not acquired",
      );
      const lockPid = lock.output().match(/worker-lock-ready:(\d+)/)[1];
      // Retain the container after exit: --rm would destroy stop evidence.
      compose(["up", "-d", "--no-deps", "--force-recreate", "worker"]);
      await until(
        () =>
          psql(
            `select exists(select 1 from pg_stat_activity where usename='citygo_worker' and wait_event_type='Lock' and ${lockPid}=any(pg_blocking_pids(pid)))`,
          ) === "t",
        "Worker did not reach the fixture lock",
      );
      const worker = target("worker");
      assert.equal(worker.StopTimeout, 90);
      assert.equal(worker.Init, true);
      stopping = startDocker([...base, "stop", "worker"], env, 120000);
      stopping.child.stdin.end();
      await until(
        () => docker(["logs", worker.Id]).includes("CityGo worker draining"),
        "Worker did not enter drain",
      );
      for (const signal of ["SIGTERM", "SIGINT"])
        docker(["kill", `--signal=${signal}`, worker.Id]);
      assert.equal(
        inspect(worker.Id).State.Running,
        true,
        "Do not stop before the transaction settles",
      );
      assert.equal(
        psql(`select count(*) from sessions where token_hash='${hash}'`),
        "1",
      );
      if (outcome === "complete") {
        lock.child.stdin.end("commit;\n\\q\n");
        assert.deepEqual(await lock.done, { code: 0, signal: null });
      }
      // The timeout case leaves the row held until PostgreSQL rejects the worker
      // statement. CLI stop may succeed, but worker failure must block a release.
      assert.deepEqual(await stopping.done, { code: 0, signal: null });
      const after = inspect(worker.Id),
        logs = docker(["logs", worker.Id]);
      assert.equal((logs.match(/CityGo worker draining/g) ?? []).length, 1);
      if (outcome === "complete") {
        assertCleanContainerStop(worker, after);
        assert.equal(
          (logs.match(/CityGo maintenance completed/g) ?? []).length,
          1,
        );
        assert.doesNotMatch(logs, /CityGo worker failed/);
        assert.equal(
          psql(`select count(*) from sessions where token_hash='${hash}'`),
          "0",
        );
      } else {
        assert.equal(after.State.ExitCode, 1);
        assert.throws(() => assertCleanContainerStop(worker, after));
        // Worker writes failure to stderr; inspect code is the authoritative check.
        assert.doesNotMatch(logs, /CityGo maintenance completed/);
        assert.equal(
          psql(`select count(*) from sessions where token_hash='${hash}'`),
          "1",
        );
      }
      assert.equal(
        psql(
          "select count(*) from sessions where token_hash='worker-drain-live'",
        ),
        "1",
      );
      assert.equal(psql("select 1"), "1");
    } finally {
      if (!lock.child.stdin.destroyed && !lock.child.stdin.writableEnded)
        lock.child.stdin.end("rollback;\n\\q\n");
      await lock.done;
      if (stopping) await stopping.done;
    }
  }
  assert.equal(psql("select count(*) from ai_model_attempts"), "0");
  assert.equal(
    psql("select row_to_json(b) from ai_budget b order by id"),
    budgetBefore,
  );
  console.log(
    "Worker drain passed: real transaction completed before exit 0, repeated signals, DB timeout exit 1 rejected, live session preserved; AI disabled",
  );
}
