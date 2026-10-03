import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  context,
  waitForChecks,
  deploymentRequest,
  sshSettings,
} from "./deploy-main.mjs";
import { validateContext, repository } from "./release-candidate.mjs";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-main.yml@refs/heads/main`,
  CITYGO_ARTIFACT_ID: "456",
  GH_TOKEN: "synthetic-never-a-real-token",
};
const run = (workflow, status = "completed", conclusion = "success") => ({
  id: 12,
  run_attempt: 1,
  head_sha: env.GITHUB_SHA,
  head_branch: "main",
  event: "push",
  path: `.github/workflows/${workflow}`,
  repository: { full_name: repository },
  status,
  conclusion,
});
test("automatic publisher requires explicit standing opt-in and its own main workflow", () => {
  const auto = {
    ...env,
    RELEASE_MODE: "automatic-main",
    EXPECTED_SHA: env.GITHUB_SHA,
    AUTODEPLOY_ENABLED: "true",
    RELEASE_ENABLED: "true",
    PACKAGE_SOURCES_CHECKED: "true",
  };
  assert.equal(validateContext(auto), env.GITHUB_SHA);
  for (const change of [
    { AUTODEPLOY_ENABLED: "false" },
    { RELEASE_ENABLED: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/untrusted" },
    { GITHUB_WORKFLOW_REF: "other/workflow" },
    { PACKAGE_SOURCES_CHECKED: "false" },
  ])
    assert.throws(() => validateContext({ ...auto, ...change }));
});
test("request contains identity plus temporary read token, never commands or server paths", () => {
  assert.deepEqual(
    Object.keys(deploymentRequest(env)).sort(),
    [
      "version",
      "sha",
      "run_id",
      "run_attempt",
      "artifact_id",
      "github_token",
    ].sort(),
  );
  for (const change of [
    { GITHUB_REF: "refs/pull/5/merge" },
    { GITHUB_RUN_ID: "12; curl" },
    { CITYGO_ARTIFACT_ID: "../../secret" },
    { GITHUB_EVENT_NAME: "workflow_run" },
    { GH_TOKEN: "\nsecret" },
  ])
    assert.throws(() => deploymentRequest({ ...env, ...change }));
  assert.throws(() =>
    context({ ...env, GITHUB_REPOSITORY: "attacker/citygo-platform" }),
  );
});
test("opaque Bearer tokens match the shared server grammar without header injection", () => {
  const tokens = JSON.parse(
    readFileSync(new URL("./fixtures/deploy-bearer-tokens.json", import.meta.url), "utf8"),
  );
  for (const token of [...tokens.accepted, "x".repeat(4096)])
    assert.equal(deploymentRequest({ ...env, GH_TOKEN: token }).github_token, token);
  for (const token of [...tokens.rejected, "x".repeat(4097)])
    assert.throws(() => deploymentRequest({ ...env, GH_TOKEN: token }));
});
test("SSH requires host pin and does not accept options or shell destinations", () => {
  const settings = {
    CITYGO_DEPLOY_HOST: "203.0.113.1",
    CITYGO_DEPLOY_USER: "citygo-deploy",
    CITYGO_DEPLOY_KNOWN_HOSTS: "synthetic-pin",
    CITYGO_DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic",
  };
  assert.equal(sshSettings(settings), "citygo-deploy@203.0.113.1");
  for (const change of [
    { CITYGO_DEPLOY_HOST: "-oProxyCommand=bad" },
    { CITYGO_DEPLOY_USER: "root; id" },
    { CITYGO_DEPLOY_KNOWN_HOSTS: "" },
    { CITYGO_DEPLOY_SSH_KEY: "" },
  ])
    assert.throws(() => sshSettings({ ...settings, ...change }));
});
test("wait observes both exact main checks, pending then green", async () => {
  let cycle = 0;
  const read = async (path) =>
    path.includes("/git/ref/")
      ? { object: { sha: env.GITHUB_SHA } }
      : {
          total_count: 1,
          workflow_runs: [
            run(
              path.includes("ci.yml") ? "ci.yml" : "container-smoke.yml",
              cycle ? "completed" : "in_progress",
            ),
          ],
        };
  await waitForChecks(
    env,
    read,
    async () => {
      cycle++;
    },
    3,
  );
  assert.equal(cycle, 1);
});
test("new main, latest failed check and expired wait all stop publication", async () => {
  await assert.rejects(
    waitForChecks(
      env,
      async () => ({ object: { sha: "b".repeat(40) } }),
      async () => {},
      1,
    ),
  );
  for (const status of ["failure", "cancelled", "timed_out"]) {
    const read = async (path) =>
      path.includes("/git/ref/")
        ? { object: { sha: env.GITHUB_SHA } }
        : {
            total_count: 2,
            workflow_runs: [
              run("ci.yml"),
              { ...run("ci.yml", "completed", status), id: 13 },
            ],
          };
    await assert.rejects(waitForChecks(env, read, async () => {}, 1));
  }
  const missing = async (path) =>
    path.includes("/git/ref/")
      ? { object: { sha: env.GITHUB_SHA } }
      : { total_count: 0, workflow_runs: [] };
  await assert.rejects(waitForChecks(env, missing, async () => {}, 1));
});
test("workflow serializes releases and exposes SSH only after the publisher succeeds", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-main.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /needs: publish-candidate/);
  assert.match(workflow, /branches: \[main\]/);
  assert.ok(!workflow.includes("pull_request"));
  assert.ok(!workflow.includes("StrictHostKeyChecking=no"));
  const publish = workflow.split("  deploy:")[0];
  assert.ok(!publish.includes("CITYGO_DEPLOY_SSH_KEY"));
  assert.match(workflow.split("  deploy:")[1], /actions: read/);
});
