import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderBootstrapSeed } from "../deploy/ci/render-bootstrap-seed.mjs";

const template = readFileSync(
  new URL("../deploy/ci/bootstrap-user-data.template.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const source = readFileSync(
  new URL("../deploy/ci/render-bootstrap-seed.mjs", import.meta.url),
  "utf8",
);
// Deliberately invalid cryptographic fixtures: no generated or real private
// key is read. The renderer validates shape, not ssh-keygen pair attestation.
function fakePublic(byte) {
  const wire = Buffer.alloc(51, byte);
  wire.writeUInt32BE(11, 0);
  wire.write("ssh-ed25519", 4, "ascii");
  wire.writeUInt32BE(32, 15);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}
const fakePrivate = `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.from("openssh-key-v1\0SYNTHETIC NON-KEY FIXTURE ONLY", "ascii").toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;

function input() {
  return {
    vmId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    hostIPv4: "172.31.96.1",
    authorizedPublicKey: fakePublic(1) + " fake-bootstrap-client",
    hostPrivateKey: fakePrivate,
    hostPublicKey: fakePublic(2) + " fake-bootstrap-host",
    toolchainScriptLF:
      "#!/bin/bash\n# SYNTHETIC, NOT EXECUTED\nprintf 'fake-only\\n'\n",
    publicMetadataJson: JSON.stringify({
      version: 1,
      node: {
        version: "24.22.0",
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        signatureSha256: "c".repeat(64),
        keyringSha256: "d".repeat(64),
        keyringCommit: "e".repeat(40),
        signerFingerprint: "A".repeat(40),
      },
      pnpm: { version: "10.15.0", integrity: "sha512-SYNTHETIC" },
      playwright: { version: "1.63.0", coreIntegrity: "sha512-SYNTHETIC" },
    }),
    nodeKeyringBytes: Buffer.from([0, 255, 17, 2, 7]),
    template,
  };
}

function denied(changes, code = /^bootstrap_seed_[a-z0-9_]+$/) {
  const values = { ...input(), ...changes };
  assert.throws(
    () => renderBootstrapSeed(values),
    (error) => error instanceof Error && code.test(error.message),
  );
}

test("pure renderer has no IO, process, environment, logging or key generation", () => {
  const imports = [...source.matchAll(/^import .+ from "([^"]+)";/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports, ["node:buffer"]);
  assert.doesNotMatch(
    source,
    /\b(?:console|process|fetch|XMLHttpRequest|eval|Function|setTimeout|setInterval)\s*[.(]|node:(?:fs|child_process|http|https|crypto|net|tls)|\bimport\s*\(/,
  );
});

test("renders deterministic bounded LF-only user-data with correctly indented fake host private material", () => {
  const values = input();
  const rendered = renderBootstrapSeed(values);
  assert.deepEqual(rendered, renderBootstrapSeed(values));
  assert.deepEqual(Object.keys(rendered), [
    "userData",
    "metaData",
    "networkConfig",
    "knownHosts",
  ]);
  assert.match(rendered.userData, /^#cloud-config\n/);
  assert.doesNotMatch(rendered.userData, /__|\r/);
  const privateBlock = rendered.userData.split("  ed25519_private: |\n")[1];
  assert(privateBlock);
  const inserted = privateBlock.split("  ed25519_public:")[0];
  assert.equal(
    inserted,
    fakePrivate
      .trimEnd()
      .split("\n")
      .map((line) => `    ${line}\n`)
      .join(""),
  );
  assert.match(
    rendered.userData,
    /from="172\.31\.96\.1",restrict ssh-ed25519 [A-Za-z0-9+/]+/,
  );
  assert.doesNotMatch(
    rendered.userData,
    /fake-bootstrap-client|fake-bootstrap-host/,
  );
  for (const name of ["metaData", "networkConfig", "knownHosts"])
    assert.ok(!rendered[name].includes("PRIVATE KEY"));
});

test("base64 embeds exact supplied public payloads, never interprets the script as a template", () => {
  const values = input();
  values.toolchainScriptLF += "# __CITYGO_NOT_A_TEMPLATE_FIELD__\n";
  values.publicMetadataJson = values.publicMetadataJson.replace(/,/g, ",\n");
  const rendered = renderBootstrapSeed(values);
  const blocks = [
    ...rendered.userData.matchAll(
      / {4}encoding: b64\n {4}content: ([A-Za-z0-9+/=]+)\n/g,
    ),
  ].map((match) => Buffer.from(match[1], "base64"));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].toString("utf8"), values.toolchainScriptLF);
  assert.equal(blocks[1].toString("utf8"), values.publicMetadataJson);
  assert.deepEqual(blocks[2], values.nodeKeyringBytes);
});

test("unique VM host alias and unique operation instance-id are bound separately", () => {
  const first = renderBootstrapSeed(input());
  assert.equal(
    first.knownHosts,
    `citygo-bootstrap-11111111-1111-4111-8111-111111111111 ${fakePublic(2)}\n`,
  );
  assert.equal(
    first.metaData,
    "instance-id: citygo-bootstrap-22222222-2222-4222-8222-222222222222\nlocal-hostname: citygo-ci-bootstrap\n",
  );
  const second = renderBootstrapSeed({
    ...input(),
    vmId: "33333333-3333-4333-8333-333333333333",
    operationId: "44444444-4444-4444-8444-444444444444",
  });
  assert.notEqual(first.knownHosts, second.knownHosts);
  assert.notEqual(first.metaData, second.metaData);
});

test("one early-network stanza selects e* with only reviewed DNS and no DHCP6, RA or link-local", () => {
  const { networkConfig } = renderBootstrapSeed(input());
  assert.equal((networkConfig.match(/^ {4}match:/gm) ?? []).length, 1);
  assert.match(networkConfig, /name: "e\*"/);
  assert.match(networkConfig, /dhcp4: true/);
  assert.match(networkConfig, /dhcp6: false/);
  assert.match(networkConfig, /accept-ra: false/);
  assert.match(networkConfig, /link-local: \[\]/);
  assert.match(networkConfig, /dhcp4-overrides:\n {6}use-dns: false/);
  assert.match(networkConfig, /addresses: \[1\.1\.1\.1, 8\.8\.8\.8\]/);
  assert.doesNotMatch(networkConfig, /macaddress|gateway|routes:|dhcp6: true/);
});

test("canonical nonzero UUIDs and unicast IPv4 reject ambiguous or injected identities", () => {
  for (const value of [
    undefined,
    "",
    "..",
    "{11111111-1111-4111-8111-111111111111}",
    "00000000-0000-0000-0000-000000000000",
    "AAAAAAAA-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111\n",
  ])
    for (const name of ["vmId", "operationId"]) denied({ [name]: value });
  for (const hostIPv4 of [
    "0172.31.96.1",
    "172.31.96.256",
    "172.31.96.1\n",
    "172.31.96.1,evil",
    "::1",
    "0.0.0.0",
    "127.0.0.1",
    "255.255.255.255",
    "224.0.0.1",
    "https://host",
  ])
    denied({ hostIPv4 });
});

test("public keys require exact canonical ed25519 wire format, safe optional comment and distinct roles", () => {
  for (const name of ["authorizedPublicKey", "hostPublicKey"])
    for (const value of [
      "ssh-rsa AAAA",
      "ssh-ed25519 AAAA",
      fakePublic(1) + "\n",
      "restrict " + fakePublic(1),
      fakePublic(1) + " extra'\nuser: root",
      fakePublic(1) + " one two",
      fakePublic(1).replace("ssh-ed25519 ", "ssh-ed25519  "),
    ])
      denied({ [name]: value });
  const wrongWire = Buffer.alloc(51, 3);
  wrongWire.writeUInt32BE(11, 0);
  wrongWire.write("ssh-ed25519", 4, "ascii");
  wrongWire.writeUInt32BE(31, 15);
  denied({ hostPublicKey: `ssh-ed25519 ${wrongWire.toString("base64")}` });
  denied(
    { authorizedPublicKey: fakePublic(2) },
    /^bootstrap_seed_keys_must_be_distinct$/,
  );
});

test("private input accepts CRLF OpenSSH shape but rejects PEM confusion, extra data, malformed encoding and size", () => {
  assert.equal(
    renderBootstrapSeed({
      ...input(),
      hostPrivateKey: fakePrivate.replaceAll("\n", "\r\n"),
    }).userData,
    renderBootstrapSeed(input()).userData,
  );
  for (const hostPrivateKey of [
    fakePrivate.replaceAll("OPENSSH", "RSA"),
    fakePrivate + "secret-extra",
    fakePrivate.replace("\n", "\r"),
    fakePrivate.replace("b3Bl", "!!!!"),
    "x".repeat(8193),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n",
  ])
    denied({ hostPrivateKey });
});

test("template rejects missing, duplicate, unknown and malformed unresolved placeholders", () => {
  const marker = "__CITYGO_PUBLIC_TOOLCHAIN_METADATA_BASE64__";
  for (const changed of [
    template.replace(marker, ""),
    template + `\n# ${marker}\n`,
    template + "\n# __UNKNOWN_SECRET_FIELD__\n",
    template + "\n# __unclosed\n",
    template.replace(
      "    __CITYGO_VM_UNIQUE_ED25519_HOST_PRIVATE_KEY__",
      "  __CITYGO_VM_UNIQUE_ED25519_HOST_PRIVATE_KEY__",
    ),
    template.replace("#cloud-config", "#wrong-format"),
  ])
    denied({ template: changed });
  assert.equal(
    renderBootstrapSeed({
      ...input(),
      template: template.replaceAll("\n", "\r\n"),
    }).userData,
    renderBootstrapSeed(input()).userData,
  );
});

test("public metadata allows only bounded public pin fields and rejects duplicate decoded JSON keys", () => {
  const good = input().publicMetadataJson;
  for (const publicMetadataJson of [
    "[]",
    "null",
    "{",
    good.replace('"version":1', '"version":true'),
    good.replace('"version":1', '"version":2'),
    good.replace('"version":1', '"version":1,"version":1'),
    good.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    good.replace('"archiveSha256":', '"archiveSha256":"a","archiveSha256":'),
    good.replace('"version":1', '"version":1,"apiKey":"SYNTHETIC-UNWANTED"'),
    good.replace(
      '"keyringCommit":',
      '"secret":"SYNTHETIC-UNWANTED","keyringCommit":',
    ),
    good.replace('"version":"24.22.0"', '"version":"__UNRESOLVED__"'),
    " ".repeat(8193),
  ])
    denied({ publicMetadataJson });
});

test("bounds, LF script contract and input data descriptors fail with sanitized static errors", () => {
  for (const change of [
    { toolchainScriptLF: "#!/bin/bash\r\nprintf test\r\n" },
    { toolchainScriptLF: "#!/bin/sh\ntrue\n" },
    { toolchainScriptLF: "#!/bin/bash\n" + "x".repeat(262144) },
    { template: template + "x".repeat(262144) },
    { template: template + "\0" },
    { nodeKeyringBytes: Buffer.alloc(0) },
    { nodeKeyringBytes: Buffer.alloc(1048577) },
    { nodeKeyringBytes: "not-bytes" },
    { nodeKeyringBytes: [1, 2, 3] },
    { clientPrivateKey: "SYNTHETIC-CLIENT-PRIVATE-MUST-NOT-BE-ACCEPTED" },
  ])
    denied(change);
  for (const values of [null, undefined, [], new Date()])
    assert.throws(
      () => renderBootstrapSeed(values),
      /^Error: bootstrap_seed_inputs_invalid$/,
    );
  let called = false;
  const accessor = input();
  Object.defineProperty(accessor, "hostPrivateKey", {
    get() {
      called = true;
      throw new Error("SYNTHETIC-SECRET");
    },
  });
  assert.throws(
    () => renderBootstrapSeed(accessor),
    /^Error: bootstrap_seed_inputs_invalid$/,
  );
  assert.equal(called, false);
});
