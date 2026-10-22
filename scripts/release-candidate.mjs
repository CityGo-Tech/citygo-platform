// Verified GHCR candidate only. Deployment is a separate, restricted job.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
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
// Verified GitHub identities, not just reusable organization/repository names.
export const repositoryId = 1351070410;
export const organizationId = 248379281;
export const sourceUrl = `https://github.com/${repository}`;
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
  "deploy/backup/worker.py",
  "deploy/backup/release.py",
  "deploy/backup/migration_job.py",
  "deploy/backup/migrate.py",
  "deploy/backup/start.py",
  "deploy/backup/finish.py",
  "deploy/backup/control.py",
  "deploy/backup/recovery.py",
  "deploy/backup/prepare.py",
  "deploy/backup/target.py",
  "deploy/backup/image_gate.py",
  "deploy/backup/config.example.json",
  "deploy/backup/notify.py",
  "deploy/backup/schedule.py",
  "deploy/backup/mail.example.json",
  "deploy/backup/schedule.example.json",
  "deploy/backup/systemd/citygo-backup.service.template",
  "deploy/backup/systemd/citygo-backup.timer.template",
  "deploy/backup/systemd/citygo-backup-check.service.template",
  "deploy/backup/systemd/citygo-backup-check.timer.template",
  "docs/runbooks/cloudru-runtime.md",
  "docs/runbooks/encrypted-backup.md",
  "docs/runbooks/backup-operations.md",
  "docs/runbooks/worker-coordination.md",
  "docs/runbooks/release-backup-window.md",
  "docs/runbooks/release-preparation.md",
  "docs/runbooks/release-target.md",
  "docs/runbooks/release-images.md",
  "docs/runbooks/release-migration.md",
  "docs/runbooks/release-migration-job.md",
  "docs/runbooks/release-approved-migration.md",
  "docs/runbooks/release-start-health.md",
  "docs/runbooks/release-finish.md",
  "docs/runbooks/release-operator.md",
  "docs/runbooks/release-candidate.md",
  "docs/runbooks/operator-local-release.md",
  "docs/runbooks/routerai-deployment-profile.md",
];
// Only messages created here are safe to expose. Never serialize upstream errors,
// assertion diffs, subprocess output or request headers (including error causes).
class ReleaseRejection extends Error {}
export function failureSummary(error) {
  return error instanceof ReleaseRejection
    ? error.message
    : "Release rejected: unexpected operation failure (details suppressed)";
}
function requireValue(value, code) {
  if (!value) throw new ReleaseRejection(`Release rejected: ${code}`);
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
  const automatic = env.RELEASE_MODE === "automatic-main";
  requireValue(
    env.GITHUB_ACTIONS === "true" &&
      (automatic
        ? ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) &&
          env.AUTODEPLOY_ENABLED === "true" &&
          env.GITHUB_WORKFLOW_REF ===
            `${repository}/.github/workflows/deploy-main.yml@refs/heads/main`
        : env.GITHUB_EVENT_NAME === "workflow_dispatch"),
    "authorized Actions context only",
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
      (automatic || env.PUBLISH_CONFIRM === "PUBLISH_PRIVATE_IMAGES"),
    "publication approval",
  );
  requireValue(
    env.PACKAGE_SOURCES_CHECKED === "true",
    "operator package settings review required",
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
export function command(program, args, options = {}) {
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
  requireValue(
    response.ok,
    `GitHub verification unavailable (HTTP ${response.status})`,
  );
  return response.json();
}
export function validatePackage(pkg, role, packageSourcesChecked) {
  requireValue(
    packageSourcesChecked === "true",
    "operator package settings review required",
  );
  requireValue(roles.includes(role), "package role");
  requireValue(
    pkg?.visibility === "private",
    "package visibility must be private",
  );
  requireValue(
    Number.isSafeInteger(pkg.id) &&
      pkg.id > 0 &&
      pkg.package_type === "container" &&
      pkg.name === `citygo-platform-${role}` &&
      pkg.owner?.id === organizationId &&
      typeof pkg.owner?.login === "string" &&
      pkg.owner.login.toLowerCase() === "citygo-tech",
    "package destination identity",
  );
  // REST's repository is optional/nullable. Its absence is NOT proof of a link.
  // The operator reviews UI linkage/access; image origin is checked separately.
  if (pkg.repository === undefined || pkg.repository === null)
    return "not-reported";
  requireValue(
    pkg.repository.id === repositoryId &&
      typeof pkg.repository.full_name === "string" &&
      pkg.repository.full_name.toLowerCase() === repository.toLowerCase(),
    "package reports a different or malformed repository",
  );
  return "reported-match";
}
export function validateImageOrigin(info, id, sha) {
  requireValue(
    info?.Id === id && info.Os === "linux" && info.Architecture === "amd64",
    "tested image unavailable or wrong platform",
  );
  requireValue(
    info.Config?.Labels?.["org.opencontainers.image.source"] === sourceUrl &&
      info.Config?.Labels?.["org.opencontainers.image.revision"] === sha,
    "image source/revision labels",
  );
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
    repo.private === true &&
      repo.default_branch === "main" &&
      repo.id === repositoryId &&
      repo.full_name === repository &&
      repo.owner?.id === organizationId &&
      repo.owner?.login === "CityGo-Tech",
    "trusted private repository required",
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
    if (pkg !== null) validatePackage(pkg, role, env.PACKAGE_SOURCES_CHECKED);
  }
  return checks;
}
export function prepareBases(env = process.env) {
  const bases = {};
  const keepPostgres = ["automatic-main", "operator-local"].includes(
    env.RELEASE_MODE,
  );
  for (const [name, tag] of [
    ["node", "node:24-bookworm-slim"],
    ["postgres", "postgres:17-alpine"],
  ]) {
    // Automatic app releases must never upgrade the running database image.
    const ref =
      name === "postgres" && keepPostgres ? env.CITYGO_POSTGRES_IMAGE : tag;
    if (name === "postgres" && keepPostgres) {
      requireValue(
        typeof ref === "string" &&
          ref.startsWith(`${tag}@`) &&
          digestPattern.test(ref.slice(tag.length + 1)),
        "pinned server PostgreSQL required",
      );
    }
    command("docker", ["pull", "--platform", "linux/amd64", ref], {
      timeout: 5 * 60 * 1000,
    });
    const [info] = JSON.parse(command("docker", ["image", "inspect", ref]));
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
export function hashFile(path, limit = 262144, budget) {
  const info = lstatSync(path);
  requireValue(info.isFile() && info.size <= limit, "asset size/type");
  const bytes = readFileSync(path);
  requireValue(bytes.length <= limit, "asset size/type");
  if (budget) {
    budget.remaining -= bytes.length;
    requireValue(budget.remaining >= 0, "migration total size");
  }
  return createHash("sha256").update(bytes).digest("hex");
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
  requireValue(
    /^[1-9][0-9]*$/.test(String(runId)) &&
      /^[1-9][0-9]*$/.test(String(attempt)),
    "release identity",
  );
  return manifestContents({
    sha,
    evidence,
    images,
    directory,
    identity: {
      version: 1,
      kind: "candidate-not-deployed",
      releaseId: `${sha}-${runId}-${attempt}`,
      run: { id: String(runId), attempt: String(attempt), checks },
    },
  });
}

// Inventory hashing is shared, not authorization. The normal publisher still
// requires genuine GitHub run/check identities and its original live gate.
export function manifestContents({
  sha,
  evidence,
  images,
  directory = root,
  identity,
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
  const migrations = readdirSync(
    join(directory, "packages/db/migrations"),
  ).sort();
  requireValue(
    migrations.length > 0 &&
      migrations.length <= 1000 &&
      migrations.every(
        (name, i) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(name) &&
          Number(name.slice(0, 4)) >
            Number(migrations[i - 1]?.slice(0, 4) ?? 0),
      ),
    "migration inventory",
  );
  // Match the executor's aggregate budget, not just its per-file cap. Stat the
  // entire inventory before reading any SQL, then recheck actual bytes below.
  const budget = { remaining: 4 * 1024 * 1024 };
  let total = 0;
  for (const name of migrations) {
    const info = lstatSync(join(directory, "packages/db/migrations", name));
    requireValue(
      info.isFile() && info.size <= 4 * 1024 * 1024,
      "asset size/type",
    );
    total += info.size;
    requireValue(total <= budget.remaining, "migration total size");
  }
  const manifest = {
    ...identity,
    repository,
    sourceSha: sha,
    platform: "linux/amd64",
    bases: evidence.bases,
    images,
    imageIds: evidence.images,
    migrations: migrations.map((name) => ({
      name,
      sha256: hashFile(
        join(directory, "packages/db/migrations", name),
        4 * 1024 * 1024,
        budget,
      ),
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
  // Match target.py's exact on-disk JSON/file cap, including pretty-printing.
  requireValue(
    Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n") <= 262144,
    "manifest size",
  );
  return manifest;
}
export async function publishImages({
  evidence,
  sha,
  runId,
  attempt,
  actor,
  token,
  packageSourcesChecked,
  docker,
  read = github,
  report = () => {},
  directory = root,
  checks = [],
}) {
  validateEvidence(evidence, sha);
  requireValue(
    packageSourcesChecked === "true",
    "operator package settings review required",
  );
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
  // Preflight source SQL (4 MiB), runtime/ACL files (256 KiB), inventory and
  // manifest size BEFORE even inspecting Docker or logging into the registry.
  // Digest placeholders have exactly the same length as final immutable refs.
  createManifest({
    sha,
    runId,
    attempt,
    checks,
    evidence,
    directory,
    images: Object.fromEntries(
      roles.map((role) => [
        role,
        `ghcr.io/citygo-tech/citygo-platform-${role}@sha256:${"0".repeat(64)}`,
      ]),
    ),
  });
  // Validate ALL tested images before login/first push, not halfway through a release.
  for (const role of roles) {
    report(`${role}: inspect tested local image`);
    const id = evidence.images[role];
    const [info] = JSON.parse(docker(["image", "inspect", id]));
    validateImageOrigin(info, id, sha);
  }
  report("Registry login");
  docker(["login", "ghcr.io", "--username", actor, "--password-stdin"], {
    input: token,
  });
  for (const role of roles) {
    const id = evidence.images[role];
    const name = `ghcr.io/citygo-tech/citygo-platform-${role}`;
    const tag = `${name}:sha-${sha}-${runId}-${attempt}`;
    docker(["tag", id, tag]);
    report(`${role}: push`);
    const output = docker(["push", tag], { timeout: 10 * 60 * 1000 });
    report(`${role}: parse push digest`);
    const digest = output.match(/digest: (sha256:[a-f0-9]{64})(?:\s|$)/)?.[1];
    requireValue(digestPattern.test(digest ?? ""), "push digest missing");
    const ref = `${name}@${digest}`;
    report(`${role}: pull by digest`);
    docker(["pull", "--platform", "linux/amd64", ref], {
      timeout: 5 * 60 * 1000,
    });
    const [pulled] = JSON.parse(docker(["image", "inspect", ref]));
    report(`${role}: compare readback image identity`);
    requireValue(
      pulled?.Id === id,
      "registry readback differs from tested image",
    );
    validateImageOrigin(pulled, id, sha);
    report(`${role}: verify private package destination`);
    const pkg = await read(
      `/orgs/CityGo-Tech/packages/container/citygo-platform-${role}`,
    );
    const link = validatePackage(pkg, role, packageSourcesChecked);
    report(
      link === "reported-match"
        ? `${role}: repository metadata matches`
        : `${role}: repository not reported by API; settings rely on operator review`,
    );
    images[role] = ref;
    report(`${role}: verified`);
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
      checks,
      sha,
      docker,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      actor: process.env.GITHUB_ACTOR,
      token: process.env.GH_TOKEN,
      packageSourcesChecked: process.env.PACKAGE_SOURCES_CHECKED,
      report: (stage) => console.log(`Release stage: ${stage}`),
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
  } catch (error) {
    // Do not serialize assertion diffs: future inputs may accidentally hold secrets.
    console.error(`${failureSummary(error)}. No deployment attempted.`);
    process.exitCode = 1;
  }
}
