// Public-only NoCloud payload. Registration arrives later over exact host KVP.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { renderPrivateClientSeed } from "./render-private-gateway-seed.mjs";

const script = "/usr/local/sbin/citygo-ephemeral-runner-canary.py";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function renderEphemeralRunnerCanarySeed(input) {
  const fields = [
    "configJson",
    "clientSourceLF",
    "offlineHelperSourceLF",
    "runnerSourceLF",
    "expectedRunnerSha256",
  ];
  if (
    !input ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("runner_seed_input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    !fields.every(
      (key) =>
        descriptors[key]?.enumerable &&
        Object.hasOwn(descriptors[key], "value") &&
        typeof descriptors[key].value === "string",
    )
  )
    throw new Error("runner_seed_fields_invalid");
  const data = Object.fromEntries(
    fields.map((key) => [key, descriptors[key].value]),
  );
  if (
    !/^[a-f0-9]{64}$/.test(data.expectedRunnerSha256) ||
    hash(data.runnerSourceLF) !== data.expectedRunnerSha256 ||
    data.runnerSourceLF.length > 65536 ||
    !data.runnerSourceLF.startsWith("#!/usr/bin/python3\n") ||
    !data.runnerSourceLF.endsWith("\n") ||
    /[^\x20-\x7e]/.test(
      data.runnerSourceLF.replaceAll("\t", "").replaceAll("\n", ""),
    )
  )
    throw new Error("runner_seed_pin_invalid");
  const seed = renderPrivateClientSeed({
    configJson: data.configJson,
    clientSourceLF: data.clientSourceLF,
    offlineHelperSourceLF: data.offlineHelperSourceLF,
  });
  const config = JSON.parse(data.configJson);
  const records = JSON.parse(
    seed.userData.slice("#cloud-config\n".length),
  ).write_files;
  records[0].path = "/usr/local/lib/citygo-ci/private-network-canary.py";
  records[0].permissions = "0600";
  records[2].path = "/var/lib/citygo-ci-runner/config.json";
  records.unshift({
    path: script,
    owner: "root:root",
    permissions: "0700",
    encoding: "b64",
    content: Buffer.from(data.runnerSourceLF, "ascii").toString("base64"),
  });
  const userData = `#cloud-config\n${JSON.stringify({ write_files: records, runcmd: [["/usr/bin/python3", "-I", "-B", script, "--apply", "--operation-id", config.operationId, "--acknowledge", `RUN_EPHEMERAL_CANARY:${config.operationId}`]] })}\n`;
  if (userData.length > 190000) throw new Error("runner_seed_too_large");
  return {
    ...seed,
    userData,
    metaData:
      JSON.stringify({
        "instance-id": `citygo-runner-canary-${config.operationId}`,
        "local-hostname": `citygo-ci-canary-${config.operationId}`,
      }) + "\n",
    runnerSha256: data.expectedRunnerSha256,
  };
}
