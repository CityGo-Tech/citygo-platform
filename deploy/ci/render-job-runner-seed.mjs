// Public-only job payload. JIT/config/go arrive later over scoped host KVP.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { validateJobPlan } from "./runner-job-policy.mjs";
import { renderEphemeralRunnerCanarySeed } from "./render-ephemeral-runner-seed.mjs";

export const JOB_RUNNER_PINS = Object.freeze({
  runnerSourceLF:
    "149df29764e0a96776d491b055f2722459bc70234a507e17017ab066db72cc8c",
  canarySourceLF:
    "951198c8648128fc2a48ae4e7dd0bd374eda05449f1d9d346fcc441982cfbaeb",
  toolsSourceLF:
    "ec30af76c82b1350a909053d6a43dec21fec18ce3293792c967aa4873b182b57",
  leaseSourceLF:
    "5e410154ff5eec081b07f22c5288e5299a4ea5756ec02711409f741455cbbdd0",
  jitSourceLF:
    "55bdd58ea5b1216c190f9e85c7b1015f4dd8cc5dfa6d79999a50de6c652cbda4",
});
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const script = "/usr/local/sbin/citygo-job-runner.py";
function require(value, code) {
  if (!value) throw new Error("ci_job_runner_seed_" + code);
}
export function renderJobRunnerSeed(input) {
  const fields = [
    "configJson",
    "jobPlanJson",
    "clientSourceLF",
    "offlineHelperSourceLF",
    ...Object.keys(JOB_RUNNER_PINS),
  ];
  require(input &&
    !types.isProxy(input) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(input)), "input");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  require(Reflect.ownKeys(descriptors).length === fields.length &&
    fields.every(
      (key) =>
        descriptors[key]?.enumerable &&
        Object.hasOwn(descriptors[key], "value") &&
        typeof descriptors[key].value === "string",
    ), "fields");
  const data = Object.fromEntries(
    fields.map((key) => [key, descriptors[key].value]),
  );
  for (const [key, pin] of Object.entries(JOB_RUNNER_PINS))
    require(data[key].startsWith("#!/usr/bin/python3\n") &&
      data[key].endsWith("\n") &&
      data[key].length <= 131072 &&
      !/[^\x20-\x7e]/.test(
        data[key].replaceAll("\n", "").replaceAll("\t", ""),
      ) &&
      hash(data[key]) === pin, "source_pin");
  require(data.jobPlanJson.length <= 16384 &&
    !/[^\x20-\x7e\n]/.test(data.jobPlanJson), "plan_bytes");
  let plan;
  try {
    plan = JSON.parse(data.jobPlanJson);
  } catch {
    throw new Error("ci_job_runner_seed_plan_json");
  }
  require(data.jobPlanJson === JSON.stringify(plan) ||
    data.jobPlanJson === JSON.stringify(plan) + "\n", "plan_canonical");
  validateJobPlan(plan);
  const seed = renderEphemeralRunnerCanarySeed({
    configJson: data.configJson,
    clientSourceLF: data.clientSourceLF,
    offlineHelperSourceLF: data.offlineHelperSourceLF,
    runnerSourceLF: data.canarySourceLF,
    expectedRunnerSha256: JOB_RUNNER_PINS.canarySourceLF,
  });
  const config = JSON.parse(data.configJson);
  require(config.operationId === plan.operationId &&
    config.gatewayOperationId === plan.gatewayOperationId, "operation");
  const payload = JSON.parse(seed.userData.slice("#cloud-config\n".length));
  payload.write_files[0].path =
    "/usr/local/lib/citygo-ci/ephemeral-runner-canary.py";
  payload.write_files[0].permissions = "0600";
  payload.write_files.unshift({
    path: script,
    owner: "root:root",
    permissions: "0700",
    encoding: "b64",
    content: Buffer.from(data.runnerSourceLF, "ascii").toString("base64"),
  });
  for (const [path, raw] of [
    ["/usr/local/lib/citygo-ci/prepare-job-toolchain.py", data.toolsSourceLF],
    ["/usr/local/lib/citygo-ci/job-lease.py", data.leaseSourceLF],
    ["/usr/local/lib/citygo-ci/job-jit.py", data.jitSourceLF],
    ["/var/lib/citygo-ci-runner/job-plan.json", data.jobPlanJson],
  ])
    payload.write_files.push({
      path,
      owner: "root:root",
      permissions: "0600",
      encoding: "b64",
      content: Buffer.from(raw, "ascii").toString("base64"),
    });
  const sha = hash(data.jobPlanJson);
  payload.runcmd = [
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      script,
      "--apply",
      "--operation-id",
      plan.operationId,
      "--expected-job-plan-sha256",
      sha,
      "--acknowledge",
      `RUN_ONE_CI_JOB:${plan.operationId}:${sha}`,
    ],
  ];
  const userData = "#cloud-config\n" + JSON.stringify(payload) + "\n";
  require(userData.length <= 230000, "size");
  return {
    ...seed,
    userData,
    jobPlanSha256: sha,
    runnerSha256: JOB_RUNNER_PINS.runnerSourceLF,
  };
}
