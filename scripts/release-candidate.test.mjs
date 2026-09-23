import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { root } from "./env.mjs";
import {
  repository,
  roles,
  runtimeFiles,
  validateContext,
  validateBases,
  validateEvidence,
  selectCheckRun,
  gate,
  createManifest,
  publishImages,
  failureSummary,
} from "./release-candidate.mjs";

const sha = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const imageId = "sha256:" + "c".repeat(64);
const bases = {
  node: `node:24-bookworm-slim@${digest}`,
  postgres: `postgres:17-alpine@${digest}`,
};
const evidence = {
  version: 1,
  sourceSha: sha,
  bases,
  images: Object.fromEntries(roles.map((role) => [role, imageId])),
};
const context = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: "refs/heads/main",
  EXPECTED_SHA: sha,
  GITHUB_SHA: sha,
  RELEASE_ENABLED: "true",
  PUBLISH_CONFIRM: "PUBLISH_PRIVATE_IMAGES",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};
const privatePackage = {
  visibility: "private",
  repository: { full_name: repository },
};
const run = (workflow, overrides = {}) => ({
  id: 100,
  run_attempt: 1,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: `.github/workflows/${workflow}`,
  repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
  ...overrides,
});

test("publication requires explicit trusted main manual context", () => {
  assert.equal(validateContext(context), sha);
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "false",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "fork/citygo-platform",
    GITHUB_REF: "refs/heads/feature",
    EXPECTED_SHA: "$(curl evil)",
    GITHUB_SHA: "d".repeat(40),
    RELEASE_ENABLED: "",
    PUBLISH_CONFIRM: "true",
    GITHUB_RUN_ID: "../123",
    GITHUB_RUN_ATTEMPT: "0",
  }))
    assert.throws(
      () => validateContext({ ...context, [key]: value }),
      /Release rejected/,
    );
});

test("only fixed base repositories and real digests can enter Compose", () => {
  assert.equal(validateBases(bases), bases);
  for (const value of [
    "node:24-bookworm-slim",
    "evil.io/node@" + digest,
    bases.node + "\nCOMMAND=oops",
    "node:24-bookworm-slim@sha256:abc",
  ]) {
    assert.throws(() => validateBases({ ...bases, node: value }));
  }
  assert.throws(() =>
    validateBases({ ...bases, NODE_OPTIONS: "--require=evil" }),
  );
});

test("smoke evidence is closed, exact-source and requires all three local image IDs", () => {
  assert.equal(validateEvidence(evidence, sha), evidence);
  for (const value of [
    { ...evidence, sourceSha: "d".repeat(40) },
    { ...evidence, secret: "do-not-accept" },
    { ...evidence, images: { ...evidence.images, web: "latest" } },
    { ...evidence, images: { api: imageId, web: imageId } },
  ])
    assert.throws(() => validateEvidence(value, sha));
});

test("newest matching main push check must pass; old green and PR checks cannot authorize", () => {
  const green = run("ci.yml");
  assert.equal(selectCheckRun([green], sha, "ci.yml").id, 100);
  for (const status of ["queued", "in_progress", "completed"]) {
    assert.throws(() =>
      selectCheckRun(
        [green, run("ci.yml", { id: 101, status, conclusion: "failure" })],
        sha,
        "ci.yml",
      ),
    );
  }
  for (const overrides of [
    { event: "pull_request" },
    { head_branch: "other" },
    { head_sha: "d".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/repo" } },
  ]) {
    assert.throws(() =>
      selectCheckRun([run("ci.yml", overrides)], sha, "ci.yml"),
    );
  }
  assert.throws(() =>
    selectCheckRun(
      [
        green,
        run("ci.yml", {
          run_attempt: 2,
          conclusion: null,
          status: "in_progress",
        }),
      ],
      sha,
      "ci.yml",
    ),
  );
});

function githubFixture(overrides = {}) {
  return async (path) => {
    if (path === `/repos/${repository}`)
      return overrides.repo ?? { private: true, default_branch: "main" };
    if (path.endsWith("/git/ref/heads/main"))
      return { object: { sha: overrides.sha ?? sha } };
    if (path.includes("/actions/workflows/")) {
      const workflow = path.includes("/ci.yml/")
        ? "ci.yml"
        : "container-smoke.yml";
      return { total_count: 1, workflow_runs: [run(workflow, overrides.run)] };
    }
    if (path.includes("/packages/")) return overrides.pkg ?? privatePackage;
    throw new Error("Unexpected fixture request");
  };
}

test("gate cross-checks checkout, live main, private repo/packages and both workflows", async () => {
  const checks = await gate(context, githubFixture(), () => sha);
  assert.deepEqual(
    checks.map((check) => check.workflow),
    ["ci.yml", "container-smoke.yml"],
  );
  await assert.rejects(gate(context, githubFixture(), () => "d".repeat(40)));
  for (const overrides of [
    { sha: "d".repeat(40) },
    { repo: { private: false, default_branch: "main" } },
    { run: { conclusion: "cancelled" } },
    { pkg: { ...privatePackage, visibility: "public" } },
    { pkg: { ...privatePackage, repository: { full_name: "other/repo" } } },
  ])
    await assert.rejects(gate(context, githubFixture(overrides), () => sha));
  await assert.rejects(
    gate(
      context,
      async () => {
        throw new Error("offline");
      },
      () => sha,
    ),
  );
});

function publisherFixture(overrides = {}) {
  const calls = [];
  const docker = (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "image") {
      const pulled = args[2].includes("@");
      return JSON.stringify([
        {
          Id: pulled && overrides.wrongReadback ? digest : imageId,
          Os: "linux",
          Architecture: overrides.arch ?? "amd64",
          Config: {
            Labels: {
              "org.opencontainers.image.revision": overrides.label ?? sha,
            },
          },
        },
      ]);
    }
    if (args[0] === "push") {
      if (overrides.pushFailure) throw new Error("simulated registry outage");
      return overrides.noDigest
        ? "no digest"
        : `tag: digest: ${digest} size: 123`;
    }
    return "";
  };
  return {
    calls,
    args: {
      sha,
      evidence,
      runId: "123",
      attempt: "2",
      actor: "fixture-user",
      token: "synthetic-not-a-real-token",
      docker,
      read: async () => ({
        ...privatePackage,
        visibility: overrides.visibility ?? "private",
      }),
    },
  };
}

test("publisher sends token via stdin only and tags/pulls exactly the tested images without rebuild", async () => {
  const { calls, args } = publisherFixture();
  const images = await publishImages(args);
  assert.deepEqual(Object.keys(images), roles);
  assert.equal(calls.filter((call) => call.args[0] === "push").length, 3);
  for (const role of roles)
    assert.equal(
      images[role],
      `ghcr.io/citygo-tech/citygo-platform-${role}@${digest}`,
    );
  assert.equal(calls[0].options.input, args.token);
  assert.ok(calls.every((call) => !call.args.includes(args.token)));
  assert.ok(calls.every((call) => !call.args.includes("build")));
  assert.ok(
    calls
      .filter((call) => call.args[0] === "tag")
      .every(
        (call) =>
          call.args[1] === imageId && call.args[2].endsWith(`sha-${sha}-123-2`),
      ),
  );
});

test("wrong platform/source/readback, registry outage or non-private package stop publication", async () => {
  for (const overrides of [
    { arch: "arm64" },
    { label: "d".repeat(40) },
    { wrongReadback: true },
    { pushFailure: true },
    { noDigest: true },
    { visibility: "public" },
  ]) {
    const { calls, args } = publisherFixture(overrides);
    await assert.rejects(publishImages(args));
    assert.ok(calls.filter((call) => call.args[0] === "push").length <= 1);
  }
});

test("failure diagnostics expose only internal checks, never raw errors or assertion diffs", async () => {
  const marker = "SYNTHETIC_SECRET_MUST_NOT_BE_LOGGED";
  for (const error of [
    new Error(marker),
    new Error(`Release rejected: ${marker}`),
    new assert.AssertionError({
      actual: marker,
      expected: "ok",
      operator: "===",
    }),
    { message: marker },
    null,
  ]) {
    assert.equal(
      failureSummary(error),
      "Release rejected: unexpected operation failure (details suppressed)",
    );
  }
  const stages = [];
  const fixture = publisherFixture({ wrongReadback: true });
  await assert.rejects(
    publishImages({ ...fixture.args, report: (stage) => stages.push(stage) }),
    (error) => {
      assert.equal(
        failureSummary(error),
        "Release rejected: registry readback differs from tested image",
      );
      return true;
    },
  );
  assert.equal(stages.at(-1), "api: compare readback image identity");
  assert.ok(stages.every((stage) => !stage.includes(fixture.args.token)));
});

test("manifest has exact migration/runtime checksums, image digests and closed deployment gates", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citygo-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    ...runtimeFiles,
    "packages/db/migrations/0001_fixture.sql",
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), "fixture\n");
  }
  const images = Object.fromEntries(
    roles.map((role) => [
      role,
      `ghcr.io/citygo-tech/citygo-platform-${role}@${digest}`,
    ]),
  );
  const args = {
    sha,
    runId: "123",
    attempt: "1",
    checks: [],
    evidence,
    images,
    directory,
  };
  const manifest = createManifest(args);
  assert.equal(manifest.runtimeFiles.length, runtimeFiles.length);
  assert.match(manifest.migrations[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.policy, {
    llmProvider: "disabled",
    deploymentApproved: false,
    automaticRollback: false,
    schemaCompatibility: "operator-review-required",
  });
  assert.throws(() =>
    createManifest({
      ...args,
      images: { ...images, api: "ghcr.io/evil/image@" + digest },
    }),
  );
  writeFileSync(
    join(directory, "packages/db/migrations/0001_fixture.sql"),
    "changed\n",
  );
  assert.notEqual(
    createManifest(args).migrations[0].sha256,
    manifest.migrations[0].sha256,
  );
});

test("release workflow is manual, disabled by default, pinned and has no server/AI secrets", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /\n {2}workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|workflow_run):/);
  assert.match(workflow, /CITYGO_RELEASE_PUBLISH_ENABLED == 'true'/);
  assert.match(workflow, /cancel-in-progress: false/);
  for (const line of workflow
    .split("\n")
    .filter((line) => line.includes("uses:"))) {
    assert.match(line, /uses: actions\/[a-z-]+@[a-f0-9]{40} # v\d+/);
  }
  assert.doesNotMatch(
    workflow,
    /secrets\.|ssh|DATABASE_URL|OPENAI_API_KEY|ROUTERAI_API_KEY|GIGACHAT_CREDENTIALS/,
  );
  const compose = readFileSync(join(root, "deploy/compose.pilot.yml"), "utf8");
  assert.match(compose, /LLM_PROVIDER: disabled/);
});
