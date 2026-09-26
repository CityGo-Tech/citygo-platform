// Only the existing disposable pilot harness, never a user server or database.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, serviceEnv } from "./env.mjs";
import { until } from "./container-drain-smoke.mjs";

export async function releasePrepareSmoke({
  project,
  directory,
  origin,
  ingressDirectory,
  certificate,
  docker,
  compose,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  const config = JSON.parse(compose(["config", "--format", "json"]));
  assert.equal(config.name, project);
  assert.equal(config.services.api.environment.LLM_PROVIDER, "disabled");
  const images = Object.fromEntries(
    ["api", "web", "postgres", "worker", "migrator", "backup"].map((role) => {
      const id = docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        config.services[role].image,
      ]).trim();
      assert.match(id, /^sha256:[a-f0-9]{64}$/);
      return [role, id];
    }),
  );
  const fixture = join(directory, "prepare-fixture.json");
  // Test-only latch in the jobs image: Python forces its clean exit BETWEEN the
  // inventory and network reads. Actual Worker transactions/drain are covered
  // separately by worker-drain-smoke, not by this synthetic process.
  const worker = compose([
    "run",
    "-d",
    "--no-deps",
    "--pull",
    "never",
    "--name",
    `${project}-prepare-worker`,
    "--entrypoint",
    "node",
    "worker",
    "-e",
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); console.log('citygo-worker-race-ready');",
  ]).trim();
  assert.match(worker, /^[a-f0-9]{64}$/);
  try {
    assert.equal(
      docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}',
        worker,
      ]).trim(),
      project,
    );
    await until(
      () => docker(["logs", worker]).includes("citygo-worker-race-ready"),
      "Preparation Worker lifecycle fixture did not become ready",
    );
    writeFileSync(
      fixture,
      JSON.stringify({
        backup: JSON.parse(
          readFileSync(join(directory, "backup-fixture.json"), "utf8"),
        ),
        origin,
        ingress_directory: ingressDirectory,
        certificate,
        images,
        worker_id: worker,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const result = spawnSync(
      "python3",
      [
        "-E",
        "-s",
        "-B",
        "deploy/backup/prepare_smoke.py",
        "--disposable",
        fixture,
      ],
      {
        cwd: root,
        env: serviceEnv("test"),
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 65536,
      },
    );
    assert.equal(
      result.status,
      0,
      "Preparation fixture failed: " + result.stderr,
    );
    assert.equal(result.error, undefined);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.ok, true);
    assert.equal(proof.migration_authorized, false);
    assert.equal(proof.worker_exit_race_verified, true);
    assert.equal(proof.migration_committed, true);
    assert.equal(proof.startup_verified, true);
    assert.equal(proof.finish_verified, true);
    assert.equal(proof.commit_recovery_verified, true);
    assert.equal(proof.new_backup_verified, true);
    assert.equal(proof.second_release_verified, true);
    assert.ok(proof.retained_jobs_verified >= 4);
    assert.deepEqual(Object.keys(proof.apps).sort(), ["api", "web"]);
    assert.match(proof.migration_container, /^[a-f0-9]{64}$/);
    const migrated = JSON.parse(
      docker(["inspect", "--format", "{{json .}}", proof.migration_container]),
    );
    assert.equal(migrated.Config.Labels["com.docker.compose.project"], project);
    assert.equal(migrated.State.Status, "exited");
    assert.equal(migrated.State.ExitCode, 0);
    // Test-only cleanup of this exact, verified exited fixture container.
    docker(["rm", proof.migration_container]);
    assert.match(proof.worker_container, /^[a-f0-9]{64}$/);
    const finishedWorker = JSON.parse(
      docker(["inspect", "--format", "{{json .}}", proof.worker_container]),
    );
    assert.equal(
      finishedWorker.Config.Labels["com.docker.compose.project"],
      project,
    );
    assert.equal(
      finishedWorker.Config.Labels["com.docker.compose.service"],
      "worker",
    );
    assert.equal(finishedWorker.State.Status, "exited");
    assert.equal(finishedWorker.State.ExitCode, 0);
    docker(["rm", proof.worker_container]);
    for (const [id, role] of [
      [proof.second_migration_container, "migrator"],
      [proof.historical_worker_container, "worker"],
    ]) {
      assert.match(id, /^[a-f0-9]{64}$/);
      const retained = JSON.parse(
        docker(["inspect", "--format", "{{json .}}", id]),
      );
      assert.equal(
        retained.Config.Labels["com.docker.compose.project"],
        project,
      );
      assert.equal(retained.Config.Labels["com.docker.compose.service"], role);
      assert.equal(retained.State.Status, "exited");
      assert.equal(retained.State.ExitCode, 0);
      docker(["rm", id]);
    }
    assert.match(proof.historical_image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      docker([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "citygo.disposable.project"}}',
        proof.historical_image,
      ]).trim(),
      project,
    );
    docker(["image", "rm", proof.historical_image]);
    assert.deepEqual(proof.roles, ["api", "postgres", "web", "worker"]);
    console.log(
      "Two closed releases passed: real TLS/drain/backup/migration/start/health, interrupted-commit recovery, unchanged PostgreSQL and explicitly retained historical jobs; new config pg_dump/age and Worker verified in disposable fixture only; traffic/AI remain closed, no cloud",
    );
  } finally {
    // Exact container created by this random test project; never a general prune.
    assert.equal(
      docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}',
        worker,
      ]).trim(),
      project,
    );
    docker(["rm", "-f", worker]);
  }
}
