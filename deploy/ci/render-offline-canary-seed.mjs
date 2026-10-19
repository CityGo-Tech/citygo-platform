// Pure public NoCloud seed rendering for one disconnected local clone only.
// No files, keys, authentication, package installation or host/guest actions.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";

const script = "/usr/local/sbin/citygo-offline-clone-canary.py";
const fields = ["operationId", "canarySourceLF", "expectedCanarySha256"];

function reject(code) {
  throw new Error(`offline_canary_seed_${code}`);
}

function values(inputs) {
  if (
    inputs === null ||
    typeof inputs !== "object" ||
    types.isProxy(inputs) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(inputs))
  )
    reject("input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(inputs);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== fields.length ||
    names.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    reject("input_fields_invalid");
  const result = Object.create(null);
  for (const name of fields) {
    const descriptor = descriptors[name];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    )
      reject("input_field_invalid");
    result[name] = descriptor.value;
  }
  return result;
}

export function renderOfflineCanarySeed(inputs) {
  const { operationId, canarySourceLF, expectedCanarySha256 } = values(inputs);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      operationId,
    )
  )
    reject("operation_invalid");
  if (
    canarySourceLF.length === 0 ||
    canarySourceLF.length > 131072 ||
    canarySourceLF.split("").some((character) => {
      const code = character.charCodeAt(0);
      return code !== 9 && code !== 10 && (code < 32 || code > 126);
    }) ||
    !canarySourceLF.endsWith("\n") ||
    !canarySourceLF.startsWith("#!/usr/bin/python3\n")
  )
    reject("source_invalid");
  if (!/^[0-9a-f]{64}$/.test(expectedCanarySha256)) reject("hash_invalid");
  const bytes = Buffer.from(canarySourceLF, "ascii");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedCanarySha256)
    reject("source_hash_mismatch");

  const userData = {
    write_files: [
      {
        path: script,
        owner: "root:root",
        permissions: "0700",
        encoding: "b64",
        content: bytes.toString("base64"),
      },
    ],
    runcmd: [
      [
        "/usr/bin/python3",
        "-I",
        "-B",
        script,
        "--apply",
        "--operation-id",
        operationId,
        "--acknowledge",
        `RUN_OFFLINE_CANARY:${operationId}`,
      ],
    ],
  };
  return {
    userData: `#cloud-config\n${JSON.stringify(userData)}\n`,
    metaData: `${JSON.stringify({
      "instance-id": `citygo-canary-${operationId}`,
      "local-hostname": `citygo-ci-canary-${operationId}`,
    })}\n`,
    networkConfig: `${JSON.stringify({
      version: 2,
      ethernets: {
        canary: {
          match: { name: "e*" },
          dhcp4: false,
          dhcp6: false,
          "accept-ra": false,
          "link-local": [],
          optional: true,
        },
      },
    })}\n`,
  };
}
