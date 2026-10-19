import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/private-gateway-policy.py", import.meta.url),
);
const source = readFileSync(path, "utf8");
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
const fixture = () => ({
  schemaVersion: 1,
  operationId: "12345678-1234-4234-8234-123456789abc",
  hostSnapshotSha256: "a".repeat(64),
  wanAddressIPv4: "172.30.16.10",
  wanPrefix: "172.30.16.0/20",
  wanGatewayIPv4: "172.30.16.1",
  dhcpServerIPv4: "172.30.16.1",
  hostIPv4: ["10.240.10.20", "172.30.16.1"],
  productionIPv4: ["93.184.216.34"],
  additionalDeniedPrefixes: ["100.100.0.0/16"],
});

function cli(config, args = ["--plan", "--config-json"]) {
  return spawnSync(
    python,
    [
      "-I",
      "-B",
      path,
      ...args,
      typeof config === "string" ? config : JSON.stringify(config),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
}
function rendered(config = fixture()) {
  const out = cli(config);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.equal(out.stderr, "");
  return JSON.parse(out.stdout);
}
function refused(config) {
  const out = cli(config);
  assert.equal(out.status, 2, out.stderr || out.stdout);
  assert.equal(out.stderr, "");
  const result = JSON.parse(out.stdout);
  assert.equal(result.stage, "refused");
  assert.equal(result.policyApplied, false);
  assert.equal(result.ciJobsAdmitted, false);
}

test("gateway module is a pure data renderer, never a shell/firewall/VM installer", () => {
  assert.doesNotMatch(
    source,
    /^import (?:os|subprocess|socket|urllib)|\b(?:open|exec|eval|__import__)\(/m,
  );
  assert.doesNotMatch(
    source,
    /--apply|flush ruleset|systemctl|sudo |rm -|docker\.sock|credentials|secret_key/,
  );
  assert.match(source, /"--plan", "--config-json"/);
});

test(
  "strict deterministic plan is bound to operation and fresh-inventory hash, never admission",
  { skip: !available },
  () => {
    const a = rendered();
    assert.deepEqual(a, rendered());
    assert.equal(a.scope, "private_ci_gateway_policy_plan");
    assert.equal(a.policyApplied, false);
    assert.equal(a.guestIsolationVerified, false);
    assert.equal(a.ciJobsAdmitted, false);
    assert.equal(a.requiresFreshHostSnapshot, true);
    assert.equal(a.indirectProxyIsolationProven, false);
    assert.equal(a.hostSnapshotSha256, "a".repeat(64));
    assert.match(a.ipv4Sha256, /^[a-f0-9]{64}$/);
    assert.equal(a.clientIPv4, "10.203.0.2");
  },
);

test(
  "all chains default-drop; gateway never exposes SSH/DNS/web to the CI guest; IPv6 is closed",
  { skip: !available },
  () => {
    const p = rendered();
    for (const family of [p.ipv4Restore, p.ipv6Restore]) {
      for (const chain of ["INPUT", "FORWARD", "OUTPUT"])
        assert.match(family, new RegExp(`:${chain} DROP \\[0:0\\]`));
    }
    assert.match(p.ipv4Restore, /-A INPUT -i lan0 -j DROP/);
    assert.doesNotMatch(p.ipv6Restore, /-A FORWARD|wan0|lan0/);
    assert.doesNotMatch(p.ipv4Restore, /--dport (?:22|80|2375|2376)\b/);
    assert.equal((p.ipv4Restore.match(/MASQUERADE/g) || []).length, 1);
    assert.match(
      p.ipv4Restore,
      /-A POSTROUTING -s 10\.203\.0\.2\/32 -o wan0 -j MASQUERADE/,
    );
  },
);

test(
  "direct LAN/host/metadata/prod denials precede established reply permits and are bidirectional",
  { skip: !available },
  () => {
    const rules = rendered().ipv4Restore;
    const established = rules.indexOf("-A FORWARD -i wan0 -o lan0");
    for (const target of [
      "10.0.0.0/8",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "100.64.0.0/10",
      "93.184.216.34/32",
      "10.240.10.20/32",
      "172.30.16.0/20",
    ]) {
      const outbound = `-A FORWARD -i lan0 -d ${target} -j DROP`;
      const inbound = `-A FORWARD -i wan0 -s ${target} -j DROP`;
      assert.ok(
        rules.includes(outbound) && rules.indexOf(outbound) < established,
        target,
      );
      assert.ok(
        rules.includes(inbound) && rules.indexOf(inbound) < established,
        target,
      );
    }
    assert.match(rules, /-A FORWARD -i lan0 ! -s 10\.203\.0\.2\/32 -j DROP/);
  },
);

test(
  "only fixed public DNS and public HTTPS, exact DHCP reply/server; no CI DHCP exception",
  { skip: !available },
  () => {
    const rules = rendered().ipv4Restore;
    assert.match(
      rules,
      /-A INPUT -i wan0 -s 172\.30\.16\.1\/32 -p udp --sport 67 --dport 68 -j ACCEPT/,
    );
    assert.doesNotMatch(
      rules,
      /-A FORWARD[^\n]*(?:--sport 67|--dport 67|--dport 68)/,
    );
    for (const resolver of ["1.1.1.1", "8.8.8.8"]) {
      for (const protocol of ["udp", "tcp"])
        assert.ok(
          rules.includes(`-d ${resolver}/32 -p ${protocol} --dport 53`),
        );
    }
    assert.match(
      rules,
      /-A FORWARD -i lan0 -o wan0 -s 10\.203\.0\.2\/32 -p tcp --dport 443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT/,
    );
  },
);

test(
  "schema, canonical IPs/prefixes and bounded lists reject injection, unknown snapshots and broad tunnel classification",
  { skip: !available },
  () => {
    for (const patch of [
      { schemaVersion: true },
      { operationId: "wrong" },
      { hostSnapshotSha256: "A".repeat(64) },
      { hostIPv4: [] },
      { hostIPv4: ["10.0.0.01"] },
      { hostIPv4: ["1.2.3.4", "1.2.3.4"] },
      { productionIPv4: [] },
      { productionIPv4: ["93.184.216.34; ACCEPT"] },
      { additionalDeniedPrefixes: ["0.0.0.0/0"] },
      { additionalDeniedPrefixes: ["10.1.1.1/8"] },
      { additionalDeniedPrefixes: ["1.1.0.0/16"] },
      { productionIPv4: ["8.8.8.8"] },
      { secret: "not-allowed" },
      { wanAddressIPv4: "::1" },
      { wanGatewayIPv4: "172.31.0.1" },
      { wanAddressIPv4: "172.30.16.1" },
      { dhcpServerIPv4: "172.30.16.0" },
      { productionIPv4: ["172.30.16.1"] },
      { wanPrefix: "10.0.0.0/8" },
    ])
      refused({ ...fixture(), ...patch });
  },
);

test(
  "duplicate JSON keys, malformed data and unexpected CLI commands are refused without side effects",
  { skip: !available },
  () => {
    const raw = JSON.stringify(fixture());
    refused(
      raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    );
    refused("[]");
    refused("{broken");
    for (const args of [
      ["--apply", "--config-json"],
      ["--plan", "--file"],
      ["--plan"],
    ]) {
      const out = cli(fixture(), args);
      assert.equal(out.status, 2);
      assert.equal(JSON.parse(out.stdout).policyApplied, false);
    }
  },
);

test(
  "rule byte hashes do not depend on inventory row ordering",
  { skip: !available },
  () => {
    const a = fixture();
    const b = { ...a, hostIPv4: [...a.hostIPv4].reverse() };
    const left = rendered(a),
      right = rendered(b);
    assert.equal(left.ipv4Sha256, right.ipv4Sha256);
    assert.equal(left.ipv6Sha256, right.ipv6Sha256);
  },
);
