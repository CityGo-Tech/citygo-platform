// Exercise the real publisher transport on a disposable Linux CI runner only.
// All GHCR names are mapped to a loopback-only registry; no real login/API call.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateDir,
  command,
  failureSummary,
  publishImages,
  repository,
  roles,
  validateEvidence,
} from "./release-candidate.mjs";

assert.equal(process.platform, "linux");
assert.equal(process.env.CI, "true", "Disposable CI runner required");
assert.deepEqual(process.argv.slice(2), ["--disposable"]);
const sha = command("git", ["rev-parse", "HEAD"]);
const evidence = validateEvidence(
  JSON.parse(readFileSync(join(candidateDir, "tested-images.json"), "utf8")),
  sha,
);
const name = `citygo-registry-smoke-${randomBytes(8).toString("hex")}`;
const config = mkdtempSync(join(tmpdir(), "citygo-registry-fixture-"));
const docker = (args, options) =>
  command("docker", ["--config", config, ...args], options);
let container;
try {
  console.log(
    `Docker server version: ${docker(["version", "--format", "{{.Server.Version}}"])}`,
  );
  console.log(
    `Docker store: ${docker(["info", "--format", "{{json .DriverStatus}}"])}`,
  );
  container = docker(
    [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      "127.0.0.1::5000",
      "-e",
      "OTEL_TRACES_EXPORTER=none",
      "registry:3",
    ],
    { timeout: 120000 },
  );
  assert.match(container, /^[a-f0-9]{64}$/);
  const address = docker(["port", container, "5000/tcp"]);
  assert.match(address, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://${address}/v2/`, {
        redirect: "error",
        signal: AbortSignal.timeout(1000),
      });
      ready = response.ok;
      await response.body?.cancel();
      if (ready) break;
    } catch {
      /* disposable registry startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Loopback registry did not start");
  const syntheticToken = "registry-smoke-not-a-credential";
  const transport = (args, options = {}) => {
    if (args[0] === "login") {
      assert.deepEqual(args, [
        "login",
        "ghcr.io",
        "--username",
        "fixture",
        "--password-stdin",
      ]);
      assert.equal(options.input, syntheticToken);
      return "";
    }
    // Reject unknown transport operations rather than ever falling back to GHCR.
    assert.ok(["tag", "push", "pull", "image"].includes(args[0]));
    assert.equal(options.input, undefined);
    const mapped = args.map((arg) => {
      if (!arg.startsWith("ghcr.io/")) return arg;
      assert.match(
        arg,
        /^ghcr\.io\/citygo-tech\/citygo-platform-(api|web|jobs)(:sha-[a-f0-9]{40}-1-1|@sha256:[a-f0-9]{64})$/,
      );
      return arg.replace("ghcr.io/citygo-tech/", `${address}/fixture/`);
    });
    assert.ok(mapped.every((arg) => !arg.includes("ghcr.io")));
    return docker(mapped, options);
  };
  const images = await publishImages({
    sha,
    evidence,
    runId: "1",
    attempt: "1",
    actor: "fixture",
    token: syntheticToken,
    docker: transport,
    report: (stage) => console.log(`Registry rehearsal: ${stage}`),
    read: async (path) => {
      assert.ok(
        roles.some(
          (role) =>
            path ===
            `/orgs/CityGo-Tech/packages/container/citygo-platform-${role}`,
        ),
      );
      return { visibility: "private", repository: { full_name: repository } };
    },
  });
  assert.deepEqual(Object.keys(images), roles);
  console.log(
    "Registry rehearsal passed for all three tested images; no external publication or release manifest.",
  );
} catch (error) {
  console.error(failureSummary(error));
  process.exitCode = 1;
} finally {
  try {
    // Only the exact container created above and its disposable anonymous volume.
    if (container && /^[a-f0-9]{64}$/.test(container))
      docker(["rm", "-f", "-v", container]);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}
