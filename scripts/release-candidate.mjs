// Operator-triggered GHCR candidate only. No SSH, live DB, deploy or AI access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, serviceEnv } from "./env.mjs";

export const repository = "CityGo-Tech/citygo-platform";
export const roles = ["api", "web", "jobs"];
export const candidateDir = join(root, ".local/release-candidate");
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const runtimeFiles = [
  "deploy/compose.pilot.yml",
  "deploy/pilot.env.example",
  "deploy/render-pilot.mjs",
  "deploy/nginx/pilot.conf.template",
  "deploy/postgres/postgresql.conf",
  "deploy/postgres/init.sql",
  "deploy/postgres/grants.sql",
  "deploy/postgres/dump.sh",
  "deploy/backup/backup.py",
  "deploy/backup/config.example.json",
  "docs/runbooks/cloudru-runtime.md",
  "docs/runbooks/encrypted-backup.md",
  "docs/runbooks/release-candidate.md",
];
function requireValue(value, code) {
  if (!value) throw new Error(`Release rejected: ${code}`);
}
function keys(value, expected) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "object",
  );
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
export function validateBases(bases) {
  keys(bases, ["node", "postgres"]);
  for (const [name, tag] of [
    ["node", "node:24-bookworm-slim"],
    ["postgres", "postgres:17-alpine"],
  ]) {
    requireValue(
      typeof bases[name] === "string" && bases[name].startsWith(`${tag}@`),
      "base repository",
    );
    requireValue(
      digestPattern.test(bases[name].slice(tag.length + 1)),
      "base digest",
    );
  }
  return bases;
}
export function validateEvidence(evidence, sha) {
  keys(evidence, ["version", "sourceSha", "bases", "images"]);
  requireValue(
    evidence.version === 1 &&
      shaPattern.test(sha) &&
      evidence.sourceSha === sha,
    "smoke source",
  );
  validateBases(evidence.bases);
  keys(evidence.images, roles);
  for (const role of roles)
    requireValue(digestPattern.test(evidence.images[role]), "image ID");
  return evidence;
}
export function validateContext(env) {
  requireValue(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "manual Actions only",
  );
  requireValue(
    env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REF === "refs/heads/main",
    "trusted main only",
  );
  requireValue(
    shaPattern.test(env.EXPECTED_SHA) && env.EXPECTED_SHA === env.GITHUB_SHA,
    "explicit source SHA",
  );
  requireValue(
    env.RELEASE_ENABLED === "true" &&
      env.PUBLISH_CONFIRM === "PUBLISH_PRIVATE_IMAGES",
    "publication approval",
  );
  requireValue(
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT),
    "run identity",
  );
  return env.EXPECTED_SHA;
}
export function selectCheckRun(runs, sha, workflow) {
  const matches = runs.filter(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.path === `.github/workflows/${workflow}` &&
      run.repository?.full_name === repository,
  );
  matches.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
  const run = matches[0];
  requireValue(
    run && run.status === "completed" && run.conclusion === "success",
    `green ${workflow} required`,
  );
  return { workflow, id: run.id, attempt: run.run_attempt };
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: serviceEnv("test"),
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  // Never print headers, token-bearing environment or raw upstream error bodies.
  requireValue(
    !result.error && result.status === 0,
    `${program} operation failed`,
  );
  return result.stdout.trim();
}
const jsonRead = (path) => JSON.parse(readFileSync(path, "utf8"));
function jsonWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export async function github(path, { allowMissing = false } = {}) {
  requireValue(
    typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN.length > 0,
    "Actions token missing",
  );
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (allowMissing && response.status === 404) return null;
  requireValue(response.ok, "GitHub verification unavailable");
  return response.json();
}
export async function gate(
  env = process.env,
  read = github,
  head = () => command("git", ["rev-parse", "HEAD"]),
) {
  const sha = validateContext(env);
  requireValue(head() === sha, "checkout mismatch");
  const repo = await read(`/repos/${repository}`);
  requireValue(
    repo.private === true && repo.default_branch === "main",
    "private repository required",
  );
  const main = await read(`/repos/${repository}/git/ref/heads/main`);
  requireValue(
    main.object?.sha === sha,
    "main moved; select and test the new SHA",
  );
  const checks = [];
  for (const workflow of ["ci.yml", "container-smoke.yml"]) {
    const result = await read(
      `/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
    );
    requireValue(result.total_count <= 100, "ambiguous workflow history");
    checks.push(selectCheckRun(result.workflow_runs, sha, workflow));
  }
  // Refuse an existing public/internal package; never change package visibility.
  for (const role of roles) {
    const pkg = await read(
      `/orgs/CityGo-Tech/packages/container/citygo-platform-${role}`,
      { allowMissing: true },
    );
    requireValue(
      pkg === null ||
        (pkg.visibility === "private" &&
          pkg.repository?.full_name === repository),
      "package access/visibility",
    );
  }
  return checks;
}
export function prepareBases() {
  const bases = {};
  for (const [name, tag] of [
    ["node", "node:24-bookworm-slim"],
    ["postgres", "postgres:17-alpine"],
  ]) {
    command("docker", ["pull", "--platform", "linux/amd64", tag], {
      timeout: 5 * 60 * 1000,
    });
    const [info] = JSON.parse(command("docker", ["image", "inspect", tag]));
    requireValue(
      info.Os === "linux" && info.Architecture === "amd64",
      "base platform",
    );
    const digests = info.RepoDigests.filter((ref) =>
      ref.startsWith(`${name}@sha256:`),
    );
    requireValue(digests.length === 1, "base registry digest");
    bases[name] = `${tag}@${digests[0].split("@")[1]}`;
  }
  jsonWrite(join(candidateDir, "build-inputs.json"), validateBases(bases));
}
export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function createManifest({
  sha,
  runId,
  attempt,
  checks,
  evidence,
  images,
  directory = root,
}) {
  validateEvidence(evidence, sha);
  keys(images, roles);
  for (const role of roles) {
    const prefix = `ghcr.io/citygo-tech/citygo-platform-${role}@`;
    requireValue(
      typeof images[role] === "string" &&
        images[role].startsWith(prefix) &&
        digestPattern.test(images[role].slice(prefix.length)),
      "published image digest",
    );
  }
  requireValue(
    /^[1-9][0-9]*$/.test(String(runId)) &&
      /^[1-9][0-9]*$/.test(String(attempt)),
    "release identity",
  );
  const migrations = readdirSync(
    join(directory, "packages/db/migrations"),
  ).sort();
  requireValue(
    migrations.length > 0 &&
      migrations.every((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)),
    "migration inventory",
  );
  return {
    version: 1,
    kind: "candidate-not-deployed",
    repository,
    sourceSha: sha,
    releaseId: `${sha}-${runId}-${attempt}`,
    platform: "linux/amd64",
    run: { id: String(runId), attempt: String(attempt), checks },
    bases: evidence.bases,
    images,
    imageIds: evidence.images,
    migrations: migrations.map((name) => ({
      name,
      sha256: hashFile(join(directory, "packages/db/migrations", name)),
    })),
    runtimeFiles: runtimeFiles.map((path) => ({
      path,
      sha256: hashFile(join(directory, path)),
    })),
    policy: {
      llmProvider: "disabled",
      deploymentApproved: false,
      automaticRollback: false,
      schemaCompatibility: "operator-review-required",
    },
  };
}
export async function publishImages({
  evidence,
  sha,
  runId,
  attempt,
  actor,
  token,
  docker,
  read = github,
}) {
  validateEvidence(evidence, sha);
  requireValue(
    /^[1-9][0-9]*$/.test(runId) && /^[1-9][0-9]*$/.test(attempt),
    "publish identity",
  );
  requireValue(
    typeof actor === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(actor),
    "publisher identity",
  );
  requireValue(
    typeof token === "string" && token.length > 0,
    "publisher token",
  );
  const images = {};
  docker(["login", "ghcr.io", "--username", actor, "--password-stdin"], {
    input: token,
  });
  for (const role of roles) {
    const id = evidence.images[role];
    const [info] = JSON.parse(docker(["image", "inspect", id]));
    requireValue(
      info.Id === id && info.Os === "linux" && info.Architecture === "amd64",
      "tested image unavailable",
    );
    requireValue(
      info.Config.Labels?.["org.opencontainers.image.revision"] === sha,
      "image source label",
    );
    const name = `ghcr.io/citygo-tech/citygo-platform-${role}`;
    const tag = `${name}:sha-${sha}-${runId}-${attempt}`;
    docker(["tag", id, tag]);
    const output = docker(["push", tag], { timeout: 10 * 60 * 1000 });
    const digest = output.match(/digest: (sha256:[a-f0-9]{64})(?:\s|$)/)?.[1];
    requireValue(digestPattern.test(digest ?? ""), "push digest missing");
    const ref = `${name}@${digest}`;
    docker(["pull", "--platform", "linux/amd64", ref], {
      timeout: 5 * 60 * 1000,
    });
    const [pulled] = JSON.parse(docker(["image", "inspect", ref]));
    requireValue(
      pulled.Id === id,
      "registry readback differs from tested image",
    );
    const pkg = await read(
      `/orgs/CityGo-Tech/packages/container/citygo-platform-${role}`,
    );
    requireValue(
      pkg.visibility === "private" && pkg.repository?.full_name === repository,
      "published package is not private/linked",
    );
    images[role] = ref;
  }
  return images;
}
export async function publishCandidate() {
  const checks = await gate(); // Re-check main + CI immediately before any publication.
  const sha = process.env.EXPECTED_SHA;
  const evidence = validateEvidence(
    jsonRead(join(candidateDir, "tested-images.json")),
    sha,
  );
  const dockerConfig = mkdtempSync(join(tmpdir(), "citygo-release-auth-"));
  const docker = (args, options = {}) =>
    command("docker", ["--config", dockerConfig, ...args], options);
  try {
    const images = await publishImages({
      evidence,
      sha,
      docker,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      actor: process.env.GITHUB_ACTOR,
      token: process.env.GH_TOKEN,
    });
    // A manifest is written only after ALL three exact images pass registry readback.
    const manifest = createManifest({
      sha,
      checks,
      evidence,
      images,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    const outputDir = join(candidateDir, "bundle");
    for (const path of runtimeFiles) {
      mkdirSync(dirname(join(outputDir, path)), { recursive: true });
      copyFileSync(join(root, path), join(outputDir, path));
    }
    jsonWrite(join(outputDir, "release.json"), manifest);
    console.log(
      "Private candidate verified. No deployment or AI activation performed.",
    );
  } finally {
    // Exact freshly-created temporary directory, never shared Docker credentials.
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    requireValue(process.argv.length === 3, "one command required");
    switch (process.argv[2]) {
      case "gate":
        await gate();
        break;
      case "prepare":
        prepareBases();
        break;
      case "publish":
        await publishCandidate();
        break;
      default:
        throw new Error("Release rejected: unknown command");
    }
  } catch {
    // Do not serialize assertion diffs: future inputs may accidentally hold secrets.
    console.error(
      "Release candidate stopped. Check main/CI/approval, image evidence and private package access. No deployment attempted.",
    );
    process.exitCode = 1;
  }
}
