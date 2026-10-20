// Deliberately separate provenance for one operator-local release. This module
// cannot publish, approve, deploy, enable AI/payments or manufacture GitHub runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { manifestContents, validateEvidence } from "./release-candidate.mjs";

export const localCheckCommands = Object.freeze({
  ci: Object.freeze([
    "pnpm install --frozen-lockfile",
    "pnpm typecheck",
    "pnpm check",
    "pnpm exec playwright install --with-deps chromium",
    "pnpm test:e2e",
    "pnpm mobile:export",
    "node scripts/check-env-artifacts.mjs",
  ]),
  "container-smoke": Object.freeze([
    "python3 -B -m unittest discover -s deploy/backup -p test_*.py -v",
    "node --test scripts/release-candidate.test.mjs scripts/deploy-main.test.mjs scripts/operator-release.test.mjs scripts/image-content.test.mjs",
    "node --test scripts/container-stop-check.test.mjs",
    "node --test scripts/ingress-maintenance.test.mjs",
    "node scripts/container-smoke.mjs --disposable --release-candidate",
    "node scripts/registry-smoke.mjs --disposable",
  ]),
});
const hash = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const operation = /^[a-f0-9]{32}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, fields) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
export function validateLocalChecks(value, sourceSha) {
  exact(value, [
    "version",
    "kind",
    "operationId",
    "sourceSha",
    "sourceTree",
    "sourceDigest",
    "platform",
    "node",
    "pnpm",
    "startedAt",
    "finishedAt",
    "checks",
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.kind, "operator-local-linux-checks-v1");
  assert.match(value.operationId, operation);
  assert.match(sourceSha, sha);
  assert.equal(value.sourceSha, sourceSha);
  assert.match(value.sourceTree, sha);
  assert.match(value.sourceDigest, hash);
  assert.equal(value.platform, "linux/amd64");
  assert.equal(value.node, "v24.11.1");
  assert.equal(value.pnpm, "10.15.0");
  for (const time of [value.startedAt, value.finishedAt])
    assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const started = Date.parse(value.startedAt),
    finished = Date.parse(value.finishedAt);
  assert.ok(
    Number.isFinite(started) &&
      finished >= started &&
      finished - started <= 86400000,
  );
  exact(value.checks, Object.keys(localCheckCommands));
  for (const [group, commands] of Object.entries(localCheckCommands)) {
    assert.ok(Array.isArray(value.checks[group]));
    assert.equal(value.checks[group].length, commands.length);
    for (const [index, result] of value.checks[group].entries()) {
      exact(result, [
        "command",
        "exitCode",
        "log",
        "sha256",
        "sourceDigestBefore",
        "sourceDigestAfter",
      ]);
      assert.equal(result.command, commands[index]);
      assert.equal(result.exitCode, 0);
      assert.match(result.log, /^[a-z0-9][a-z0-9-]{0,99}\.log$/);
      assert.match(result.sha256, hash);
      assert.equal(result.sourceDigestBefore, value.sourceDigest);
      assert.equal(result.sourceDigestAfter, value.sourceDigest);
    }
  }
  return value;
}

export function readLocalChecks(directory, expectedHash, sourceSha) {
  assert.match(expectedHash, hash);
  const root = resolve(directory);
  const read = (name) => {
    const path = join(root, name),
      info = lstatSync(path);
    assert.ok(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        info.size <= 64 * 1024 * 1024,
    );
    return readFileSync(path);
  };
  const raw = read("checks.json");
  assert.ok(raw.length <= 262144);
  assert.equal(digest(raw), expectedHash);
  const proof = validateLocalChecks(
    JSON.parse(raw.toString("utf8")),
    sourceSha,
  );
  const names = new Set();
  for (const checks of Object.values(proof.checks))
    for (const result of checks) {
      assert.ok(
        !names.has(result.log),
        "Each actual command requires its own preserved log",
      );
      names.add(result.log);
      assert.equal(digest(read(result.log)), result.sha256);
    }
  return proof;
}

export function createOperatorManifest({
  receiptDirectory,
  receiptSha256,
  evidence,
  images,
  directory,
}) {
  const proof = readLocalChecks(
    receiptDirectory,
    receiptSha256,
    evidence.sourceSha,
  );
  validateEvidence(evidence, proof.sourceSha);
  assert.match(receiptSha256, hash);
  return manifestContents({
    sha: proof.sourceSha,
    evidence,
    images,
    directory,
    identity: {
      version: 2,
      kind: "operator-local-candidate-not-deployed",
      releaseId: `${proof.sourceSha}-local-${proof.operationId}`,
      local: {
        kind: "operator-local-linux-v1",
        id: proof.operationId,
        receiptSha256,
        sourceTree: proof.sourceTree,
        sourceDigest: proof.sourceDigest,
        checks: Object.keys(localCheckCommands),
      },
    },
  });
}
