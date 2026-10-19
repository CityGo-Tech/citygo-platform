import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  verify,
  createPrivateKey,
  createHash,
} from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createRunnerAppClient,
  appJwt,
  APP_PERMISSIONS,
} from "../deploy/ci/github-runner-app.mjs";
import { admitQueuedJob } from "../deploy/ci/runner-job-policy.mjs";
import { probeMain } from "../deploy/ci/probe-runner-app.mjs";

// Entirely synthetic credentials. No file, environment, GCM or GitHub access.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const timestamp = Date.parse("2026-10-19T12:00:00.000Z");
const config = () => ({
  clientId: "Iv23syntheticCiApp01",
  installationId: 11,
  repositoryId: 123,
  privateKeyPem: pem,
});
function fixture(mainOnly = false) {
  const refs = ["ci.yml", "container-smoke.yml"].map(
    (x) =>
      `CityGo-Tech/citygo-platform/.github/workflows/${x}@${mainOnly ? "refs/heads/main" : "refs/pull/99/merge"}`,
  );
  const policy = {
    version: 1,
    repositoryId: 123,
    runnerGroupId: 9,
    runnerGroupName: "CityGo-isolated-checks",
    workflowRefs: refs,
    workflowSha256: Object.fromEntries(
      ["ci.yml", "container-smoke.yml"].map((x) => [
        ".github/workflows/" + x,
        "b".repeat(64),
      ]),
    ),
  };
  const snapshot = {
    observedAt: new Date(timestamp).toISOString(),
    repository: {
      id: 123,
      fullName: "CityGo-Tech/citygo-platform",
      private: true,
    },
    run: {
      id: 500,
      attempt: 1,
      workflowId: 400,
      path: ".github/workflows/ci.yml",
      name: "CI",
      event: mainOnly ? "push" : "pull_request",
      headSha: "a".repeat(40),
      headBranch: mainOnly ? "main" : "codex/test",
      headRepositoryId: 123,
      status: "queued",
      conclusion: null,
    },
    job: {
      id: 600,
      runId: 500,
      attempt: 1,
      name: "verify",
      status: "queued",
      conclusion: null,
      runnerId: 0,
      labels: ["citygo-ci-500-1-verify"],
    },
    source: {
      currentHeadSha: "a".repeat(40),
      workflowRef: refs[0],
      workflowSha256: "b".repeat(64),
    },
    group: {
      id: 9,
      name: "CityGo-isolated-checks",
      visibility: "selected",
      repositoryIds: [123],
      allowsPublicRepositories: false,
      restrictedToWorkflows: true,
      workflowRefs: refs,
    },
  };
  let id = 0;
  const plan = admitQueuedJob(policy, snapshot, snapshot.observedAt, () =>
    id++
      ? "98765432-1234-4234-8234-123456789abc"
      : "12345678-1234-4234-8234-123456789abc",
  );
  const repo = {
    id: 123,
    full_name: "CityGo-Tech/citygo-platform",
    private: true,
  };
  const routes = {
    "/orgs/CityGo-Tech/actions/runner-groups?per_page=100&page=1": {
      total_count: 1,
      runner_groups: [{ id: 1, name: "Default" }],
    },
    "/orgs/CityGo-Tech/actions/runner-groups": {
      id: 9,
      default: false,
      name: "CityGo-isolated-checks",
    },
    "/app/installations/11": {
      id: 11,
      account: { login: "CityGo-Tech", type: "Organization" },
      repository_selection: "selected",
      suspended_at: null,
      permissions: { ...APP_PERMISSIONS },
    },
    "/app/installations/11/access_tokens": {
      token: "ghs_" + "SYNTHETIC".repeat(5),
      expires_at: "2026-10-19T13:00:00Z",
      repository_selection: "selected",
      permissions: { ...APP_PERMISSIONS },
      repositories: [repo],
    },
    "/orgs/CityGo-Tech/actions/runner-groups/9": {
      id: 9,
      name: policy.runnerGroupName,
      default: false,
      inherited: false,
      visibility: "selected",
      allows_public_repositories: false,
      restricted_to_workflows: true,
      selected_workflows: refs,
    },
    "/orgs/CityGo-Tech/actions/runner-groups/9/repositories?per_page=100&page=1":
      { total_count: 1, repositories: [repo] },
    "/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1": {
      id: 500,
      run_attempt: 1,
      workflow_id: 400,
      path: plan.workflowPath,
      head_sha: plan.headSha,
      repository: repo,
      head_repository: repo,
      event: mainOnly ? "push" : "pull_request",
      head_branch: mainOnly ? "main" : "codex/test",
      status: "queued",
      conclusion: null,
    },
    "/repos/CityGo-Tech/citygo-platform/actions/jobs/600": {
      id: 600,
      run_id: 500,
      run_attempt: 1,
      head_sha: plan.headSha,
      name: "verify",
      status: "queued",
      conclusion: null,
      runner_id: 0,
      labels: [plan.label],
    },
    "/orgs/CityGo-Tech/actions/runners/generate-jitconfig": {
      runner: {
        id: 77,
        name: "citygo-ci-job-" + plan.operationId,
        os: "unknown",
        status: "offline",
        busy: false,
        labels: [{ name: plan.label, type: "custom", id: 1 }],
      },
      encoded_jit_config: Buffer.from(
        "SYNTHETIC_SINGLE_AGENT_CONFIG".repeat(4),
      ).toString("base64"),
    },
  };
  const calls = [];
  let time = timestamp;
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    const path = url.slice("https://api.github.com".length);
    calls.push({ path, options });
    assert.ok(Object.hasOwn(routes, path), path);
    assert.equal(options.redirect, "error");
    if (options.method === "PATCH")
      Object.assign(routes[path], JSON.parse(options.body));
    if (options.method === "PUT") {
      assert.deepEqual(JSON.parse(options.body), {
        selected_repository_ids: [123],
      });
      routes[path + "?per_page=100&page=1"] = {
        total_count: 1,
        repositories: [repo],
      };
      return new Response(null, { status: 204 });
    }
    const status = options.method === "POST" ? 201 : 200;
    return new Response(JSON.stringify(routes[path]), { status });
  };
  const client = createRunnerAppClient(config(), transport, () => time);
  return {
    policy,
    plan,
    repo,
    routes,
    calls,
    client,
    setTime: (x) => {
      time = x;
    },
  };
}

test("App JWT is verified RS256, issuer-bound and at most ten minutes including skew", () => {
  const jwt = appJwt("Iv23syntheticCiApp01", privateKey, timestamp);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const value = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(value.iss, "Iv23syntheticCiApp01");
  assert.equal(value.exp - value.iat, 600);
  assert.equal(value.iat, timestamp / 1000 - 60);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(header + "." + claims),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  assert.throws(
    () => appJwt("bad\nissuer", privateKey, timestamp),
    /jwt_invalid/,
  );
  assert.throws(
    () => appJwt("Iv23syntheticCiApp01", publicKey, timestamp),
    /jwt_invalid/,
  );
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
  assert.throws(
    () => appJwt("Iv23syntheticCiApp01", weak, timestamp),
    /jwt_invalid/,
  );
});

test("client refuses bad key/config with no secret in error and performs no network at construction", () => {
  for (const extra of [
    { arbitraryUrl: "https://evil.invalid" },
    { installationId: 0 },
    { repositoryId: 1.5 },
    { privateKeyPem: "PRIVATE_SECRET_MARKER" },
  ])
    assert.throws(
      () =>
        createRunnerAppClient({ ...config(), ...extra }, () => {
          throw Error("never");
        }),
      /^Error: ci_factory_app_/,
    );
  const client = createRunnerAppClient(config(), () => {
    throw Error("never at import/construction");
  });
  assert.deepEqual(Object.keys(client).sort(), [
    "clearCachedToken",
    "generateJit",
    "group",
    "inspect",
    "inspectGroup",
    "prAccess",
    "prepareGroup",
    "queued",
  ]);
  assert.equal(JSON.stringify(client).includes("PRIVATE"), false);
  assert.equal(createPrivateKey(pem).asymmetricKeyType, "rsa");
});

test("new group is selected-repo / selected-workflow only, verified independently and never overwritten", async () => {
  const f = fixture(true);
  const result = await f.client.prepareGroup(f.policy.workflowRefs);
  assert.equal(result.stage, "restricted_group_created");
  assert.equal(result.runnerRegistered, false);
  const post = f.calls.find(
    (x) => x.path === "/orgs/CityGo-Tech/actions/runner-groups",
  );
  assert.deepEqual(JSON.parse(post.options.body), {
    name: "CityGo-isolated-checks",
    visibility: "selected",
    selected_repository_ids: [123],
    allows_public_repositories: false,
    restricted_to_workflows: true,
    selected_workflows: f.policy.workflowRefs,
  });
  await assert.rejects(
    f.client.prepareGroup(f.policy.workflowRefs),
    /creation_refused/,
  );
  const g = fixture(true);
  g.routes[
    "/orgs/CityGo-Tech/actions/runner-groups?per_page=100&page=1"
  ].runner_groups[0].name = "CityGo-isolated-checks";
  await assert.rejects(
    g.client.prepareGroup(g.policy.workflowRefs),
    /already_exists/,
  );
  assert.equal(
    g.calls.some((x) => x.path === "/orgs/CityGo-Tech/actions/runner-groups"),
    false,
  );
  for (const refs of [
    fixture().policy.workflowRefs,
    ["foreign/repo/.github/workflows/ci.yml@main"],
    [
      ...f.policy.workflowRefs,
      "CityGo-Tech/citygo-platform/.github/workflows/deploy-main.yml@refs/heads/main",
    ],
  ])
    await assert.rejects(
      fixture().client.prepareGroup(refs),
      /creation_refused/,
    );
});

test("App access probe reports only bounded scope evidence, no runner or VM registration", async () => {
  const f = fixture();
  const value = await f.client.inspect();
  assert.equal(value.stage, "app_access_verified");
  assert.equal(value.runnerGroupsReadable, true);
  assert.equal(value.runnerRegistered, false);
  assert.equal(value.vmCreated, false);
  assert.equal(JSON.stringify(value).includes("ghs_"), false);
  f.routes[
    "/orgs/CityGo-Tech/actions/runner-groups?per_page=100&page=1"
  ].total_count = 101;
  await assert.rejects(f.client.inspect(), /groups_unbounded/);
});

function prFixture() {
  const f = fixture(true),
    mergeSha = "d".repeat(40);
  const intent = {
    prNumber: 99,
    headSha: f.plan.headSha,
    mergeSha,
    previousMergeSha: null,
    runnerGroupId: 9,
    workflowSha256: {},
  };
  const prefix = "/repos/CityGo-Tech/citygo-platform";
  f.routes["/orgs/CityGo-Tech/actions/runner-groups/9/repositories"] = {};
  const refHead = {
    ref: "refs/pull/99/head",
    object: { type: "commit", sha: intent.headSha },
  };
  const refMerge = {
    ref: "refs/pull/99/merge",
    object: { type: "commit", sha: mergeSha },
  };
  f.routes[prefix + "/git/ref/heads/main"] = {
    ref: "refs/heads/main",
    object: { type: "commit", sha: "f".repeat(40) },
  };
  f.routes[prefix + "/git/ref/pull/99/head"] = refHead;
  f.routes[prefix + "/git/ref/pull/99/merge"] = refMerge;
  f.routes[prefix + "/git/commits/" + mergeSha] = {
    sha: mergeSha,
    parents: [{ sha: "f".repeat(40) }, { sha: intent.headSha }],
  };
  const prRun = {
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: intent.headSha,
    repository: { ...f.repo },
    head_repository: { ...f.repo },
    pull_requests: [
      {
        number: 99,
        head: { sha: intent.headSha },
        base: { ref: "main", sha: "f".repeat(40) },
      },
    ],
  };
  f.routes[
    prefix +
      "/actions/runs?event=pull_request&head_sha=" +
      intent.headSha +
      "&per_page=100&page=1"
  ] = { total_count: 1, workflow_runs: [prRun] };
  f.routes[
    "/orgs/CityGo-Tech/actions/runner-groups/9/runners?per_page=100&page=1"
  ] = { total_count: 0, runners: [] };
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/container-smoke.yml",
  ]) {
    const bytes = Buffer.from("synthetic reviewed " + path + "\n");
    intent.workflowSha256[path] = createHash("sha256")
      .update(bytes)
      .digest("hex");
    f.routes[
      "/repos/CityGo-Tech/citygo-platform/contents/" + path + "?ref=" + mergeSha
    ] = {
      path,
      type: "file",
      size: bytes.length,
      content: bytes.toString("base64") + "\n",
      encoding: "base64",
      sha: createHash("sha1")
        .update("blob " + bytes.length + "\0")
        .update(bytes)
        .digest("hex"),
    };
  }
  return { ...f, intent, prRun, refHead, refMerge };
}

test("PR access adds only two immutable reviewed workflow pins, preserves selected private repo and never overwrites Default", async () => {
  const f = prFixture();
  const result = await f.client.prAccess(f.intent, "apply");
  assert.equal(result.stage, "reviewed_pr_group_verified");
  assert.equal(result.organization, "CityGo-Tech");
  assert.equal(result.workflowRefs.length, 2);
  assert.equal(
    result.workflowRefs.filter((x) => x.endsWith("@" + f.intent.mergeSha))
      .length,
    2,
  );
  const writes = f.calls.filter((x) => x.options.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/orgs/CityGo-Tech/actions/runner-groups/9");
  assert.deepEqual(JSON.parse(writes[0].options.body), {
    restricted_to_workflows: true,
    selected_workflows: result.workflowRefs,
  });
  const after = f.calls.length;
  await assert.rejects(f.client.prAccess(f.intent, "apply"), /attempt_exists/);
  assert.equal(f.calls.length, after);
  assert.equal((await f.client.prAccess(f.intent)).sourcePinsVerified, true);
  assert.equal(f.calls.filter((x) => x.options.method === "PATCH").length, 1);
  assert.equal(
    f.calls.some((x) => x.path.includes("/pulls/")),
    false,
  );
});

test("repository repair is explicit, exact-repo only and refuses a nonempty/foreign grant", async () => {
  for (const nonempty of [false, true]) {
    const f = prFixture();
    f.routes["/orgs/CityGo-Tech/actions/runner-groups/9"].selected_workflows =
      Object.keys(f.intent.workflowSha256).map(
        (path) =>
          "CityGo-Tech/citygo-platform/" + path + "@" + f.intent.mergeSha,
      );
    f.routes[
      "/orgs/CityGo-Tech/actions/runner-groups/9/repositories?per_page=100&page=1"
    ] = {
      total_count: nonempty ? 1 : 0,
      repositories: nonempty ? [{ id: 124 }] : [],
    };
    if (nonempty)
      await assert.rejects(
        f.client.prAccess(f.intent, "repair-repository"),
        /repair_refused/,
      );
    else
      assert.equal(
        (await f.client.prAccess(f.intent, "repair-repository"))
          .restrictedGroupVerified,
        true,
      );
    const writes = f.calls.filter((x) => x.options.method === "PUT");
    assert.equal(writes.length, nonempty ? 0 : 1);
    assert.equal(
      f.calls.some((x) => x.options.method === "PATCH"),
      false,
    );
    if (!nonempty)
      assert.equal(
        writes[0].path,
        "/orgs/CityGo-Tech/actions/runner-groups/9/repositories",
      );
  }
});

for (const fault of [
  "fork",
  "closed",
  "wrong base",
  "changed head",
  "changed merge",
  "workflow bytes",
  "busy group",
  "default group",
  "extra repo",
]) {
  test(`PR group write refused for ${fault}`, async () => {
    const f = prFixture();
    if (fault === "fork") f.prRun.head_repository.id = 124;
    if (fault === "closed")
      delete f.routes[
        "/repos/CityGo-Tech/citygo-platform/git/ref/pull/99/merge"
      ];
    if (fault === "wrong base") f.prRun.pull_requests[0].base.ref = "another";
    if (fault === "changed head") f.refHead.object.sha = "e".repeat(40);
    if (fault === "changed merge") f.refMerge.object.sha = "e".repeat(40);
    if (fault === "workflow bytes")
      f.intent.workflowSha256[".github/workflows/ci.yml"] = "0".repeat(64);
    if (fault === "busy group")
      f.routes[
        "/orgs/CityGo-Tech/actions/runner-groups/9/runners?per_page=100&page=1"
      ].total_count = 1;
    if (fault === "default group")
      f.routes["/orgs/CityGo-Tech/actions/runner-groups/9"].default = true;
    if (fault === "extra repo")
      f.routes[
        "/orgs/CityGo-Tech/actions/runner-groups/9/repositories?per_page=100&page=1"
      ].total_count = 2;
    await assert.rejects(
      f.client.prAccess(f.intent, "apply"),
      /^Error: ci_factory_app_/,
    );
    assert.equal(
      f.calls.some((x) => x.options.method === "PATCH"),
      false,
    );
  });
}

test("PR-pinned queued job rechecks the current pull request before JIT issuance", async () => {
  const f = prFixture();
  await f.client.prAccess(f.intent, "apply");
  const refs =
    f.routes["/orgs/CityGo-Tech/actions/runner-groups/9"].selected_workflows;
  const plan = { ...f.plan, workflowRef: refs[0] };
  const policy = { ...f.policy, workflowRefs: refs };
  const run =
    f.routes["/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1"];
  run.event = "pull_request";
  run.head_branch = "codex/test";
  run.pull_requests = [{ number: 99 }];
  f.refMerge.object.sha = "e".repeat(40);
  await assert.rejects(f.client.generateJit(plan, policy), /pr_source_changed/);
  assert.equal(
    f.calls.some((x) => x.path.endsWith("/generate-jitconfig")),
    false,
  );
});

test("group reconciliation is read-only, detects absent group and validates existing policy independently", async () => {
  const f = fixture();
  assert.equal(
    (await f.client.inspectGroup(f.policy.workflowRefs)).stage,
    "restricted_group_absent",
  );
  f.routes[
    "/orgs/CityGo-Tech/actions/runner-groups?per_page=100&page=1"
  ].runner_groups = [{ id: 9, name: "CityGo-isolated-checks" }];
  assert.equal(
    (await f.client.inspectGroup(f.policy.workflowRefs))
      .restrictedGroupVerified,
    true,
  );
  f.routes[
    "/orgs/CityGo-Tech/actions/runner-groups/9"
  ].restricted_to_workflows = false;
  await assert.rejects(
    f.client.inspectGroup(f.policy.workflowRefs),
    /readback_invalid/,
  );
  assert.equal(
    f.calls.filter(
      (x) => x.options.method === "POST" && !x.path.endsWith("/access_tokens"),
    ).length,
    0,
  );
});

test("probe CLI default plan does not read input; refusals cannot print private config or native errors", async () => {
  const output = [];
  const never = {
    [Symbol.asyncIterator]() {
      throw Error("must not read stdin in plan");
    },
  };
  assert.equal(await probeMain([], never, (x) => output.push(x)), 0);
  assert.equal(await probeMain(["--unknown"], never, (x) => output.push(x)), 2);
  assert.equal(
    await probeMain(
      [
        "--prepare-group",
        "--acknowledge",
        "CREATE_CITYGO_ISOLATED_GROUP:CityGo-Tech/citygo-platform:PR99",
      ],
      never,
      (x) => output.push(x),
    ),
    2,
  );
  async function* invalid() {
    yield JSON.stringify({ privateKeyPem: "NEVER_PRINT_PRIVATE" });
  }
  assert.equal(
    await probeMain(["--probe"], invalid(), (x) => output.push(x)),
    1,
  );
  async function* oversized() {
    yield "x".repeat(32769);
  }
  assert.equal(
    await probeMain(["--probe"], oversized(), (x) => output.push(x)),
    1,
  );
  assert.equal(JSON.stringify(output).includes("NEVER_PRINT"), false);
  const done = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../deploy/ci/probe-runner-app.mjs", import.meta.url),
      ),
      "--plan",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).stage, "plan_only_unverified");
});

test("installation token is narrowed to one private repo and exact permissions, management credential never returned", async () => {
  const f = fixture(),
    result = await f.client.group(f.policy);
  assert.deepEqual(result.repositoryIds, [123]);
  const issuance = f.calls.find((x) => x.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(issuance.options.body), {
    repository_ids: [123],
    permissions: APP_PERMISSIONS,
  });
  assert.equal(
    issuance.options.headers.Authorization.split(" ")[1].split(".").length,
    3,
  );
  const groupGet = f.calls.find((x) => x.path.endsWith("/runner-groups/9"));
  assert.match(groupGet.options.headers.Authorization, /^Bearer ghs_/);
  assert.equal(JSON.stringify(result).includes("ghs_"), false);
  assert.equal(Object.hasOwn(f.client, "token"), false);
  await f.client.group(f.policy);
  assert.equal(
    f.calls.filter((x) => x.path.endsWith("/access_tokens")).length,
    1,
  );
  f.client.clearCachedToken();
  await f.client.group(f.policy);
  assert.equal(
    f.calls.filter((x) => x.path.endsWith("/access_tokens")).length,
    2,
  );
});

const scopeFaults = {
  "foreign org": (r) => {
    r["/app/installations/11"].account.login = "other";
  },
  "personal install": (r) => {
    r["/app/installations/11"].account.type = "User";
  },
  "all repositories install": (r) => {
    r["/app/installations/11"].repository_selection = "all";
  },
  "suspended install": (r) => {
    r["/app/installations/11"].suspended_at = "2026-10-19";
  },
  "extra admin permission": (r) => {
    r["/app/installations/11"].permissions.administration = "write";
  },
  "Actions write": (r) => {
    r["/app/installations/11"].permissions.actions = "write";
  },
  "missing runner permission": (r) => {
    delete r["/app/installations/11"].permissions
      .organization_self_hosted_runners;
  },
  "extra token repository": (r) => {
    r["/app/installations/11/access_tokens"].repositories.push({ id: 124 });
  },
  "wrong token repository": (r) => {
    r["/app/installations/11/access_tokens"].repositories[0].id = 124;
  },
  "public token repository": (r) => {
    r["/app/installations/11/access_tokens"].repositories[0].private = false;
  },
  "old token": (r) => {
    r["/app/installations/11/access_tokens"].expires_at =
      "2026-10-19T11:00:00Z";
  },
  "unbounded token lifetime": (r) => {
    r["/app/installations/11/access_tokens"].expires_at =
      "2026-10-20T12:00:00Z";
  },
  "header injection token": (r) => {
    r["/app/installations/11/access_tokens"].token = "SECRET\nINJECT";
  },
  "broader token permissions": (r) => {
    r["/app/installations/11/access_tokens"].permissions.packages = "write";
  },
};
for (const [name, mutate] of Object.entries(scopeFaults))
  test(`reject ${name} before runner management`, async () => {
    const f = fixture();
    mutate(f.routes);
    await assert.rejects(f.client.group(f.policy), /^Error: ci_factory_app_/);
    assert.equal(
      f.calls.some((x) => x.path.includes("runner-groups")),
      false,
    );
  });

test("JIT names exact group/job/operation, returns only one-agent bootstrap, never org registration token", async () => {
  const f = fixture();
  const result = await f.client.generateJit(f.plan, f.policy);
  assert.equal(result.runnerId, 77);
  const post = f.calls.at(-1);
  assert.equal(
    post.path,
    "/orgs/CityGo-Tech/actions/runners/generate-jitconfig",
  );
  assert.deepEqual(JSON.parse(post.options.body), {
    name: "citygo-ci-job-" + f.plan.operationId,
    runner_group_id: 9,
    labels: [f.plan.label],
    work_folder: "_work",
  });
  assert.equal(
    f.calls.some((x) => x.path.includes("registration-token")),
    false,
  );
  const length = f.calls.length;
  await assert.rejects(
    f.client.generateJit(f.plan, f.policy),
    /attempt_exists/,
  );
  assert.equal(f.calls.length, length);
});

test("JIT refuses expired/future lease or workflow outside independently verified group", async () => {
  for (const delta of [-1, (600 + 3600) * 1000]) {
    const f = fixture();
    f.setTime(timestamp + delta);
    await assert.rejects(
      f.client.generateJit(f.plan, f.policy),
      /lease_expired/,
    );
    assert.equal(
      f.calls.some((x) => x.path.endsWith("/generate-jitconfig")),
      false,
    );
  }
  const f = fixture();
  f.policy.workflowRefs = ["ci.yml", "container-smoke.yml"].map(
    (file) =>
      "CityGo-Tech/citygo-platform/.github/workflows/" +
      file +
      "@refs/heads/main",
  );
  await assert.rejects(
    f.client.generateJit(f.plan, f.policy),
    /attempt_exists/,
  );
  assert.equal(f.calls.length, 0);
});

test("main-only JIT requires push/main, not a PR or another branch with same SHA", async () => {
  for (const fault of ["event", "head_branch"]) {
    const f = fixture(true);
    f.routes["/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1"][
      fault
    ] = fault === "event" ? "pull_request" : "another";
    await assert.rejects(f.client.generateJit(f.plan, f.policy), /run_changed/);
    assert.equal(
      f.calls.some((x) => x.path.endsWith("/generate-jitconfig")),
      false,
    );
  }
  const f = fixture(true);
  assert.equal((await f.client.generateJit(f.plan, f.policy)).runnerId, 77);
});

test("unexpected JIT output cannot escape as an accepted runner or leak a raw response", async () => {
  for (const mutate of [
    (x) => {
      x.runner.name = "another";
    },
    (x) => {
      x.runner.busy = true;
    },
    (x) => {
      x.runner.status = "online";
    },
    (x) => {
      x.runner.labels.push({ name: "other", type: "custom" });
    },
    (x) => {
      x.encoded_jit_config = "SECRET_NOT_BASE64";
    },
  ]) {
    const f = fixture();
    mutate(f.routes["/orgs/CityGo-Tech/actions/runners/generate-jitconfig"]);
    await assert.rejects(
      f.client.generateJit(f.plan, f.policy),
      /^Error: ci_factory_app_jit_readback_invalid$/,
    );
    await assert.rejects(
      f.client.generateJit(f.plan, f.policy),
      /attempt_exists/,
    );
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/generate-jitconfig")).length,
      1,
    );
  }
});

const admissionFaults = {
  "default group": (r) => {
    r["/orgs/CityGo-Tech/actions/runner-groups/9"].default = true;
  },
  "all workflows group": (r) => {
    r["/orgs/CityGo-Tech/actions/runner-groups/9"].restricted_to_workflows =
      false;
  },
  "wrong workflow ref": (r) => {
    r["/orgs/CityGo-Tech/actions/runner-groups/9"].selected_workflows = [
      "other",
    ];
  },
  "public group": (r) => {
    r["/orgs/CityGo-Tech/actions/runner-groups/9"].allows_public_repositories =
      true;
  },
  "extra group repository": (r) => {
    r[
      "/orgs/CityGo-Tech/actions/runner-groups/9/repositories?per_page=100&page=1"
    ].total_count = 2;
  },
  "old run attempt": (r) => {
    r[
      "/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1"
    ].run_attempt = 2;
  },
  "wrong workflow": (r) => {
    r["/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1"].path =
      ".github/workflows/deploy-main.yml";
  },
  fork: (r) => {
    r[
      "/repos/CityGo-Tech/citygo-platform/actions/runs/500/attempts/1"
    ].head_repository = { id: 124 };
  },
  "job already running": (r) => {
    r["/repos/CityGo-Tech/citygo-platform/actions/jobs/600"].status =
      "in_progress";
  },
  "extra job label": (r) => {
    r["/repos/CityGo-Tech/citygo-platform/actions/jobs/600"].labels.push(
      "other",
    );
  },
  "wrong job SHA": (r) => {
    r["/repos/CityGo-Tech/citygo-platform/actions/jobs/600"].head_sha =
      "d".repeat(40);
  },
};
for (const [name, mutate] of Object.entries(admissionFaults))
  test(`JIT refused for ${name}, no POST to runner API`, async () => {
    const f = fixture();
    mutate(f.routes);
    await assert.rejects(
      f.client.generateJit(f.plan, f.policy),
      /^Error: ci_factory_app_/,
    );
    assert.equal(
      f.calls.some((x) => x.path.includes("generate-jitconfig")),
      false,
    );
  });

test("HTTP/network/oversize refusal is sanitized and is never retried after ambiguous JIT POST", async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    let calls = 0;
    const client = createRunnerAppClient(
      config(),
      async () => {
        calls++;
        return new Response("RAW_SECRET_RESPONSE", { status });
      },
      () => timestamp,
    );
    const f = fixture();
    await assert.rejects(
      client.group(f.policy),
      (error) =>
        error.message === "ci_factory_app_request_refused" &&
        error.httpStatus === status &&
        error.operation === "read_installation" &&
        !JSON.stringify(error).includes("SECRET"),
    );
    assert.equal(calls, 1);
  }
  const f = fixture();
  let requests = 0;
  const client = createRunnerAppClient(
    config(),
    async () => {
      requests++;
      throw Error("ghs_SECRET_NATIVE_STACK");
    },
    () => timestamp,
  );
  await assert.rejects(
    client.generateJit(f.plan, f.policy),
    /^Error: ci_factory_app_request_refused$/,
  );
  await assert.rejects(client.generateJit(f.plan, f.policy), /attempt_exists/);
  assert.equal(requests, 1);
  const large = createRunnerAppClient(
    config(),
    async () => new Response("x".repeat(1048577)),
    () => timestamp,
  );
  await assert.rejects(
    large.group(f.policy),
    /^Error: ci_factory_app_request_refused$/,
  );
});

test("clock rollback refuses cached credentials and client has no env/FS/GCM/logger dependency", async () => {
  const f = fixture();
  await f.client.group(f.policy);
  const before = f.calls.length;
  f.setTime(timestamp - 1);
  await assert.rejects(f.client.group(f.policy), /clock_invalid/);
  assert.equal(f.calls.length, before);
  const source = readFileSync(
    new URL("../deploy/ci/github-runner-app.mjs", import.meta.url),
    "utf8",
  );
  for (const expression of [
    /process\.env/,
    /console\./,
    /node:fs/,
    /node:child_process/,
    /credential fill/,
    /registration-token/,
  ])
    assert.equal(expression.test(source), false);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /AbortSignal\.timeout\(20000\)/);
});
