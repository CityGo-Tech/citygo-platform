// SYNTHETIC test fixture only; not a GitHub admission or runtime plan.
import { validateJobPlan } from "../deploy/ci/runner-job-policy.mjs";
export function fixtureJobPlan(kind = "ci") {
  return validateJobPlan({
    version: 1,
    repositoryId: 123,
    runId: 500,
    runAttempt: 1,
    workflowId: 400,
    jobId: 600,
    workflowPath: `.github/workflows/${kind === "ci" ? "ci" : "container-smoke"}.yml`,
    workflowRef: `CityGo-Tech/citygo-platform/.github/workflows/${kind === "ci" ? "ci" : "container-smoke"}.yml@${"a".repeat(40)}`,
    workflowSha256: "b".repeat(64),
    headSha: "a".repeat(40),
    jobName: kind === "ci" ? "verify" : "production-images",
    label: `citygo-ci-500-1-${kind === "ci" ? "verify" : "production-images"}`,
    runnerGroupId: 9,
    operationId: "12345678-1234-4234-8234-123456789abc",
    gatewayOperationId: "98765432-1234-4234-8234-123456789abc",
    jobKey: "400-500-1-600",
    createdAt: "2026-10-19T08:00:00.000Z",
    hardDeadline:
      kind === "ci" ? "2026-10-19T09:13:00.000Z" : "2026-10-19T08:53:00.000Z",
    bootstrapSeconds: 600,
    jobSeconds: kind === "ci" ? 3600 : 2400,
    cleanupSeconds: 180,
    guestVcpu: 4,
    guestMemoryGiB: 6,
    guestDiskGiB: 96,
  });
}
