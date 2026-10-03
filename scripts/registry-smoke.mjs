// Exercise the real publisher transport on a disposable Linux CI runner only.
// All GHCR names are mapped to a loopback-only registry; no real login/API call.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateDir,
  command,
  failureSummary,
  publishImages,
  organizationId,
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
    packageSourcesChecked: "true", // Synthetic operator confirmation, not a GHCR check.
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
      // Exercise the documented REST shape without the optional repository field.
      return {
        id: 1,
        name: path.split("/").at(-1),
        package_type: "container",
        visibility: "private",
        owner: { id: organizationId, login: "CityGo-Tech" },
      };
    },
  });
  assert.deepEqual(Object.keys(images), roles);
  const content = {};
  const registryJson = async (path) => {
    const response = await fetch(`http://${address}/v2/${path}`, {
      headers: {
        accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 262144);
    return text;
  };
  for (const role of roles) {
    const name = `fixture/citygo-platform-${role}`;
    const digest = images[role].split("@")[1];
    const manifest = await registryJson(`${name}/manifests/${digest}`);
    const configDigest = JSON.parse(manifest).config.digest;
    assert.match(configDigest, /^sha256:[a-f0-9]{64}$/);
    content[role] = {
      manifest,
      config: await registryJson(`${name}/blobs/${configDigest}`),
    };
  }
  const fixture = join(config, "image-fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      address,
      sha,
      images,
      ids: evidence.images,
      content,
      postgres: {
        reference: evidence.bases.postgres,
        id: docker([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          evidence.bases.postgres,
        ]),
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
  const imageProof = JSON.parse(
    command("python3", [
      "-E",
      "-s",
      "-B",
      "deploy/backup/image_smoke.py",
      "--disposable",
      fixture,
    ]),
  );
  assert.equal(imageProof.ok, true);
  assert.deepEqual(imageProof.roles, [...roles].sort());
  assert.equal(imageProof.missing_and_wrong_rejected, true);
  assert.equal(imageProof.real_content_simulated_containerd, true);
  assert.equal(imageProof.real_postgres_binding, true);
  assert.equal(imageProof.migration_authorized, false);
  console.log(
    "Local release image gate passed: real Docker digest inspection; missing/wrong images rejected; containerd contract tested with real manifest/config bytes and simulated backend, not a real containerd daemon; no deploy/pull/AI by verifier.",
  );
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
