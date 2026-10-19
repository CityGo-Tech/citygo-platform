import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderPrivateGatewaySeed } from "../deploy/ci/render-private-gateway-seed.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const initializer = readFileSync(
  new URL("../deploy/ci/private-gateway-init.py", import.meta.url),
  "utf8",
);
const policy = readFileSync(
  new URL("../deploy/ci/private-gateway-policy.py", import.meta.url),
  "utf8",
);
const helper = readFileSync(
  new URL("../deploy/ci/offline-clone-canary.py", import.meta.url),
  "utf8",
);
const op = "12345678-1234-4234-8234-123456789abc";
const config = () => ({
  schemaVersion: 1,
  operationId: op,
  capturedAt: "2026-10-19T08:00:00Z",
  hostSnapshotSha256: "a".repeat(64),
  wanMac: "02:11:22:33:44:55",
  lanMac: "02:11:22:33:44:66",
  expectedWanPrefix: "172.30.16.0/20",
  expectedWanGatewayIPv4: "172.30.16.1",
  hostIPv4: ["172.30.16.1"],
  productionIPv4: ["93.184.216.34"],
  additionalDeniedPrefixes: [],
});
const input = () => ({
  configJson: JSON.stringify(config()),
  initializerSourceLF: initializer,
  expectedInitializerSha256: hash(initializer),
  policySourceLF: policy,
  offlineHelperSourceLF: helper,
});

test("gateway seed renderer has no IO/process/env/key provisioning and is deterministic", () => {
  const source = readFileSync(
    new URL("../deploy/ci/render-private-gateway-seed.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /node:(?:fs|child_process)|process\.|Date\.now|Math\.random|fetch\(|console\.|ssh_authorized_keys|users:/,
  );
  assert.deepEqual(
    renderPrivateGatewaySeed(input()),
    renderPrivateGatewaySeed(input()),
  );
});

test("exact public artifacts/config are base64 bytes; argv and early forward=0 are fixed", () => {
  const data = input(),
    result = renderPrivateGatewaySeed(data);
  const parsed = JSON.parse(result.userData.slice("#cloud-config\n".length));
  assert.deepEqual(Object.keys(parsed), ["write_files", "bootcmd", "runcmd"]);
  assert.equal(parsed.write_files.length, 4);
  for (const [index, source] of [
    initializer,
    policy,
    helper,
    data.configJson,
  ].entries()) {
    assert.equal(
      Buffer.from(parsed.write_files[index].content, "base64").toString(
        "ascii",
      ),
      source,
    );
    assert.equal(parsed.write_files[index].owner, "root:root");
    assert.equal(
      parsed.write_files[index].permissions,
      index === 0 ? "0700" : "0600",
    );
  }
  assert.deepEqual(parsed.bootcmd, [
    ["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"],
  ]);
  assert.deepEqual(parsed.runcmd, [
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      "/usr/local/sbin/citygo-private-gateway-init.py",
      "--apply",
      "--operation-id",
      op,
      "--acknowledge",
      `INITIALIZE_PRIVATE_GATEWAY:${op}`,
    ],
  ]);
  assert.equal(result.configSha256, hash(data.configJson));
  assert.ok(result.userData.length <= 190000);
});

test("WAN/LAN exact MAC identities stay separate; only WAN gets DHCP/DNS; no bridge or IPv6 autoconfig", () => {
  const result = renderPrivateGatewaySeed(input()),
    network = JSON.parse(result.networkConfig),
    meta = JSON.parse(result.metaData);
  assert.equal(meta["instance-id"], `citygo-gateway-${op}`);
  assert.deepEqual(Object.keys(network.ethernets), [
    "gatewayWan",
    "gatewayLan",
  ]);
  const wan = network.ethernets.gatewayWan,
    lan = network.ethernets.gatewayLan;
  assert.equal(wan.match.macaddress, config().wanMac);
  assert.equal(lan.match.macaddress, config().lanMac);
  assert.equal(wan["set-name"], "wan0");
  assert.equal(lan["set-name"], "lan0");
  assert.equal(wan.dhcp4, true);
  assert.equal(lan.dhcp4, false);
  assert.equal(wan["dhcp4-overrides"]["use-dns"], false);
  assert.deepEqual(lan.addresses, ["10.203.0.1/30"]);
  assert.equal(lan.routes, undefined);
  assert.equal(lan.nameservers, undefined);
  for (const nic of [wan, lan]) {
    assert.equal(nic.dhcp6, false);
    assert.equal(nic["accept-ra"], false);
    assert.deepEqual(nic["link-local"], []);
  }
  assert.equal(network.bridges, undefined);
});

test("strict descriptors reject proxies, getters, unknown fields and nonstring artifacts without invoking callbacks", () => {
  let invoked = 0;
  const getter = input();
  Object.defineProperty(getter, "configJson", {
    enumerable: true,
    get() {
      invoked++;
      return "{}";
    },
  });
  const proxy = new Proxy(input(), {
    ownKeys() {
      invoked++;
      return [];
    },
  });
  for (const bad of [
    null,
    [],
    getter,
    proxy,
    { ...input(), key: "no" },
    { ...input(), initializerSourceLF: Buffer.from(initializer) },
  ])
    assert.throws(() => renderPrivateGatewaySeed(bad));
  assert.equal(invoked, 0);
});

test("exact source pins, LF-only ASCII and payload bounds cannot be bypassed", () => {
  for (const change of [
    { initializerSourceLF: initializer + "# drift\n" },
    { policySourceLF: policy + "\n" },
    { offlineHelperSourceLF: helper + "\n" },
    { initializerSourceLF: initializer.replaceAll("\n", "\r\n") },
    { initializerSourceLF: "#!/usr/bin/python3\n" + "x".repeat(131072) },
    { expectedInitializerSha256: "A".repeat(64) },
  ])
    assert.throws(() => renderPrivateGatewaySeed({ ...input(), ...change }));
});

test("noncanonical/duplicate JSON, unknown config fields, reused MACs and injected identity are refused", () => {
  const baseline = input();
  for (const patch of [
    { schemaVersion: true },
    { operationId: "../bad" },
    { wanMac: config().lanMac },
    { wanMac: "ff:ff:ff:ff:ff:ff" },
    { capturedAt: "not-a-date" },
    { hostIPv4: [] },
    { hostIPv4: ["1.2.3.4;echo"] },
    { productionIPv4: [] },
    { hostSnapshotSha256: "A".repeat(64) },
    { secret: "bad" },
  ])
    assert.throws(() =>
      renderPrivateGatewaySeed({
        ...baseline,
        configJson: JSON.stringify({ ...config(), ...patch }),
      }),
    );
  for (const raw of [
    " " + baseline.configJson,
    baseline.configJson.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ),
    "[]",
    "{broken",
  ])
    assert.throws(() =>
      renderPrivateGatewaySeed({ ...baseline, configJson: raw }),
    );
});
