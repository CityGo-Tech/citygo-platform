// Only the existing disposable pilot harness, never a user server or database.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, serviceEnv } from "./env.mjs";

export function releasePrepareSmoke({
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
    }),
    { mode: 0o600, flag: "wx" },
  );
  // Retain a real one-off jobs container so preparation must account for it.
  const worker = compose([
    "run",
    "-d",
    "--no-deps",
    "--pull",
    "never",
    "--name",
    `${project}-prepare-worker`,
    "worker",
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
    assert.deepEqual(proof.roles, ["api", "postgres", "web", "worker"]);
    console.log(
      "Release preparation passed: real closed TLS ingress, API/one-off inventory and clean stop, stable DB network, pg_dump/age/readback, retained pending; no migration/cloud/AI",
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
