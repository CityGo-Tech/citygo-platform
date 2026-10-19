// Pure trusted-bootstrap rendering only. All returned strings, especially
// userData, belong in the operator's protected per-operation control directory.
// No key-pair validation, image attestation, network enforcement or sealing is
// claimed here: the trusted caller must separately verify the supplied key pair.
import { Buffer } from "node:buffer";

const markers = Object.freeze({
  hostIPv4: "__CITYGO_BOOTSTRAP_HOST_IPV4__",
  authorizedPublicKey: "__CITYGO_BOOTSTRAP_AUTHORIZED_PUBLIC_KEY__",
  hostPrivateKey: "__CITYGO_VM_UNIQUE_ED25519_HOST_PRIVATE_KEY__",
  hostPublicKey: "__CITYGO_VM_UNIQUE_ED25519_HOST_PUBLIC_KEY__",
  toolchain: "__CITYGO_BOOTSTRAP_TOOLCHAIN_BASE64__",
  metadata: "__CITYGO_PUBLIC_TOOLCHAIN_METADATA_BASE64__",
  keyring: "__CITYGO_OFFICIAL_NODE_RELEASE_KEYRING_BASE64__",
});
const inputFields = Object.freeze([
  "vmId",
  "operationId",
  "hostIPv4",
  "authorizedPublicKey",
  "hostPrivateKey",
  "hostPublicKey",
  "toolchainScriptLF",
  "publicMetadataJson",
  "nodeKeyringBytes",
  "template",
]);

function reject(code) {
  // Codes never contain input, private key material or underlying parser text.
  throw new Error(`bootstrap_seed_${code}`);
}

function text(value, maximum, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    reject(code);
  return value;
}

function uuid(value) {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  )
    reject("identity_invalid");
  return value;
}

function ipv4(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)
  )
    reject("host_ipv4_invalid");
  const octets = value.split(".").map(Number);
  if (
    octets.some((octet) => octet > 255) ||
    octets[0] === 0 ||
    octets[0] === 127 ||
    octets[0] >= 224
  )
    reject("host_ipv4_invalid");
  return value;
}

function publicKey(value) {
  text(value, 256, "public_key_invalid");
  // Optional generated comments are discarded, never injected into YAML or
  // known_hosts. No quotes, options, control characters or multiline keys.
  const match =
    /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [A-Za-z0-9._@+-]{1,128})?$/.exec(
      value,
    );
  if (!match || match[0] !== value) reject("public_key_invalid");
  const wire = Buffer.from(match[1], "base64");
  if (
    wire.toString("base64") !== match[1] ||
    wire.length !== 51 ||
    wire.readUInt32BE(0) !== 11 ||
    wire.toString("ascii", 4, 15) !== "ssh-ed25519" ||
    wire.readUInt32BE(15) !== 32
  )
    reject("public_key_invalid");
  return `ssh-ed25519 ${match[1]}`;
}

function privateKey(value) {
  const normalized = text(value, 8192, "private_key_invalid").replaceAll(
    "\r\n",
    "\n",
  );
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n((?:[A-Za-z0-9+/]{1,76}={0,2}\n)+)-----END OPENSSH PRIVATE KEY-----\n?$/.exec(
      normalized,
    );
  if (!match || match[0] !== normalized) reject("private_key_invalid");
  const encoded = match[1].replaceAll("\n", "");
  const wire = Buffer.from(encoded, "base64");
  if (
    wire.toString("base64") !== encoded ||
    wire.length <= 15 ||
    wire.subarray(0, 15).toString("ascii") !== "openssh-key-v1\0"
  )
    reject("private_key_invalid");
  // Shape only. The trusted caller MUST derive the public key with ssh-keygen
  // and compare it to hostPublicKey before permitting a seed/VM operation.
  return normalized.replace(/\n$/, "");
}

function noDuplicateJsonKeys(raw) {
  // JSON.parse has already validated the grammar. This string-aware scan only
  // detects duplicate decoded object keys, including escaped spellings.
  const frames = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const start = index;
      for (index++; index < raw.length; index++) {
        if (raw[index] === "\\") index++;
        else if (raw[index] === '"') break;
      }
      const frame = frames.at(-1);
      if (frame?.object && frame.keyExpected) {
        const key = JSON.parse(raw.slice(start, index + 1));
        if (frame.keys.has(key)) reject("public_metadata_invalid");
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    } else if (character === "{") {
      frames.push({ object: true, keys: new Set(), keyExpected: true });
    } else if (character === "[") {
      frames.push({ object: false });
    } else if (character === "}" || character === "]") frames.pop();
    else if (character === "," && frames.at(-1)?.object)
      frames.at(-1).keyExpected = true;
  }
}

function publicMetadata(value) {
  const raw = text(value, 8192, "public_metadata_invalid");
  let parsed;
  try {
    parsed = JSON.parse(raw);
    noDuplicateJsonKeys(raw);
  } catch {
    reject("public_metadata_invalid");
  }
  const objectWithFields = (item, fields) =>
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    Object.keys(item).length === fields.length &&
    fields.every((field) => Object.hasOwn(item, field));
  if (
    !objectWithFields(parsed, ["version", "node", "pnpm", "playwright"]) ||
    parsed.version !== 1
  )
    reject("public_metadata_invalid");
  // Allowlist PUBLIC pin fields, not a second implementation of the toolchain's
  // full version/SRI/hash/GPG policy. That validator remains authoritative.
  for (const [name, fields] of [
    [
      "node",
      [
        "version",
        "archiveSha256",
        "manifestSha256",
        "signatureSha256",
        "keyringSha256",
        "keyringCommit",
        "signerFingerprint",
      ],
    ],
    ["pnpm", ["version", "integrity"]],
    ["playwright", ["version", "coreIntegrity"]],
  ]) {
    if (
      !objectWithFields(parsed[name], fields) ||
      fields.some(
        (field) =>
          typeof parsed[name][field] !== "string" ||
          parsed[name][field].includes("\n") ||
          !/^[A-Za-z0-9+/=.-]{1,512}$/.test(parsed[name][field]),
      )
    )
      reject("public_metadata_invalid");
  }
  return raw;
}

/**
 * No IO, subprocesses, logging, networking or key generation. All outputs are
 * sensitive operation materials. knownHosts uses HostKeyAlias
 * citygo-bootstrap-<vmId>, not TOFU or an address-derived SSH identity.
 */
export function renderBootstrapSeed(inputs) {
  if (
    inputs === null ||
    typeof inputs !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(inputs)) ||
    Reflect.ownKeys(inputs).length !== inputFields.length ||
    inputFields.some((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(inputs, field);
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })
  )
    reject("inputs_invalid");

  const vmId = uuid(inputs.vmId);
  const operationId = uuid(inputs.operationId);
  const hostIPv4 = ipv4(inputs.hostIPv4);
  const authorizedPublicKey = publicKey(inputs.authorizedPublicKey);
  const hostPublicKey = publicKey(inputs.hostPublicKey);
  if (authorizedPublicKey === hostPublicKey) reject("keys_must_be_distinct");
  const hostPrivateKey = privateKey(inputs.hostPrivateKey);
  const toolchain = text(inputs.toolchainScriptLF, 262144, "toolchain_invalid");
  if (!toolchain.startsWith("#!/bin/bash\n") || toolchain.includes("\r"))
    reject("toolchain_invalid");
  const metadata = publicMetadata(inputs.publicMetadataJson);
  const keyring = inputs.nodeKeyringBytes;
  if (
    !(keyring instanceof Uint8Array) ||
    keyring.byteLength < 1 ||
    keyring.byteLength > 1048576
  )
    reject("keyring_invalid");

  const template = text(inputs.template, 262144, "template_invalid").replaceAll(
    "\r\n",
    "\n",
  );
  if (!template.startsWith("#cloud-config\n") || template.includes("\r"))
    reject("template_invalid");
  let remainder = template;
  for (const marker of Object.values(markers)) {
    if (template.split(marker).length !== 2) reject("template_markers_invalid");
    remainder = remainder.replace(marker, "");
  }
  if (remainder.includes("__")) reject("template_markers_invalid");
  const privateLine = `    ${markers.hostPrivateKey}`;
  if (!template.includes(`  ed25519_private: |\n${privateLine}\n`))
    reject("template_private_placement_invalid");

  const replacements = new Map([
    [markers.hostIPv4, hostIPv4],
    [markers.authorizedPublicKey, authorizedPublicKey],
    [markers.hostPublicKey, hostPublicKey],
    [markers.toolchain, Buffer.from(toolchain, "utf8").toString("base64")],
    [markers.metadata, Buffer.from(metadata, "utf8").toString("base64")],
    [markers.keyring, Buffer.from(keyring).toString("base64")],
  ]);
  let userData = template.replace(
    privateLine,
    hostPrivateKey
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );
  for (const [marker, replacement] of replacements)
    userData = userData.replace(marker, replacement);
  if (userData.includes("__")) reject("unresolved_marker");

  const alias = `citygo-bootstrap-${vmId}`;
  return {
    userData,
    metaData: `instance-id: citygo-bootstrap-${operationId}\nlocal-hostname: citygo-ci-bootstrap\n`,
    // The trusted host must separately verify that the VM has exactly one NIC.
    // Ubuntu's initial e* name is matched because the preboot MAC can be unset.
    networkConfig:
      'version: 2\nethernets:\n  citygo:\n    match:\n      name: "e*"\n    dhcp4: true\n    dhcp6: false\n    accept-ra: false\n    link-local: []\n    dhcp4-overrides:\n      use-dns: false\n      use-domains: false\n    nameservers:\n      addresses: [1.1.1.1, 8.8.8.8]\n',
    knownHosts: `${alias} ${hostPublicKey}\n`,
  };
}
