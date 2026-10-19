// Trusted HOST policy only. Never import this module from a checked-out PR.
// Labels route a job; the independently read org group is the access boundary.
import { randomUUID } from "node:crypto";
import { types } from "node:util";

export const REPOSITORY = "CityGo-Tech/citygo-platform";
export const JOBS = Object.freeze({
  ".github/workflows/ci.yml": Object.freeze({
    workflow: "CI",
    job: "verify",
    suffix: "verify",
    seconds: 3600,
  }),
  ".github/workflows/container-smoke.yml": Object.freeze({
    workflow: "Container smoke",
    job: "production-images",
    suffix: "production-images",
    seconds: 2400,
  }),
});
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
export function requireCi(value, code) {
  if (!value) throw new Error("ci_factory_" + code);
}
function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function time(value) {
  requireCi(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    "time_invalid",
  );
  const ms = Date.parse(value);
  requireCi(
    Number.isFinite(ms) && new Date(ms).toISOString() === value,
    "time_invalid",
  );
  return ms;
}
function exact(value, fields) {
  requireCi(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !types.isProxy(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.keys(value).sort().join("|") === [...fields].sort().join("|"),
    "shape_invalid",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCi(
    Reflect.ownKeys(descriptors).length === fields.length &&
      fields.every(
        (key) =>
          descriptors[key]?.enumerable &&
          Object.hasOwn(descriptors[key], "value"),
      ),
    "shape_invalid",
  );
}
function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((x) => typeof x === "string") &&
    actual.length === new Set(actual).size &&
    [...actual].sort().join("\n") === [...expected].sort().join("\n")
  );
}

// Input is a reduced, credential-free projection of independent GitHub REST
// responses, not a webhook, guest report or a job-supplied JSON document.
export function admitQueuedJob(policy, snapshot, now, ids = randomUUID) {
  exact(policy, [
    "version",
    "repositoryId",
    "runnerGroupId",
    "runnerGroupName",
    "workflowRefs",
    "workflowSha256",
  ]);
  requireCi(
    policy.version === 1 &&
      integer(policy.repositoryId) &&
      integer(policy.runnerGroupId) &&
      policy.runnerGroupName === "CityGo-isolated-checks",
    "policy_invalid",
  );
  exact(policy.workflowSha256, Object.keys(JOBS));
  requireCi(
    Object.values(policy.workflowSha256).every(
      (x) => typeof x === "string" && hash.test(x),
    ),
    "workflow_pin_invalid",
  );
  requireCi(
    Array.isArray(policy.workflowRefs) &&
      policy.workflowRefs.length >= 2 &&
      policy.workflowRefs.length <= 8 &&
      sameStrings(policy.workflowRefs, policy.workflowRefs) &&
      policy.workflowRefs.every(
        (ref) =>
          typeof ref === "string" &&
          /^CityGo-Tech\/citygo-platform\/\.github\/workflows\/(?:ci|container-smoke)\.yml@(?:[a-f0-9]{40}|refs\/(?:heads\/(?:main|codex\/isolated-linux-runner)|pull\/[1-9][0-9]*\/merge))$/.test(
            ref,
          ),
      ),
    "workflow_refs_invalid",
  );
  for (const path of Object.keys(JOBS))
    requireCi(
      policy.workflowRefs.some((ref) =>
        ref.startsWith(REPOSITORY + "/" + path + "@"),
      ),
      "workflow_refs_incomplete",
    );
  exact(snapshot, [
    "observedAt",
    "repository",
    "run",
    "job",
    "source",
    "group",
  ]);
  const nowMs = time(now),
    observed = time(snapshot.observedAt);
  requireCi(observed <= nowMs && nowMs - observed <= 30000, "snapshot_stale");
  const { repository, run, job, source, group } = snapshot;
  exact(repository, ["id", "fullName", "private"]);
  requireCi(
    repository.id === policy.repositoryId &&
      repository.fullName === REPOSITORY &&
      repository.private === true,
    "repository_invalid",
  );
  exact(run, [
    "id",
    "attempt",
    "workflowId",
    "path",
    "name",
    "event",
    "headSha",
    "headBranch",
    "headRepositoryId",
    "status",
    "conclusion",
  ]);
  const spec = JOBS[run.path];
  requireCi(
    typeof run.path === "string" &&
      Object.hasOwn(JOBS, run.path) &&
      spec &&
      spec.workflow === run.name,
    "workflow_not_allowed",
  );
  requireCi(
    [run.id, run.attempt, run.workflowId].every(integer) &&
      typeof run.headSha === "string" &&
      sha.test(run.headSha) &&
      run.headRepositoryId === policy.repositoryId &&
      ["queued", "in_progress"].includes(run.status) &&
      run.conclusion === null,
    "run_invalid",
  );
  requireCi(
    (run.event === "push" && run.headBranch === "main") ||
      (run.event === "pull_request" &&
        typeof run.headBranch === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(run.headBranch)),
    "event_not_allowed",
  );
  exact(source, ["currentHeadSha", "workflowRef", "workflowSha256"]);
  requireCi(
    source.currentHeadSha === run.headSha &&
      typeof source.workflowRef === "string" &&
      policy.workflowRefs.includes(source.workflowRef) &&
      source.workflowRef.startsWith(REPOSITORY + "/" + run.path + "@") &&
      source.workflowSha256 === policy.workflowSha256[run.path],
    "source_changed",
  );
  if (run.event === "push")
    requireCi(
      source.workflowRef.endsWith("@refs/heads/main"),
      "push_ref_invalid",
    );
  if (run.event === "pull_request")
    requireCi(
      /@(?:refs\/pull\/[1-9][0-9]*\/merge|[a-f0-9]{40})$/.test(
        source.workflowRef,
      ),
      "pr_ref_invalid",
    );
  exact(job, [
    "id",
    "runId",
    "attempt",
    "name",
    "status",
    "conclusion",
    "runnerId",
    "labels",
  ]);
  const label = `citygo-ci-${run.id}-${run.attempt}-${spec.suffix}`;
  requireCi(
    integer(job.id) &&
      job.runId === run.id &&
      job.attempt === run.attempt &&
      job.name === spec.job &&
      job.status === "queued" &&
      job.conclusion === null &&
      job.runnerId === 0 &&
      sameStrings(job.labels, [label]),
    "job_not_queued_exactly",
  );
  exact(group, [
    "id",
    "name",
    "visibility",
    "repositoryIds",
    "allowsPublicRepositories",
    "restrictedToWorkflows",
    "workflowRefs",
  ]);
  requireCi(
    group.id === policy.runnerGroupId &&
      group.name === policy.runnerGroupName &&
      group.visibility === "selected" &&
      Array.isArray(group.repositoryIds) &&
      group.repositoryIds.length === 1 &&
      group.repositoryIds[0] === policy.repositoryId &&
      group.allowsPublicRepositories === false &&
      group.restrictedToWorkflows === true &&
      sameStrings(group.workflowRefs, policy.workflowRefs),
    "group_access_not_verified",
  );
  const operationId = ids(),
    gatewayOperationId = ids();
  requireCi(
    typeof operationId === "string" &&
      uuid.test(operationId) &&
      typeof gatewayOperationId === "string" &&
      uuid.test(gatewayOperationId) &&
      operationId !== gatewayOperationId,
    "operation_invalid",
  );
  // Single host slot. Absolute lease includes boot + job + cleanup and is never
  // renewed by guest heartbeats or a suspended/restarted host controller.
  return Object.freeze({
    version: 1,
    repositoryId: repository.id,
    runId: run.id,
    runAttempt: run.attempt,
    workflowId: run.workflowId,
    jobId: job.id,
    workflowPath: run.path,
    workflowRef: source.workflowRef,
    workflowSha256: source.workflowSha256,
    headSha: run.headSha,
    jobName: spec.job,
    label,
    runnerGroupId: group.id,
    operationId,
    gatewayOperationId,
    jobKey: `${run.workflowId}-${run.id}-${run.attempt}-${job.id}`,
    createdAt: now,
    hardDeadline: new Date(
      nowMs + (600 + spec.seconds + 180) * 1000,
    ).toISOString(),
    bootstrapSeconds: 600,
    jobSeconds: spec.seconds,
    cleanupSeconds: 180,
    guestVcpu: 4,
    guestMemoryGiB: 6,
    guestDiskGiB: 96,
  });
}

export function sameJobAdmission(original, fresh) {
  // A fresh read may shorten the lease, never move it into the future.
  for (const name of [
    "repositoryId",
    "runId",
    "runAttempt",
    "workflowId",
    "jobId",
    "workflowPath",
    "workflowRef",
    "workflowSha256",
    "headSha",
    "jobName",
    "label",
    "runnerGroupId",
  ])
    requireCi(original[name] === fresh[name], "admission_changed");
  return true;
}

export function validateJobPlan(plan) {
  exact(plan, [
    "version",
    "repositoryId",
    "runId",
    "runAttempt",
    "workflowId",
    "jobId",
    "workflowPath",
    "workflowRef",
    "workflowSha256",
    "headSha",
    "jobName",
    "label",
    "runnerGroupId",
    "operationId",
    "gatewayOperationId",
    "jobKey",
    "createdAt",
    "hardDeadline",
    "bootstrapSeconds",
    "jobSeconds",
    "cleanupSeconds",
    "guestVcpu",
    "guestMemoryGiB",
    "guestDiskGiB",
  ]);
  requireCi(
    plan &&
      Object.hasOwn(JOBS, plan.workflowPath) &&
      integer(plan.jobId) &&
      integer(plan.runId) &&
      integer(plan.runAttempt) &&
      integer(plan.workflowId) &&
      integer(plan.repositoryId) &&
      integer(plan.runnerGroupId),
    "plan_invalid",
  );
  const spec = JOBS[plan.workflowPath];
  requireCi(
    plan.version === 1 &&
      typeof plan.operationId === "string" &&
      uuid.test(plan.operationId) &&
      typeof plan.gatewayOperationId === "string" &&
      uuid.test(plan.gatewayOperationId) &&
      plan.operationId !== plan.gatewayOperationId &&
      typeof plan.workflowSha256 === "string" &&
      hash.test(plan.workflowSha256) &&
      typeof plan.headSha === "string" &&
      sha.test(plan.headSha) &&
      typeof plan.workflowRef === "string" &&
      plan.workflowRef.startsWith(REPOSITORY + "/" + plan.workflowPath + "@") &&
      /@(?:[a-f0-9]{40}|refs\/heads\/main|refs\/pull\/[1-9][0-9]*\/merge)$/.test(
        plan.workflowRef,
      ) &&
      plan.jobKey ===
        `${plan.workflowId}-${plan.runId}-${plan.runAttempt}-${plan.jobId}` &&
      plan.label ===
        `citygo-ci-${plan.runId}-${plan.runAttempt}-${spec.suffix}` &&
      plan.jobName === spec.job &&
      plan.jobSeconds === spec.seconds &&
      plan.bootstrapSeconds === 600 &&
      plan.cleanupSeconds === 180 &&
      plan.guestVcpu === 4 &&
      plan.guestMemoryGiB === 6 &&
      plan.guestDiskGiB === 96 &&
      time(plan.hardDeadline) - time(plan.createdAt) ===
        (600 + spec.seconds + 180) * 1000,
    "plan_invalid",
  );
  return plan;
}
