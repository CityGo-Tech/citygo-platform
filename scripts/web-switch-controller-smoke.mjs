// Whole production Host in an owned, network-isolated Docker-in-Docker host.
// No outer daemon socket, repository, credentials or host directory is mounted.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceEnv } from "./env.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const images = {
  dind: "docker@sha256:5efed980cba3fc126cf54e21a5a6ff8849d05b6e0623d6e7612f48e9cd6cd17e",
  python:
    "python@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258",
  nginx:
    "nginx@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94",
  node: "node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
  postgres:
    "postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
};
const plan = {
  kind: "citygo-disposable-whole-web-controller",
  images,
  privileged:
    "one owned official DinD test host; no host socket/mounts/ports; network none",
  outerMemoryBytes: 6 * 1024 ** 3,
  productionHost: true,
  candidateSockets: false,
  realProductApiOrBilling: false,
  syntheticDistinctWebReleases: true,
  cleanup: "exact owned outer container, volume and derived tools image only",
};
export function controllerFixtureEnv(inherited = process.env) {
  const env = serviceEnv("test", { inherited, loadFiles: false });
  for (const name of [
    "TEST_DATABASE_URL",
    "PLAYWRIGHT_BROWSERS_PATH",
    "CITYGO_METRIKA_E2E_ENABLED",
    "CITYGO_METRIKA_E2E_COUNTER_ID",
    "CITYGO_AD_PIXELS_E2E_ENABLED",
  ])
    delete env[name];
  return env;
}
export function localDockerEndpoint(context) {
  const endpoint = context?.Endpoints?.docker?.Host;
  assert.equal(typeof endpoint, "string");
  assert.ok(
    [...endpoint].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
      (/^unix:\/\/\/[^\r\n]+$/.test(endpoint) ||
        /^npipe:\/{2,}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)),
    "Only a local Unix/npipe Docker endpoint is permitted",
  );
  return endpoint;
}
export function controllerDiagnosticTail(previous, chunk, limit = 4000) {
  return (previous + chunk.toString()).slice(-limit);
}
export async function runControllerSmoke(cliArgs = process.argv.slice(2)) {
  const args = new Set(cliArgs);
  assert.ok(
    [...args].every((a) =>
      [
        "--plan",
        "--disposable",
        "--allow-privileged-fixture",
        "--pull-public-bases",
      ].includes(a),
    ),
  );
  if (args.has("--plan") || !args.has("--disposable")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    assert.ok(
      args.has("--allow-privileged-fixture"),
      "Explicit disposable privileged fixture flag required",
    );
    const token = randomBytes(6).toString("hex");
    const name = `citygo-controller-smoke-${token}`;
    const volume = `${name}-data`;
    const toolsTag = `citygo-controller-tools:${token}`;
    const nodeTag = `citygo-controller-base-node:${token}`;
    const postgresTag = `citygo-controller-base-postgres:${token}`;
    const evidence = join(root, ".local", "web-switch-controller-smoke", name);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "plan.json"), JSON.stringify(plan, null, 2));
    let containerId, toolsId;
    const env = controllerFixtureEnv();
    const prefix = [];
    const baseIds = {};
    const children = new Set();
    let interrupted = null;
    let cleaning = false;
    const ownership = {
      version: 1,
      fixtureToken: token,
      clientPid: process.pid,
      endpoint: null,
      status: "preparing",
      interrupted: null,
      directoryFsync: process.platform !== "win32",
      recovery:
        "SIGKILL/power loss cannot run finally. Inspect exact names/IDs and verify label/expected image before manual cleanup; never prune.",
      resources: {
        toolsTag: {
          kind: "image-tag",
          name: toolsTag,
          attempted: false,
          id: null,
          ownedLabel: token,
        },
        preflight: {
          kind: "container",
          name: name + "-preflight",
          attempted: false,
          id: null,
          ownedLabel: token,
        },
        volume: {
          kind: "volume",
          name: volume,
          attempted: false,
          ownedLabel: token,
        },
        nodeTag: {
          kind: "image-tag",
          name: nodeTag,
          attempted: false,
          id: null,
        },
        postgresTag: {
          kind: "image-tag",
          name: postgresTag,
          attempted: false,
          id: null,
        },
        host: {
          kind: "container",
          name,
          attempted: false,
          id: null,
          ownedLabel: token,
        },
      },
      events: [],
    };
    function persistOwnership() {
      const temporary = join(
        evidence,
        ".ownership-" + randomBytes(6).toString("hex"),
      );
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(ownership, null, 2));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, join(evidence, "ownership.json"));
        if (process.platform !== "win32") {
          const directory = openSync(evidence, "r");
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") {
            ownership.journalCleanupWarnings ??= [];
            ownership.journalCleanupWarnings.push(
              String(error.message).slice(0, 200),
            );
            ownership.journalCleanupWarnings =
              ownership.journalCleanupWarnings.slice(-8);
          }
        }
      }
    }
    function event(resource, action, stage, details = {}) {
      ownership.events.push({
        at: Date.now(),
        resource,
        action,
        stage,
        ...details,
      });
      if (ownership.events.length > 128) ownership.events.shift();
      persistOwnership();
    }
    function intent(resource, action) {
      ownership.resources[resource].attempted = true;
      ownership.resources[resource].status = action + "-intent";
      event(resource, action, "before");
    }
    function obtained(resource, details = {}) {
      Object.assign(ownership.resources[resource], details, {
        status: "created",
      });
      event(resource, "create", "after", details);
    }
    function checkInterrupted() {
      if (interrupted && !cleaning)
        throw new Error("Disposable fixture interrupted by " + interrupted);
    }
    const stopChildren = () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
    };
    const signals = ["SIGINT", "SIGTERM"].map((signal) => {
      const handler = () => {
        interrupted ??= signal;
        ownership.interrupted = interrupted;
        process.exitCode = signal === "SIGINT" ? 130 : 143;
        try {
          event(
            "client",
            "interrupt",
            cleaning ? "during-cleanup" : "requested",
            { signal },
          );
        } catch {
          /* Already recorded ownership remains usable. */
        }
        if (!cleaning) stopChildren();
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    function rawDocker(argv, options = {}) {
      checkInterrupted();
      const result = spawnSync("docker", [...prefix, ...argv], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 8 * 1024 ** 2,
        ...options,
      });
      checkInterrupted();
      return result;
    }
    function docker(argv, options = {}) {
      const result = rawDocker(argv, options);
      assert.equal(
        result.status,
        0,
        `Disposable Docker command failed: ${argv.slice(0, 3).join(" ")}; ${String(result.stderr).slice(-2500)}`,
      );
      return result.stdout.trim();
    }
    async function dockerLong(argv, timeout = 300000) {
      checkInterrupted();
      const child = spawn("docker", [...prefix, ...argv], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "",
        stderr = "",
        overflow = false,
        timer;
      child.stdout.on("data", (data) => {
        if (stdout.length + data.length > 8 * 1024 ** 2) {
          overflow = true;
          child.kill("SIGKILL");
        } else stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr = controllerDiagnosticTail(stderr, data);
      });
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          children.delete(child);
          resolve(code);
        });
      });
      try {
        const status = await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(
                new Error("Bounded Docker operation timed out: " + argv[0]),
              );
            }, timeout);
          }),
        ]);
        checkInterrupted();
        assert.ok(
          !overflow && status === 0,
          "Disposable Docker command failed: " +
            argv.slice(0, 3).join(" ") +
            "; " +
            stderr,
        );
        return stdout.trim();
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }
    async function loadCachedImages() {
      const save = spawn(
        "docker",
        [...prefix, "image", "save", nodeTag, postgresTag],
        {
          cwd: root,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const load = spawn(
        "docker",
        [...prefix, "exec", "-i", containerId, "/usr/bin/docker", "load"],
        { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let errors = "";
      for (const process of [save, load]) {
        children.add(process);
        process.once("close", () => children.delete(process));
        process.stderr.on("data", (data) => {
          errors = controllerDiagnosticTail(errors, data);
        });
      }
      load.stdout.resume();
      load.stdin.on("error", () => {});
      save.stdout.pipe(load.stdin);
      const completed = (process) =>
        new Promise((resolve, reject) => {
          process.once("error", reject);
          process.once("close", (code) => resolve(code));
        });
      let timer;
      try {
        const statuses = await Promise.race([
          Promise.all([completed(save), completed(load)]),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Bounded cached image transfer timed out")),
              120000,
            );
          }),
        ]);
        checkInterrupted();
        assert.deepEqual(statuses, [0, 0], "Image transfer failed: " + errors);
      } finally {
        clearTimeout(timer);
        save.stdout.unpipe(load.stdin);
        load.stdin.destroy();
        for (const child of [save, load])
          if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    try {
      persistOwnership();
      // Stored contexts can point to remote SSH/TCP daemons even without env vars.
      // Validate before pulls/builds/privileged creation, then pin the local host.
      const context = JSON.parse(docker(["context", "inspect"]))[0];
      const endpoint = localDockerEndpoint(context);
      prefix.push("--host", endpoint);
      ownership.endpoint = endpoint;
      event("endpoint", "pin-local", "after", { endpoint });
      writeFileSync(
        join(evidence, "endpoint.json"),
        JSON.stringify({ context: context.Name, endpoint }),
      );
      for (const [name, image] of Object.entries(images)) {
        if (args.has("--pull-public-bases")) {
          event(name, "pull-public-base", "before", { image });
          await dockerLong(["pull", image]);
          event(name, "pull-public-base", "after", { image });
        }
        const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
        assert.equal(imageInfo.Os, "linux");
        assert.equal(imageInfo.Architecture, "amd64");
        baseIds[name] = imageInfo.Id;
      }
      intent("toolsTag", "build");
      await dockerLong([
        "build",
        "--pull=false",
        "--network=none",
        "--label",
        "citygo.controller.fixture=" + token,
        "--build-arg",
        "PYTHON_IMAGE=" + images.python,
        "--build-arg",
        "NGINX_IMAGE=" + images.nginx,
        "--build-arg",
        "DIND_IMAGE=" + images.dind,
        "-f",
        "deploy/fixtures/web-switch-controller.Dockerfile",
        "-t",
        toolsTag,
        "deploy/fixtures",
      ]);
      toolsId = JSON.parse(docker(["image", "inspect", toolsTag]))[0].Id;
      obtained("toolsTag", { id: toolsId });
      // Fail on libc/TLS/pidfd composition BEFORE creating a privileged daemon.
      intent("preflight", "create");
      const preflightId = docker([
        "create",
        "--pull=never",
        "--name",
        ownership.resources.preflight.name,
        "--label",
        "citygo.controller.fixture=" + token,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--memory=256m",
        "--pids-limit=64",
        "--tmpfs",
        "/tmp:rw,size=16m,mode=1777",
        "--tmpfs",
        "/var/lib/docker:rw,size=16m",
        "--entrypoint",
        "/usr/local/bin/python3",
        toolsId,
        "-E",
        "-s",
        "-B",
        "-c",
        "import ssl,os,signal; assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'); print(ssl.OPENSSL_VERSION)",
      ]);
      assert.match(preflightId, /^[a-f0-9]{64}$/);
      obtained("preflight", { id: preflightId });
      event("preflight", "start", "before");
      await dockerLong(["start", "--attach", preflightId], 20000);
      assert.equal(
        JSON.parse(docker(["inspect", preflightId]))[0].State.ExitCode,
        0,
      );
      event("preflight", "start", "after");
      intent("volume", "create");
      docker([
        "volume",
        "create",
        "--label",
        `citygo.controller.fixture=${token}`,
        volume,
      ]);
      obtained("volume");
      ownership.resources.nodeTag.id = baseIds.node;
      intent("nodeTag", "tag");
      docker(["tag", images.node, nodeTag]);
      obtained("nodeTag", { id: baseIds.node });
      ownership.resources.postgresTag.id = baseIds.postgres;
      intent("postgresTag", "tag");
      docker(["tag", images.postgres, postgresTag]);
      obtained("postgresTag", { id: baseIds.postgres });
      intent("host", "create");
      containerId = docker([
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `citygo.controller.fixture=${token}`,
        "--privileged",
        "--network=none",
        "--memory=6g",
        "--memory-swap=6g",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/docker`,
        toolsId,
        "--wait-for-images",
        nodeTag,
        postgresTag,
      ]);
      assert.match(containerId, /^[a-f0-9]{64}$/);
      obtained("host", { id: containerId });
      const directory = "/opt/citygo-controller-fixture";
      for (const [source, destination] of [
        [
          "deploy/fixtures/web-switch-controller-harness.py",
          `${directory}/harness.py`,
        ],
        ["deploy/backup/web_switch.py", `${directory}/web_switch.py`],
        ["deploy/backup/backup.py", `${directory}/backup.py`],
        [
          "deploy/backup/web_switch_assets.py",
          `${directory}/web_switch_assets.py`,
        ],
        [
          "deploy/nginx/pilot-web-switch.conf.template",
          `${directory}/pilot-web-switch.conf.template`,
        ],
      ]) {
        event("host", "copy-trusted-code", "before", { source, destination });
        docker(["cp", join(root, source), `${containerId}:${destination}`]);
        event("host", "copy-trusted-code", "after", { source, destination });
      }
      event("host", "start", "before");
      docker(["start", containerId]);
      event("host", "start", "after");
      const deadline = Date.now() + 60000;
      while (true) {
        const info = JSON.parse(docker(["inspect", containerId]))[0];
        assert.equal(
          info.State.Running,
          true,
          "Fixture host exited before daemon readiness",
        );
        const ready = rawDocker(
          [
            "exec",
            containerId,
            "/usr/bin/docker",
            "info",
            "--format",
            "{{.ServerVersion}}",
          ],
          { timeout: 10000 },
        );
        if (ready.status === 0) break;
        assert.ok(Date.now() < deadline, "Isolated daemon did not start");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      event("host", "load-cached-images", "before");
      await loadCachedImages();
      event("host", "load-cached-images", "after");
      event("host", "admit-cached-images", "before");
      docker(["exec", containerId, "touch", "/run/citygo-images-ready"]);
      event("host", "admit-cached-images", "after");
      const status = Number(await dockerLong(["wait", containerId]));
      writeFileSync(join(evidence, "host.log"), docker(["logs", containerId]));
      docker(["cp", `${containerId}:/evidence/.`, evidence]);
      assert.equal(
        status,
        0,
        "Whole controller fixture failed; inspect owned evidence",
      );
      const receipt = JSON.parse(
        readFileSync(join(evidence, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.productionHost, true);
      assert.equal(receipt.retired, true);
      assert.notEqual(receipt.webImages.old, receipt.webImages.new);
      ownership.status = "passed";
      event("fixture", "verify-receipt", "after");
      console.log(JSON.stringify({ ...receipt, evidence }, null, 2));
    } finally {
      cleaning = true;
      stopChildren();
      const cleanup = { fixtureToken: token, steps: {}, errors: [] };
      const cleanupEvent = (resource, action, stage, details = {}) => {
        try {
          event(resource, action, stage, details);
        } catch (error) {
          cleanup.errors.push({
            step: "ownership-journal",
            message: String(error.message).slice(0, 500),
          });
        }
      };
      const clean = (name, action) => {
        try {
          cleanup.steps[name] = action();
          ownership.resources[name].status = cleanup.steps[name];
        } catch (error) {
          cleanup.errors.push({
            step: name,
            message: String(error.message).slice(0, 500),
          });
        }
        cleanupEvent(name, "cleanup", "after", {
          result: cleanup.steps[name] ?? "failed",
        });
      };
      const removeContainer = (resourceName) => {
        const resource = ownership.resources[resourceName];
        if (!resource.attempted) return "not-attempted";
        const ids = docker([
          "ps",
          "--all",
          "--no-trunc",
          "-q",
          "--filter",
          "name=^/" + resource.name + "$",
        ])
          .split(/\s+/)
          .filter(Boolean);
        if (!ids.length) return "verified-absent";
        assert.equal(ids.length, 1);
        assert.match(ids[0], /^[a-f0-9]{64}$/);
        if (resource.id)
          assert.equal(ids[0], resource.id, "Owned container identity changed");
        const info = JSON.parse(docker(["inspect", ids[0]]))[0];
        assert.equal(info.Name, "/" + resource.name);
        assert.equal(info.Config.Labels["citygo.controller.fixture"], token);
        resource.id = info.Id;
        const logs = rawDocker(["logs", info.Id], { timeout: 10000 });
        try {
          writeFileSync(
            join(
              evidence,
              resourceName === "host" ? "host.log" : "preflight.log",
            ),
            String(logs.stdout ?? "") + String(logs.stderr ?? ""),
          );
          if (resourceName === "host")
            rawDocker(["cp", info.Id + ":/evidence/.", evidence], {
              timeout: 20000,
            });
        } catch (error) {
          cleanup.errors.push({
            step: resourceName + "-diagnostics",
            message: String(error.message).slice(0, 500),
          });
        }
        cleanupEvent(resourceName, "remove-exact-container", "before", {
          id: info.Id,
        });
        docker(["rm", "--force", info.Id]);
        assert.ok(
          !docker([
            "ps",
            "--all",
            "--no-trunc",
            "-q",
            "--filter",
            "id=" + info.Id,
          ])
            .split(/\s+/)
            .includes(info.Id),
        );
        return "verified-removed";
      };
      const removeVolume = () => {
        const resource = ownership.resources.volume;
        if (!resource.attempted) return "not-attempted";
        if (!docker(["volume", "ls", "-q"]).split(/\s+/).includes(volume))
          return "verified-absent";
        const info = JSON.parse(docker(["volume", "inspect", volume]))[0];
        assert.equal(info.Labels["citygo.controller.fixture"], token);
        cleanupEvent("volume", "remove-owned-volume", "before");
        docker(["volume", "rm", volume]);
        assert.ok(
          !docker(["volume", "ls", "-q"]).split(/\s+/).includes(volume),
        );
        return "verified-removed";
      };
      const untag = (resourceName) => {
        const resource = ownership.resources[resourceName];
        if (!resource.attempted) return "not-attempted";
        const tags = docker([
          "image",
          "ls",
          "--format",
          "{{.Repository}}:{{.Tag}}",
          "--filter",
          "reference=" + resource.name,
        ]).split(/\s+/);
        if (!tags.includes(resource.name)) return "verified-absent";
        const info = JSON.parse(docker(["image", "inspect", resource.name]))[0];
        if (resource.id)
          assert.equal(
            info.Id,
            resource.id,
            "Owned tag changed; refusing removal",
          );
        else
          assert.equal(
            info.Config.Labels["citygo.controller.fixture"],
            token,
            "Unconfirmed build tag is not owned",
          );
        resource.id = info.Id;
        cleanupEvent(resourceName, "remove-owned-tag", "before", {
          id: info.Id,
        });
        docker(["image", "rm", resource.name]);
        assert.ok(
          !docker([
            "image",
            "ls",
            "--format",
            "{{.Repository}}:{{.Tag}}",
            "--filter",
            "reference=" + resource.name,
          ])
            .split(/\s+/)
            .includes(resource.name),
        );
        return "verified-removed";
      };
      try {
        // Each action is independent. A failed host removal cannot suppress the
        // ownership check/attempt for preflight, volume or either completed tag.
        clean("host", () => removeContainer("host"));
        clean("preflight", () => removeContainer("preflight"));
        clean("volume", removeVolume);
        clean("toolsTag", () => untag("toolsTag"));
        clean("nodeTag", () => untag("nodeTag"));
        clean("postgresTag", () => untag("postgresTag"));
        ownership.status = cleanup.errors.length
          ? "cleanup-incomplete"
          : interrupted
            ? "interrupted-cleaned"
            : "cleaned";
        cleanupEvent("fixture", "cleanup", "complete");
        writeFileSync(join(evidence, "cleanup.json"), JSON.stringify(cleanup));
        assert.equal(
          cleanup.errors.length,
          0,
          "Some owned cleanup failed; inspect cleanup.json",
        );
        checkInterrupted();
      } finally {
        for (const [signal, handler] of signals) process.off(signal, handler);
      }
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runControllerSmoke();
}
