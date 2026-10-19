// Secret-bearing operation-local KVP fragments. Protected host adapter ONLY.
// Never log/serialize this return value to journals, files, artifacts or argv.
import { createHash } from "node:crypto";
import { validateJobPlan, requireCi } from "./runner-job-policy.mjs";

export function fragmentJobJit(plan, jobPlanSha256, jit, now) {
  validateJobPlan(plan);
  const ms = Date.parse(now);
  requireCi(
    typeof now === "string" &&
      Number.isFinite(ms) &&
      new Date(ms).toISOString() === now &&
      ms >= Date.parse(plan.createdAt) &&
      ms + 120000 < Date.parse(plan.hardDeadline) - 180000,
    "jit_transport_time",
  );
  requireCi(
    typeof jobPlanSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(jobPlanSha256) &&
      jit &&
      Number.isSafeInteger(jit.runnerId) &&
      jit.runnerId > 0 &&
      jit.runnerName === "citygo-ci-job-" + plan.operationId &&
      typeof jit.encodedJitConfig === "string" &&
      jit.encodedJitConfig.length >= 64 &&
      jit.encodedJitConfig.length <= 131072 &&
      Buffer.from(jit.encodedJitConfig, "base64").toString("base64") ===
        jit.encodedJitConfig,
    "jit_transport_binding",
  );
  const prefix = "CityGoJobJit-" + plan.operationId + "-";
  const chunks = jit.encodedJitConfig.match(/.{1,900}/g);
  const records = chunks.map((value, index) => ({
    name: prefix + String(index).padStart(3, "0"),
    value,
  }));
  records.push({
    name: prefix + "meta",
    value: JSON.stringify({
      operationId: plan.operationId,
      jobPlanSha256,
      runnerId: jit.runnerId,
      runnerGroupId: plan.runnerGroupId,
      sha256: createHash("sha256").update(jit.encodedJitConfig).digest("hex"),
      chunks: chunks.length,
      length: jit.encodedJitConfig.length,
      expiresAt: new Date(ms + 120000).toISOString(),
    }),
  });
  requireCi(
    records.length <= 147 &&
      records.every((record) => record.value.length <= 1022),
    "jit_transport_bounds",
  );
  return records;
}
