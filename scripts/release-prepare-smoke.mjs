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
        timeout: 180000,
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
    assert.deepEqual(proof.roles, ["api", "postgres", "web", "worker"]);
    console.log(
      "Release preparation passed: deterministic real-container Worker exit between inventory/network reads, strict stale-snapshot rejection, synthetic approved target revalidated, real closed TLS ingress, clean stop, pg_dump/age/readback, retained pending; no migration/cloud/AI",
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
