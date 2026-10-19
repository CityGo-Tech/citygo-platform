// Public-only full-job gateway seed. No credentials, IO or implicit activation.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { validateJobPlan } from "./runner-job-policy.mjs";
import { renderPrivateGatewaySeed } from "./render-private-gateway-seed.mjs";

export const JOB_GATEWAY_PINS = Object.freeze({
  initializerSourceLF:
    "bf6546ca7ee07f91939f5d9bdf06b450208a4a22a9d80d58f08b9b93cf98b417",
  gatewaySourceLF:
    "364ed2c72033e5536222db6b18ab27deb4f0366a9a0b1b21e81b6439d1ce3772",
  leaseSourceLF:
    "5e410154ff5eec081b07f22c5288e5299a4ea5756ec02711409f741455cbbdd0",
});
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const script = "/usr/local/sbin/citygo-job-gateway.py";
function require(value, code) {
  if (!value) throw new Error("ci_job_gateway_seed_" + code);
}
export function renderJobGatewaySeed(input) {
  const fields = [
    "configJson",
    "jobPlanJson",
    ...Object.keys(JOB_GATEWAY_PINS),
    "policySourceLF",
    "offlineHelperSourceLF",
    "witnessSourceLF",
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
  for (const [key, pin] of Object.entries(JOB_GATEWAY_PINS)) {
    const raw = data[key];
    require(raw.startsWith("#!/usr/bin/python3\n") &&
      raw.endsWith("\n") &&
      raw.length <= 131072 &&
      !/[^\x20-\x7e]/.test(raw.replaceAll("\n", "").replaceAll("\t", "")) &&
      hash(raw) === pin, "source_pin");
  }
  require(data.jobPlanJson.length <= 16384 &&
    !/[^\x20-\x7e\n]/.test(data.jobPlanJson), "plan_bytes");
  let plan;
  try {
    plan = JSON.parse(data.jobPlanJson);
  } catch {
    throw new Error("ci_job_gateway_seed_plan_json");
  }
  require(data.jobPlanJson === JSON.stringify(plan) ||
    data.jobPlanJson === JSON.stringify(plan) + "\n", "plan_canonical");
  validateJobPlan(plan);
  const seed = renderPrivateGatewaySeed({
    configJson: data.configJson,
    initializerSourceLF: data.initializerSourceLF,
    expectedInitializerSha256: JOB_GATEWAY_PINS.initializerSourceLF,
    policySourceLF: data.policySourceLF,
    offlineHelperSourceLF: data.offlineHelperSourceLF,
    witnessSourceLF: data.witnessSourceLF,
    observationMode: "runner-canary",
  });
  const config = JSON.parse(data.configJson);
  require(config.operationId === plan.gatewayOperationId, "gateway_operation");
  const payload = JSON.parse(seed.userData.slice("#cloud-config\n".length));
  const sha = hash(data.jobPlanJson);
  for (const [path, permissions, raw] of [
    [script, "0700", data.gatewaySourceLF],
    ["/usr/local/lib/citygo-ci/job-lease.py", "0600", data.leaseSourceLF],
    ["/var/lib/citygo-ci-gateway/job-plan.json", "0600", data.jobPlanJson],
  ])
    payload.write_files.push({
      path,
      owner: "root:root",
      permissions,
      encoding: "b64",
      content: Buffer.from(raw, "ascii").toString("base64"),
    });
  payload.runcmd = [
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      script,
      "--apply",
      "--operation-id",
      plan.gatewayOperationId,
      "--expected-job-plan-sha256",
      sha,
      "--acknowledge",
      `RUN_JOB_GATEWAY:${plan.gatewayOperationId}:${sha}`,
    ],
  ];
  const userData = "#cloud-config\n" + JSON.stringify(payload) + "\n";
  require(userData.length <= 230000, "size");
  return { ...seed, userData, jobPlanSha256: sha };
}
