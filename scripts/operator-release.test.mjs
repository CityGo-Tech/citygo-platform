import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./env.mjs";
import {
  localCheckCommands,
  validateLocalChecks,
  readLocalChecks,
  createOperatorManifest,
} from "./operator-release.mjs";
import { createManifest, validateContext } from "./release-candidate.mjs";

const sourceSha = "a".repeat(40),
  operationId = "b".repeat(32),
  sourceDigest = "c".repeat(64);
const log = Buffer.from("Synthetic successful test, not release evidence\n");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  return {
    version: 1,
    kind: "operator-local-linux-checks-v1",
    operationId,
    sourceSha,
    sourceTree: "d".repeat(40),
    sourceDigest,
    platform: "linux/amd64",
    node: "v24.11.1",
    pnpm: "10.15.0",
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: "2026-10-20T01:00:00.000Z",
    checks: Object.fromEntries(
      Object.entries(localCheckCommands).map(([group, commands]) => [
        group,
        commands.map((command, index) => ({
          command,
          exitCode: 0,
          log: `${group}-${index}.log`,
          sha256: hash(log),
          sourceDigestBefore: sourceDigest,
          sourceDigestAfter: sourceDigest,
        })),
      ]),
    ),
  };
}
const evidence = {
  version: 1,
  sourceSha,
  bases: {
    node: `node:24-bookworm-slim@sha256:${"e".repeat(64)}`,
    postgres: `postgres:17-alpine@sha256:${"f".repeat(64)}`,
  },
  images: Object.fromEntries(
    ["api", "web", "jobs"].map((r) => [r, `sha256:${"1".repeat(64)}`]),
  ),
};
const images = Object.fromEntries(
  ["api", "web", "jobs"].map((r) => [
    r,
    `ghcr.io/citygo-tech/citygo-platform-${r}@sha256:${"2".repeat(64)}`,
  ]),
);

test("local proof requires every original check in order, exact source, finite toolchain and successful exit", () => {
  assert.equal(
    validateLocalChecks(fixture(), sourceSha).operationId,
    operationId,
  );
  const mutations = [
    (v) => {
      v.sourceSha = "e".repeat(40);
    },
    (v) => {
      v.platform = "win32";
    },
    (v) => {
      v.node = "v22.0.0";
    },
    (v) => {
      v.pnpm = "latest";
    },
    (v) => {
      v.checks.ci.pop();
    },
    (v) => {
      v.checks.ci.reverse();
    },
    (v) => {
      v.checks.ci[0].exitCode = 1;
    },
    (v) => {
      v.checks.ci[0].exitCode = "0";
    },
    (v) => {
      v.checks.ci[0].sourceDigestAfter = "f".repeat(64);
    },
    (v) => {
      v.checks.ci[0].command = "echo skipped";
    },
    (v) => {
      v.checks.ci[0].log = "../secret";
    },
    (v) => {
      v.checks.ci[0].sha256 = "";
    },
    (v) => {
      v.checks["container-smoke"] = [];
    },
    (v) => {
      v.githubRunId = "123";
    },
    (v) => {
      v.finishedAt = "2026-10-19T01:00:00.000Z";
    },
    (v) => {
      v.finishedAt = "2026-10-22T01:00:00.000Z";
    },
  ];
  for (const mutate of mutations) {
    const v = fixture();
    mutate(v);
    assert.throws(() => validateLocalChecks(v, sourceSha));
  }
});

test("local candidate verifies preserved command logs and has no fictional GitHub identity or deployment authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "citygo-local-proof-test-"));
  try {
    const proof = fixture(),
      raw = Buffer.from(JSON.stringify(proof));
    writeFileSync(join(directory, "checks.json"), raw);
    for (const results of Object.values(proof.checks))
      for (const r of results) writeFileSync(join(directory, r.log), log);
    const receiptSha256 = hash(raw);
    assert.deepEqual(
      readLocalChecks(directory, receiptSha256, sourceSha),
      proof,
    );
    const manifest = createOperatorManifest({
      receiptDirectory: directory,
      receiptSha256,
      evidence,
      images,
      directory: root,
    });
    assert.equal(manifest.version, 2);
    assert.equal(manifest.kind, "operator-local-candidate-not-deployed");
    assert.equal(manifest.releaseId, `${sourceSha}-local-${operationId}`);
    assert.equal("run" in manifest, false);
    assert.equal(manifest.local.receiptSha256, receiptSha256);
    assert.deepEqual(manifest.local.checks, ["ci", "container-smoke"]);
    assert.equal(manifest.policy.deploymentApproved, false);
    assert.equal(manifest.policy.llmProvider, "disabled");
    writeFileSync(join(directory, proof.checks.ci[0].log), "tampered");
    assert.throws(() =>
      createOperatorManifest({
        receiptDirectory: directory,
        receiptSha256,
        evidence,
        images,
        directory: root,
      }),
    );
    assert.throws(() => readLocalChecks(directory, "0".repeat(64), sourceSha));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal release still rejects missing/fabricated local GitHub provenance", () => {
  assert.throws(() =>
    validateContext({ EXPECTED_SHA: sourceSha, RELEASE_ENABLED: "true" }),
  );
  for (const runId of [undefined, "local", operationId])
    assert.throws(() =>
      createManifest({
        sha: sourceSha,
        runId,
        attempt: "1",
        checks: [],
        evidence,
        images,
      }),
    );
});
