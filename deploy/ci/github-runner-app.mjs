// Trusted Windows HOST only, imported from the installed, pinned CI bundle.
// No filesystem/env/credential discovery. Key is supplied by the protected host
// loader, never a PR checkout. No caller-supplied URL or generic write endpoint.
import { createPrivateKey, sign } from "node:crypto";
import {
  requireCi,
  validateJobPlan,
  REPOSITORY,
} from "./runner-job-policy.mjs";

export const APP_PERMISSIONS = Object.freeze({
  actions: "read",
  contents: "read",
  metadata: "read",
  organization_self_hosted_runners: "write",
});
const API = "https://api.github.com";
const ORG = "/orgs/CityGo-Tech/actions/";
const REPO = "/repos/" + REPOSITORY;
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const equal = (a, b) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) ===
  JSON.stringify(Object.entries(b ?? {}).sort());
const strings = (a, b) =>
  Array.isArray(a) &&
  a.every((x) => typeof x === "string") &&
  a.length === new Set(a).size &&
  [...a].sort().join("\n") === [...b].sort().join("\n");
function workflowRefs(refs) {
  requireCi(
    Array.isArray(refs) &&
      refs.length >= 2 &&
      refs.length <= 8 &&
      strings(refs, refs) &&
      refs.every((ref) =>
        /^CityGo-Tech\/citygo-platform\/\.github\/workflows\/(?:ci|container-smoke)\.yml@refs\/(?:heads\/main|pull\/[1-9][0-9]*\/merge)$/.test(
          ref,
        ),
      ),
    "app_group_creation_refused",
  );
  for (const name of ["ci.yml", "container-smoke.yml"])
    requireCi(
      refs.some((ref) =>
        ref.startsWith(REPOSITORY + "/.github/workflows/" + name + "@"),
      ),
      "app_group_creation_refused",
    );
}
function pemKey(pem) {
  requireCi(
    typeof pem === "string" &&
      pem.length >= 500 &&
      pem.length <= 16384 &&
      /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n/.test(pem),
    "app_key_invalid",
  );
  try {
    const key = createPrivateKey(pem);
    requireCi(
      key.asymmetricKeyType === "rsa" &&
        key.asymmetricKeyDetails.modulusLength >= 2048,
      "app_key_invalid",
    );
    return key;
  } catch {
    throw new Error("ci_factory_app_key_invalid");
  }
}
export function appJwt(clientId, key, now) {
  requireCi(
    typeof clientId === "string" &&
      /^[A-Za-z0-9_-]{10,64}$/.test(clientId) &&
      Number.isSafeInteger(now) &&
      now > 0 &&
      key?.asymmetricKeyType === "rsa" &&
      key.type === "private" &&
      key.asymmetricKeyDetails.modulusLength >= 2048,
    "app_jwt_invalid",
  );
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  // GitHub recommends a small past iat; at most 10 minutes total claim span.
  const claims = Buffer.from(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: clientId }),
  ).toString("base64url");
  const message = header + "." + claims;
  return (
    message +
    "." +
    sign("RSA-SHA256", Buffer.from(message), key).toString("base64url")
  );
}

async function boundedJson(response) {
  requireCi(
    response.body && typeof response.body.getReader === "function",
    "app_response_missing",
  );
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCi(size <= 1048576, "app_response_bounds");
      chunks.push(value);
    }
    requireCi(size > 1, "app_response_bounds");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createRunnerAppClient(
  config,
  transport = globalThis.fetch,
  clock = Date.now,
) {
  requireCi(
    config &&
      Object.keys(config).sort().join("|") ===
        "clientId|installationId|privateKeyPem|repositoryId" &&
      positive(config.installationId) &&
      positive(config.repositoryId) &&
      typeof transport === "function" &&
      typeof clock === "function",
    "app_config_invalid",
  );
  // Do not retain the PEM/config object in the returned facade.
  const { clientId, installationId, repositoryId } = config;
  const key = pemKey(config.privateKeyPem);
  config = null;
  let token = null,
    expires = 0,
    previousTime = 0;
  const attempted = new Set();
  let groupCreationAttempted = false;
  function now() {
    const ms = clock();
    requireCi(
      Number.isSafeInteger(ms) && ms >= previousTime,
      "app_clock_invalid",
    );
    previousTime = ms;
    return ms;
  }
  async function request(method, path, credential, body, status) {
    // All paths are generated below from fixed literals and checked integers.
    // There is no exposed generic request method or arbitrary callback URL.
    let httpStatus = null;
    let reason = "unspecified";
    try {
      const response = await transport(API + path, {
        method,
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(20000),
        headers: {
          Authorization: "Bearer " + credential,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CityGo-isolated-CI-App",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status <= 599
      )
        httpStatus = response.status;
      if (response.status !== status) {
        const refusal = await boundedJson(response).catch(() => null);
        const message =
          typeof refusal?.message === "string"
            ? refusal.message.slice(0, 2048)
            : "";
        // Only a finite local classification, never the server's raw text/body.
        if (
          /workflow.*(?:ref|format|invalid|qualified|branch)|(?:invalid|unknown).*workflow/i.test(
            message,
          )
        )
          reason = "workflow_ref_rejected";
        else if (
          /runner groups?.*(?:available|support)|(?:enterprise|plan).*(?:required|available|support)/i.test(
            message,
          )
        )
          reason = "group_feature_unavailable";
        else if (/resource not accessible|permission/i.test(message))
          reason = "scope_denied";
        else if (/repositor/i.test(message)) reason = "repository_rejected";
      }
      requireCi(response.status === status, "app_http_refused");
      return await boundedJson(response);
    } catch {
      // No response body, URL with secrets, PEM, JWT/token, stack or native text.
      // In particular never retry an ambiguous JIT POST after a network error.
      const error = new Error("ci_factory_app_request_refused");
      error.httpStatus = httpStatus;
      error.reason = reason;
      error.operation =
        path === ORG + "runner-groups"
          ? "create_group"
          : path.startsWith(ORG + "runner-groups")
            ? "read_group"
            : path.endsWith("/access_tokens")
              ? "installation_token"
              : path.startsWith("/app/installations/")
                ? "read_installation"
                : path.endsWith("/generate-jitconfig")
                  ? "generate_jit"
                  : "read_job";
      throw error;
    }
  }
  async function authenticate() {
    const ms = now();
    if (token && ms < expires - 60000) return token;
    token = null;
    expires = 0;
    const jwt = appJwt(clientId, key, ms);
    const installation = await request(
      "GET",
      "/app/installations/" + installationId,
      jwt,
      null,
      200,
    );
    requireCi(
      installation.id === installationId &&
        installation.account?.login === "CityGo-Tech" &&
        installation.account?.type === "Organization" &&
        installation.repository_selection === "selected" &&
        installation.suspended_at === null &&
        equal(installation.permissions, APP_PERMISSIONS),
      "app_installation_scope_invalid",
    );
    const value = await request(
      "POST",
      "/app/installations/" + installationId + "/access_tokens",
      jwt,
      { repository_ids: [repositoryId], permissions: APP_PERMISSIONS },
      201,
    );
    const expiry = Date.parse(value.expires_at);
    requireCi(
      typeof value.token === "string" &&
        /^[A-Za-z0-9_.-]{20,1024}$/.test(value.token) &&
        Number.isFinite(expiry) &&
        expiry - ms >= 120000 &&
        expiry - ms <= 3660000 &&
        value.repository_selection === "selected" &&
        equal(value.permissions, APP_PERMISSIONS) &&
        Array.isArray(value.repositories) &&
        value.repositories.length === 1 &&
        value.repositories[0].id === repositoryId &&
        value.repositories[0].full_name === REPOSITORY &&
        value.repositories[0].private === true,
      "app_token_scope_invalid",
    );
    token = value.token;
    expires = expiry;
    return token;
  }
  async function get(path) {
    return request("GET", path, await authenticate(), null, 200);
  }
  async function group(policy) {
    requireCi(
      policy &&
        positive(policy.runnerGroupId) &&
        policy.repositoryId === repositoryId &&
        policy.runnerGroupName === "CityGo-isolated-checks" &&
        Array.isArray(policy.workflowRefs) &&
        policy.workflowRefs.length >= 2 &&
        policy.workflowRefs.length <= 8,
      "app_group_policy_invalid",
    );
    workflowRefs(policy.workflowRefs);
    const value = await get(ORG + "runner-groups/" + policy.runnerGroupId);
    requireCi(
      value.id === policy.runnerGroupId &&
        value.name === policy.runnerGroupName &&
        value.default === false &&
        value.inherited === false &&
        value.visibility === "selected" &&
        value.allows_public_repositories === false &&
        value.restricted_to_workflows === true &&
        strings(value.selected_workflows, policy.workflowRefs),
      "app_group_readback_invalid",
    );
    const repos = await get(
      ORG +
        "runner-groups/" +
        policy.runnerGroupId +
        "/repositories?per_page=100&page=1",
    );
    requireCi(
      repos.total_count === 1 &&
        Array.isArray(repos.repositories) &&
        repos.repositories.length === 1 &&
        repos.repositories[0].id === repositoryId &&
        repos.repositories[0].full_name === REPOSITORY &&
        repos.repositories[0].private === true,
      "app_group_repositories_invalid",
    );
    return {
      id: value.id,
      name: value.name,
      visibility: "selected",
      repositoryIds: [repositoryId],
      allowsPublicRepositories: false,
      restrictedToWorkflows: true,
      workflowRefs: [...policy.workflowRefs],
    };
  }
  function livePlan(plan) {
    const ms = now();
    requireCi(
      ms >= Date.parse(plan.createdAt) &&
        ms < Date.parse(plan.hardDeadline) - plan.cleanupSeconds * 1000,
      "app_lease_expired",
    );
  }
  async function queued(plan) {
    validateJobPlan(plan);
    requireCi(plan.repositoryId === repositoryId, "app_repository_mismatch");
    livePlan(plan);
    const run = await get(
      REPO + "/actions/runs/" + plan.runId + "/attempts/" + plan.runAttempt,
    );
    requireCi(
      run.id === plan.runId &&
        run.run_attempt === plan.runAttempt &&
        run.workflow_id === plan.workflowId &&
        run.path === plan.workflowPath &&
        run.head_sha === plan.headSha &&
        run.repository?.id === repositoryId &&
        run.head_repository?.id === repositoryId &&
        (plan.workflowRef.endsWith("@refs/heads/main")
          ? run.event === "push" && run.head_branch === "main"
          : /@refs\/pull\/[1-9][0-9]*\/merge$/.test(plan.workflowRef) &&
            run.event === "pull_request") &&
        ["queued", "in_progress"].includes(run.status) &&
        run.conclusion === null,
      "app_run_changed",
    );
    const job = await get(REPO + "/actions/jobs/" + plan.jobId);
    requireCi(
      job.id === plan.jobId &&
        job.run_id === plan.runId &&
        job.run_attempt === plan.runAttempt &&
        job.head_sha === plan.headSha &&
        job.name === plan.jobName &&
        job.status === "queued" &&
        job.conclusion === null &&
        (job.runner_id === 0 || job.runner_id === null) &&
        strings(job.labels, [plan.label]),
      "app_job_changed",
    );
    return true;
  }
  return Object.freeze({
    async inspectGroup(refs) {
      workflowRefs(refs);
      const value = await get(ORG + "runner-groups?per_page=100&page=1");
      requireCi(
        Number.isSafeInteger(value.total_count) &&
          value.total_count >= 0 &&
          value.total_count <= 100 &&
          Array.isArray(value.runner_groups) &&
          value.runner_groups.length === value.total_count,
        "app_groups_unbounded",
      );
      const matches = value.runner_groups.filter(
        (x) => x.name === "CityGo-isolated-checks",
      );
      requireCi(matches.length <= 1, "app_group_readback_invalid");
      let observed = null;
      if (matches.length)
        observed = await group({
          runnerGroupId: matches[0].id,
          runnerGroupName: "CityGo-isolated-checks",
          repositoryId,
          workflowRefs: refs,
        });
      return {
        version: 1,
        stage: observed
          ? "restricted_group_verified"
          : "restricted_group_absent",
        organization: "CityGo-Tech",
        repository: REPOSITORY,
        restrictedGroupVerified: observed !== null,
        runnerGroupId: observed?.id ?? null,
        runnerGroupCount: value.total_count,
        runnerRegistered: false,
        vmCreated: false,
        productionChanged: false,
      };
    },
    async prepareGroup(refs) {
      workflowRefs(refs);
      requireCi(
        !groupCreationAttempted &&
          strings(
            refs,
            ["ci.yml", "container-smoke.yml"].map(
              (file) =>
                REPOSITORY + "/.github/workflows/" + file + "@refs/heads/main",
            ),
          ),
        "app_group_creation_refused",
      );
      groupCreationAttempted = true;
      const groups = await get(ORG + "runner-groups?per_page=100&page=1");
      requireCi(
        Number.isSafeInteger(groups.total_count) &&
          groups.total_count >= 0 &&
          groups.total_count < 100 &&
          Array.isArray(groups.runner_groups) &&
          groups.runner_groups.length === groups.total_count &&
          !groups.runner_groups.some(
            (x) => x.name === "CityGo-isolated-checks",
          ),
        "app_group_already_exists_or_unbounded",
      );
      const created = await request(
        "POST",
        ORG + "runner-groups",
        await authenticate(),
        {
          name: "CityGo-isolated-checks",
          visibility: "selected",
          selected_repository_ids: [repositoryId],
          allows_public_repositories: false,
          restricted_to_workflows: true,
          selected_workflows: refs,
        },
        201,
      );
      requireCi(
        positive(created.id) &&
          created.default === false &&
          created.name === "CityGo-isolated-checks",
        "app_group_creation_readback_invalid",
      );
      const observed = await group({
        runnerGroupId: created.id,
        runnerGroupName: "CityGo-isolated-checks",
        repositoryId,
        workflowRefs: refs,
      });
      return {
        version: 1,
        stage: "restricted_group_created",
        organization: "CityGo-Tech",
        repository: REPOSITORY,
        runnerGroupId: observed.id,
        selectedWorkflowCount: observed.workflowRefs.length,
        restrictedGroupVerified: true,
        runnerRegistered: false,
        vmCreated: false,
        productionChanged: false,
      };
    },
    async inspect() {
      const value = await get(ORG + "runner-groups?per_page=100&page=1");
      requireCi(
        Number.isSafeInteger(value.total_count) &&
          value.total_count >= 0 &&
          value.total_count <= 100 &&
          Array.isArray(value.runner_groups) &&
          value.runner_groups.length === value.total_count,
        "app_groups_unbounded",
      );
      return {
        version: 1,
        stage: "app_access_verified",
        organization: "CityGo-Tech",
        repository: REPOSITORY,
        installationScopeVerified: true,
        runnerGroupsReadable: true,
        runnerGroupCount: value.total_count,
        runnerRegistered: false,
        vmCreated: false,
        productionChanged: false,
      };
    },
    group,
    queued,
    async generateJit(plan, policy) {
      validateJobPlan(plan);
      requireCi(
        plan.runnerGroupId === policy.runnerGroupId &&
          policy.workflowRefs.includes(plan.workflowRef) &&
          !attempted.has(plan.operationId),
        "app_jit_attempt_exists",
      );
      // Caller must have flushed registration intent in the external journal.
      // This additional in-process fence is NOT a substitute for that journal.
      attempted.add(plan.operationId);
      livePlan(plan);
      await group(policy);
      await queued(plan);
      const result = await request(
        "POST",
        ORG + "runners/generate-jitconfig",
        await authenticate(),
        {
          name: "citygo-ci-job-" + plan.operationId,
          runner_group_id: policy.runnerGroupId,
          labels: [plan.label],
          work_folder: "_work",
        },
        201,
      );
      requireCi(
        positive(result.runner?.id) &&
          result.runner.name === "citygo-ci-job-" + plan.operationId &&
          result.runner.busy === false &&
          result.runner.status === "offline" &&
          Array.isArray(result.runner.labels) &&
          result.runner.labels.filter((x) => x.type === "custom").length ===
            1 &&
          result.runner.labels.some(
            (x) => x.type === "custom" && x.name === plan.label,
          ) &&
          result.runner.labels.every(
            (x) =>
              x.type === "custom" ||
              (x.type === "read-only" &&
                ["self-hosted", "Linux", "X64"].includes(x.name)),
          ) &&
          typeof result.encoded_jit_config === "string" &&
          result.encoded_jit_config.length >= 64 &&
          result.encoded_jit_config.length <= 131072 &&
          Buffer.from(result.encoded_jit_config, "base64").toString(
            "base64",
          ) === result.encoded_jit_config,
        "app_jit_readback_invalid",
      );
      // Secret-bearing result is returned ONLY to the protected native adapter.
      // It must not be logged or placed in seed/source/artifact/journal.
      return {
        runnerId: result.runner.id,
        runnerName: result.runner.name,
        encodedJitConfig: result.encoded_jit_config,
      };
    },
    clearCachedToken() {
      token = null;
      expires = 0;
    },
  });
}
