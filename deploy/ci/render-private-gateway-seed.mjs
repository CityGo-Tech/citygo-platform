// Pure, public NoCloud seed for a trusted gateway, not a CI job/registration.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";

const policySha =
  "980c8195e5cb8a01fc86997758d380daa919a2d2ca0bed9df28e05a0766083f3";
const helperSha =
  "c10465066ce2908fa72d6416811a6bc426c96aef90584b8c0639e9a45a97e0b4";
const script = "/usr/local/sbin/citygo-private-gateway-init.py";
const fields = [
  "configJson",
  "initializerSourceLF",
  "expectedInitializerSha256",
  "policySourceLF",
  "offlineHelperSourceLF",
];
const configFields = [
  "schemaVersion",
  "operationId",
  "capturedAt",
  "hostSnapshotSha256",
  "wanMac",
  "lanMac",
  "expectedWanPrefix",
  "expectedWanGatewayIPv4",
  "hostIPv4",
  "productionIPv4",
  "additionalDeniedPrefixes",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function require(value, code) {
  if (!value) throw new Error(`private_gateway_seed_${code}`);
}

function inputs(value) {
  require(value !== null &&
    typeof value === "object" &&
    !types.isProxy(value) &&
    [Object.prototype, null].includes(
      Object.getPrototypeOf(value),
    ), "inputs_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  require(keys.length === fields.length &&
    keys.every(
      (key) => typeof key === "string" && fields.includes(key),
    ), "fields_invalid");
  const output = Object.create(null);
  for (const key of fields) {
    const descriptor = descriptors[key];
    require(descriptor &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "string", "value_invalid");
    output[key] = descriptor.value;
  }
  return output;
}

function source(value, expected) {
  require(value.length > 0 &&
    value.length <= 131072 &&
    value.startsWith("#!/usr/bin/python3\n") &&
    value.endsWith("\n") &&
    !/[^\x20-\x7e]/.test(
      value.replaceAll("\t", "").replaceAll("\n", ""),
    ), "source_invalid");
  require(/^[a-f0-9]{64}$/.test(expected) &&
    hash(Buffer.from(value, "ascii")) === expected, "source_pin_mismatch");
  return Buffer.from(value, "ascii").toString("base64");
}

export function renderPrivateGatewaySeed(input) {
  const data = inputs(input);
  require(data.configJson.length >= 2 &&
    data.configJson.length <= 32768 &&
    !/[^\x20-\x7e]/.test(data.configJson), "config_invalid");
  let config;
  try {
    config = JSON.parse(data.configJson);
  } catch {
    throw new Error("private_gateway_seed_config_invalid");
  }
  require(config !== null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    JSON.stringify(config) === data.configJson &&
    Object.keys(config).length === configFields.length &&
    Object.keys(config).every((key) =>
      configFields.includes(key),
    ), "config_fields_invalid");
  require(config.schemaVersion === 1 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      config.operationId,
    ) &&
    /^[a-f0-9]{64}$/.test(
      config.hostSnapshotSha256,
    ), "config_identity_invalid");
  require(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(
    config.capturedAt,
  ), "config_time_invalid");
  for (const key of ["wanMac", "lanMac"])
    require(/^02(?::[a-f0-9]{2}){5}$/.test(config[key]), "config_mac_invalid");
  require(config.wanMac !== config.lanMac, "config_mac_duplicate");
  for (const [key, minimum, maximum] of [
    ["hostIPv4", 1, 128],
    ["productionIPv4", 1, 64],
    ["additionalDeniedPrefixes", 0, 256],
  ]) {
    require(Array.isArray(config[key]) &&
      config[key].length >= minimum &&
      config[key].length <= maximum &&
      config[key].every(
        (value) => typeof value === "string" && /^[0-9./]{1,18}$/.test(value),
      ) &&
      new Set(config[key]).size === config[key].length, "config_list_invalid");
  }
  require(typeof config.expectedWanPrefix === "string" &&
    /^[0-9.]{7,15}\/\d{1,2}$/.test(config.expectedWanPrefix) &&
    typeof config.expectedWanGatewayIPv4 === "string" &&
    /^[0-9.]{7,15}$/.test(config.expectedWanGatewayIPv4), "config_wan_invalid");
  const records = [
    [
      script,
      "0700",
      source(data.initializerSourceLF, data.expectedInitializerSha256),
    ],
    [
      "/usr/local/lib/citygo-ci/private-gateway-policy.py",
      "0600",
      source(data.policySourceLF, policySha),
    ],
    [
      "/usr/local/lib/citygo-ci/offline-clone-canary.py",
      "0600",
      source(data.offlineHelperSourceLF, helperSha),
    ],
    [
      "/var/lib/citygo-ci-gateway/config.json",
      "0600",
      Buffer.from(data.configJson, "ascii").toString("base64"),
    ],
  ];
  const userData = `#cloud-config\n${JSON.stringify({
    write_files: records.map(([path, permissions, content]) => ({
      path,
      owner: "root:root",
      permissions,
      encoding: "b64",
      content,
    })),
    bootcmd: [["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"]],
    runcmd: [
      [
        "/usr/bin/python3",
        "-I",
        "-B",
        script,
        "--apply",
        "--operation-id",
        config.operationId,
        "--acknowledge",
        `INITIALIZE_PRIVATE_GATEWAY:${config.operationId}`,
      ],
    ],
  })}\n`;
  require(userData.length <= 190000, "seed_too_large");
  return {
    userData,
    metaData: `${JSON.stringify({ "instance-id": `citygo-gateway-${config.operationId}`, "local-hostname": `citygo-ci-gateway-${config.operationId}` })}\n`,
    networkConfig: `${JSON.stringify({
      version: 2,
      renderer: "networkd",
      ethernets: {
        gatewayWan: {
          match: { macaddress: config.wanMac },
          "set-name": "wan0",
          dhcp4: true,
          dhcp6: false,
          "accept-ra": false,
          "link-local": [],
          "dhcp4-overrides": { "use-dns": false, "use-ntp": false },
          nameservers: { addresses: ["1.1.1.1", "8.8.8.8"] },
        },
        gatewayLan: {
          match: { macaddress: config.lanMac },
          "set-name": "lan0",
          dhcp4: false,
          dhcp6: false,
          "accept-ra": false,
          "link-local": [],
          addresses: ["10.203.0.1/30"],
          optional: true,
        },
      },
    })}\n`,
    configSha256: hash(Buffer.from(data.configJson, "ascii")),
    initializerSha256: data.expectedInitializerSha256,
  };
}
