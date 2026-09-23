// Only the disposable pilot harness: real host runner + the just-built jobs image.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, serviceEnv } from "./env.mjs";

export function workerCoordinationSmoke({
  directory,
  project,
  config,
  docker,
  jobsImage,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  assert.equal(config.name, project);
  assert.equal(config.services.api.environment.LLM_PROVIDER, "disabled");
  const state = join(directory, "worker-coordination");
  mkdirSync(state, { mode: 0o700 });
  const composeFile = join(state, "compose.json");
  const composeEnv = join(state, "pilot.env");
  const configPath = join(state, "backup.json");
  writeFileSync(composeFile, JSON.stringify(config), {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(composeEnv, "# resolved synthetic Compose, no real keys\n", {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      upload_enabled: false,
      source_sha: "a".repeat(40),
      project,
      compose_file: composeFile,
      compose_env: composeEnv,
      state_dir: state,
      recipient:
        "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      storage_credentials_file: join(state, "nonexistent-storage.json"),
      endpoint: "https://s3.cloud.ru",
      bucket: "synthetic-no-upload",
      prefix: "citygo/fixture",
    }),
    { mode: 0o600, flag: "wx" },
  );
  const command = (operation, permission, expected) => {
    const result = spawnSync(
      "python3",
      [
        "-E",
        "-s",
        "-B",
        "deploy/backup/worker.py",
        operation,
        "--config",
        configPath,
        permission,
      ],
      {
        cwd: root,
        env: serviceEnv("test"),
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(
      result.status,
      expected,
      "Worker operator returned unexpected status: " + result.stderr,
    );
    assert.equal(result.error, undefined);
    return result.stdout;
  };
  let target;
  try {
    command("run", "--allow-worker", 1); // Missing admission cannot start Docker.
    assert.equal(existsSync(join(state, "operation-pending.json")), false);
    assert.match(command("open", "--allow-open", 0), /no job started/);
    assert.equal(existsSync(join(state, "worker-last-success.json")), false);
    assert.match(command("run", "--allow-worker", 0), /verified exit 0/);
    const receipt = JSON.parse(
      readFileSync(join(state, "worker-last-success.json"), "utf8"),
    );
    assert.match(receipt.container_id, /^[a-f0-9]{64}$/);
    assert.match(receipt.container_name, /^citygo-worker-[a-f0-9]{32}$/);
    target = receipt.container_id;
    const retained = JSON.parse(
      docker([
        "inspect",
        "--format",
        '{"Image":{{json .Image}},"Name":{{json .Name}},"State":{{json .State}},"Labels":{{json .Config.Labels}}}',
        target,
      ]),
    );
    assert.equal(retained.Labels["com.docker.compose.project"], project);
    assert.equal(retained.Labels["com.docker.compose.service"], "worker");
    assert.equal(retained.Name, "/" + receipt.container_name);
    assert.equal(retained.Image, jobsImage);
    assert.equal(retained.State.Status, "exited");
    assert.equal(retained.State.ExitCode, 0);
    assert.equal(existsSync(join(state, "operation-pending.json")), false);
    command("pause", "--allow-pause", 0);
    command("run", "--allow-worker", 1);
    command("pause", "--allow-pause", 0);
    assert.equal(
      readFileSync(join(state, "worker-last-success.json"), "utf8").includes(
        target,
      ),
      true,
    );
    console.log(
      "Worker coordination passed: default closed, explicit admission, retained verified jobs container, pause blocks next run; uploads disabled",
    );
  } finally {
    // Fixture cleanup only, after verifying the unique disposable project label.
    if (target) {
      const label = docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}',
        target,
      ]).trim();
      assert.equal(label, project);
      docker(["rm", target]);
    }
  }
}
