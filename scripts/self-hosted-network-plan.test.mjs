// Synthetic offline fixtures only. No elevation, VM/network query/mutation,
// provider calls, keys or actual inventory; AST-checked functions run unprivileged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/New-CityGoRunnerNetworkPlan.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell =
  process.platform === "win32"
    ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    : "pwsh";
const allowedEnvironment = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "PATH",
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    allowedEnvironment.has(key.toUpperCase()),
  ),
);
const probe = spawnSync(
  shell,
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ],
  { env, encoding: "utf8", windowsHide: true },
);
const available = probe.status === 0;
const directory = mkdtempSync(join(tmpdir(), "citygo-network-plan-synthetic-"));
test.after(() => {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(
    directory.split(/[\\/]/).at(-1),
    /^citygo-network-plan-synthetic-/,
  );
  rmSync(directory, { recursive: true, force: true });
});
let serial = 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const bootstrap = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'parse_failed'}
$allowed=@('Assert-CityGoNetworkValue','ConvertTo-CityGoIPv4','ConvertTo-CityGoIPv4Text','Get-CityGoIPv4Range','Get-CityGoStringArray','Read-CityGoNetworkInventory','Add-CityGoNetworkRule','Get-CityGoRunnerNetworkPlan','Get-Item','Get-Command','ConvertFrom-Json','ConvertTo-Json','Sort-Object','ForEach-Object','Where-Object')
foreach($command in @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst]},$true))){if($command.GetCommandName() -cnotin $allowed){throw 'unexpected_command'}}
foreach($definition in @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true))){. ([scriptblock]::Create($definition.Extent.Text))}
`;

function powershell(command) {
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(bootstrap + command, "utf16le").toString("base64"),
    ],
    { env, encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

function fixture(changes = {}) {
  return {
    schemaVersion: 1,
    capturedAt: new Date(Date.now() - 5_000).toISOString(),
    switchId: "11111111-1111-4111-8111-111111111111",
    switchType: "Internal",
    switchKind: "ExplicitNat",
    gatewayCidr: "172.29.192.1/20",
    natVerified: true,
    hostIPv4: ["127.0.0.1", "172.29.192.1", "192.168.50.10", "45.67.89.10"],
    lanVpnPrefixes: ["192.168.50.0/24", "45.60.0.0/16"],
    productionIPv4: ["80.90.100.110"],
    inventoriesComplete: true,
    guestNicCount: 1,
    guestAdapterId: "22222222-2222-4222-8222-222222222222",
    macSpoofingEnabled: false,
    dhcpGuardEnabled: true,
    routerGuardEnabled: true,
    sriovEnabled: false,
    devicePassthroughEnabled: false,
    extendedAclSupported: true,
    statefulAclSupported: true,
    ipv6AclSupported: true,
    idleSessionTimeoutSupported: true,
    capturedDhcpServerIPv4: null,
    ...changes,
  };
}

function plan(input = fixture(), options = {}) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const path = join(directory, `inventory-${++serial}.json`);
  writeFileSync(path, raw);
  return powershell(`
try {
  $inventory=Read-CityGoNetworkInventory ${quote(path)} ${quote(options.sha ?? digest(raw))}
  Get-CityGoRunnerNetworkPlan $inventory ${quote(options.sha ?? digest(raw))} ([datetime]::UtcNow) | ConvertTo-Json -Depth 12 -Compress
} catch {
  $code='details_hidden'; if($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$'){$code=$_.Exception.Message}
  [ordered]@{planValid=$false;readyForApply=$false;guestIsolationVerified=$false;changedHostConfiguration=$false;blockers=@($code);rules=@()} | ConvertTo-Json -Depth 3 -Compress
}
`);
}

function ipv4(ip) {
  return ip.split(".").reduce((number, part) => number * 256 + Number(part), 0);
}
function contains(cidr, ip) {
  if (cidr === "ANY") return true;
  if (cidr === "::/0") return ip.includes(":");
  if (ip.includes(":")) return false;
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base) / size);
}
function decide(
  plan,
  {
    direction = "Outbound",
    remote,
    local = "172.29.192.2",
    protocol = "TCP",
    remotePort = "443",
    localPort = "45000",
  },
) {
  return [...plan.rules]
    .sort((a, b) => b.weight - a.weight)
    .find(
      (rule) =>
        rule.direction === direction &&
        contains(rule.remoteIPAddress, remote) &&
        contains(rule.localIPAddress, local) &&
        (rule.protocol === "ANY" || rule.protocol === protocol) &&
        (rule.remotePort === null || rule.remotePort === remotePort) &&
        (rule.localPort === null || rule.localPort === localPort),
    );
}

test("planner source is offline-only, not an apply/registration or network tool", () => {
  assert.doesNotMatch(
    source,
    /^\s*(?:Start-Process|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod|Get-VM|Get-NetNat|New-NetNat|New-VMSwitch|Add-VMNetworkAdapterExtendedAcl|Set-NetFirewall|Register-ObjectEvent|ssh(?:\.exe)?|docker(?:\.exe)?)\b/im,
  );
  assert.doesNotMatch(
    source,
    /\$env:|\b(?:ExecutionPolicy|Bypass|Unrestricted|WriteAll|Write-Host|Out-File|Set-Content|Remove-Item)\b|\.Start\(/i,
  );
  assert.match(source, /readyForApply=\$false/);
  assert.match(source, /guestIsolationVerified=\$false/);
});

test(
  "explicit NAT emits only a private, unapplied exact-vNIC proposal",
  { skip: !available },
  () => {
    const result = plan();
    assert.equal(result.planValid, true, JSON.stringify(result));
    assert.equal(result.readyForApply, false);
    assert.equal(result.guestIsolationVerified, false);
    assert.equal(result.changedHostConfiguration, false);
    assert.equal(result.githubJobsAuthorized, false);
    assert.equal(result.target, "exact_guest_vnic_not_management_os");
    assert.equal(result.containsPrivateNetworkMetadata, true);
    assert.equal(
      new Set(result.rules.map((rule) => rule.weight)).size,
      result.rules.length,
    );
    assert.ok(
      result.rules.every(
        (rule, index) =>
          Number.isInteger(rule.weight) &&
          rule.weight >= 1 &&
          rule.weight <= 65_535 &&
          (index === 0 || result.rules[index - 1].weight > rule.weight),
      ),
    );
    assert.equal(
      result.rules.filter((rule) => rule.action === "Allow").length,
      6,
    );
    assert.equal(decide(result, { remote: "93.100.120.130" }).action, "Allow");
    assert.equal(
      decide(result, { remote: "93.100.120.130", remotePort: "80" }).action,
      "Allow",
    );
    for (const protocol of ["UDP", "TCP"]) {
      for (const remote of ["1.1.1.1", "8.8.8.8"])
        assert.equal(
          decide(result, { remote, protocol, remotePort: "53" }).action,
          "Allow",
        );
    }
    for (const packet of [
      { remote: "9.9.9.9", remotePort: "53", protocol: "UDP" },
      { remote: "93.100.120.130", remotePort: "22" },
      { remote: "93.100.120.130", protocol: "UDP" },
      { remote: "93.100.120.130", direction: "Inbound" },
      { remote: "93.100.120.130", local: "10.0.0.2" },
    ]) {
      assert.equal(decide(result, packet).action, "Deny");
    }
    for (const rule of result.rules.filter((rule) => rule.action === "Allow")) {
      assert.equal(rule.direction, "Outbound");
      assert.equal(rule.stateful, true);
      assert.ok([30, 300].includes(rule.idleSessionTimeout));
    }
    assert.match(result.limitations.join(" "), /DoH.*indirect production/);
  },
);

test(
  "special/LAN/VPN/host/production denies outrank web and DNS, IPv6 is entirely closed",
  { skip: !available },
  () => {
    const result = plan(
      fixture({ productionIPv4: ["80.90.100.110", "1.1.1.1"] }),
    );
    assert.equal(result.planValid, true);
    for (const remote of [
      "0.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.0",
      "172.31.255.255",
      "192.0.0.9",
      "192.0.2.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.88.99.1",
      "192.175.48.1",
      "192.168.50.30",
      "198.18.0.0",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "168.63.129.16",
      "45.67.89.10",
      "45.60.255.254",
      "80.90.100.110",
    ]) {
      for (const direction of ["Inbound", "Outbound"])
        assert.equal(
          decide(result, { remote, direction }).action,
          "Deny",
          `${remote} ${direction}`,
        );
    }
    for (const protocol of ["UDP", "TCP"])
      assert.equal(
        decide(result, { remote: "1.1.1.1", remotePort: "53", protocol })
          .action,
        "Deny",
      );
    for (const remote of [
      "::",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "2001:4860:4860::8888",
      "::ffff:127.0.0.1",
      "2002:7f00:1::1",
    ]) {
      for (const direction of ["Inbound", "Outbound"])
        assert.equal(decide(result, { remote, direction }).action, "Deny");
    }
  },
);

test(
  "Default Switch requires captured DHCP identity and admits only narrow broadcast, exact-server renewal and reply",
  { skip: !available },
  () => {
    assert.equal(
      plan(fixture({ switchKind: "DefaultSwitch" })).planValid,
      false,
    );
    const result = plan(
      fixture({
        switchKind: "DefaultSwitch",
        capturedDhcpServerIPv4: "172.29.192.1",
      }),
    );
    assert.equal(result.planValid, true, JSON.stringify(result));
    const packet = {
      remote: "255.255.255.255",
      local: "0.0.0.0",
      protocol: "UDP",
      localPort: "68",
      remotePort: "67",
    };
    assert.equal(decide(result, packet).action, "Allow");
    assert.equal(decide(result, { ...packet, localPort: "69" }).action, "Deny");
    assert.equal(
      decide(result, {
        ...packet,
        remote: "172.29.192.1",
        local: "172.29.192.2",
      }).action,
      "Allow",
    );
    for (const deniedRenewal of [
      { ...packet, remote: "172.29.192.2", local: "172.29.192.3" },
      { ...packet, remote: "172.29.192.1" },
      {
        ...packet,
        remote: "172.29.192.1",
        local: "172.29.192.2",
        localPort: "69",
      },
      {
        ...packet,
        remote: "172.29.192.1",
        local: "172.29.192.2",
        protocol: "TCP",
      },
    ]) {
      assert.equal(decide(result, deniedRenewal).action, "Deny");
    }
    assert.equal(
      decide(result, {
        remote: "172.29.192.1",
        direction: "Inbound",
        protocol: "UDP",
        remotePort: "67",
        localPort: "68",
      }).action,
      "Allow",
    );
    assert.equal(
      decide(result, {
        remote: "172.29.192.2",
        direction: "Inbound",
        protocol: "UDP",
        remotePort: "67",
        localPort: "68",
      }).action,
      "Deny",
    );
    assert.equal(decide(result, { remote: "172.29.192.1" }).action, "Deny");
    const dhcpRules = result.rules.filter((rule) =>
      rule.name.startsWith("dhcp-"),
    );
    assert.equal(dhcpRules.length, 3);
    assert.deepEqual(
      dhcpRules.map((rule) => [rule.name, rule.weight]),
      [
        ["dhcp-broadcast-request", 64002],
        ["dhcp-exact-server-renewal", 64001],
        ["dhcp-exact-server-reply", 64000],
      ],
    );
    assert.ok(
      dhcpRules.every(
        (rule) =>
          rule.protocol === "UDP" &&
          rule.remotePort === "67" &&
          rule.localPort === "68",
      ),
    );
    assert.ok(
      dhcpRules.every((rule) =>
        ["255.255.255.255/32", "172.29.192.1/32"].includes(
          rule.remoteIPAddress,
        ),
      ),
    );
    assert.ok(
      result.rules.every(
        (rule) =>
          Number.isInteger(rule.weight) &&
          rule.weight >= 1 &&
          rule.weight <= 65_535,
      ),
    );
    assert.ok(
      result.rules.every(
        (rule, index) =>
          index === 0 || result.rules[index - 1].weight > rule.weight,
      ),
    );
    assert.equal(
      result.rules.find((rule) => rule.name === "ipv6-inbound-deny").weight,
      65535,
    );
    assert.equal(
      result.rules.find((rule) => rule.name === "ipv6-outbound-deny").weight,
      65534,
    );
    assert.ok(
      result.rules
        .filter((rule) => rule.name.startsWith("deny-"))
        .every((rule) => rule.weight < 64000 && rule.weight > 5000),
    );
    assert.ok(
      result.rules
        .filter((rule) => rule.name.startsWith("public-tcp-"))
        .every((rule) => rule.weight <= 5000 && rule.weight > 4000),
    );
    assert.ok(
      !result.rules.some(
        (rule) => rule.action === "Allow" && rule.localPort === "22",
      ),
    );
    assert.equal(
      result.rules
        .filter((rule) => rule.name.startsWith("dhcp-"))
        .every((rule) => rule.stateful === false),
      true,
    );
  },
);

test(
  "unknown metadata, NAT, incomplete external route classification and guest bypasses fail closed",
  { skip: !available },
  () => {
    const cases = [
      { natVerified: false },
      { natVerified: "true" },
      { inventoriesComplete: false },
      { guestNicCount: 2 },
      { guestNicCount: true },
      { macSpoofingEnabled: true },
      { macSpoofingEnabled: null },
      { sriovEnabled: true },
      { devicePassthroughEnabled: true },
      { dhcpGuardEnabled: false },
      { routerGuardEnabled: false },
      { extendedAclSupported: false },
      { statefulAclSupported: false },
      { ipv6AclSupported: null },
      { idleSessionTimeoutSupported: false },
      { switchType: "External" },
      { switchKind: "Default" },
      { switchId: "main;echo unsafe" },
      { guestAdapterId: "00000000-0000-0000-0000-000000000000" },
      { hostIPv4: ["127.0.0.1"] },
      { productionIPv4: [] },
      { lanVpnPrefixes: ["0.0.0.0/0"] },
      { capturedDhcpServerIPv4: "172.29.192.1" },
      { switchKind: "DefaultSwitch", capturedDhcpServerIPv4: "192.168.1.1" },
      {
        switchKind: "DefaultSwitch",
        bootstrapCandidateDhcpMode: "hns_gateway_candidate",
        bootstrapCandidateDhcpIPv4: "172.29.192.1",
      },
      { capturedAt: new Date(Date.now() - 901_000).toISOString() },
      { capturedAt: new Date(Date.now() + 60_000).toISOString() },
      { capturedAt: "2026-99-99T00:00:00Z" },
      { unexpected: "never-ignore" },
    ];
    // Batch cases in one PowerShell process; only independently generated files.
    const results = cases.map((change) => {
      const raw = JSON.stringify(fixture(change)),
        path = join(directory, `invalid-${++serial}.json`);
      writeFileSync(path, raw);
      return { path, sha: digest(raw) };
    });
    const packets = Buffer.from(JSON.stringify(results)).toString("base64");
    assert.deepEqual(
      powershell(`$cases=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${packets}')))
$results=@(foreach($case in $cases){try{$i=Read-CityGoNetworkInventory $case.path $case.sha;$p=Get-CityGoRunnerNetworkPlan $i $case.sha ([datetime]::UtcNow);[bool]$p.planValid}catch{$false}})
ConvertTo-Json -InputObject $results -Compress`),
      cases.map(() => false),
    );
  },
);

test(
  "native UInt16 weight bounds reject invalid priorities before appending a rule",
  { skip: !available },
  () => {
    const result = powershell(`
$rejected=@();$rules=[Collections.Generic.List[object]]::new()
foreach($weight in @(-1,0,65536,1000000)){
 try{Add-CityGoNetworkRule $rules 'synthetic' $weight 'Outbound' 'Deny' '0.0.0.0/0';$rejected+=$false}catch{$rejected+=($_.Exception.Message -ceq 'acl_weight_outside_native_range')}
}
Add-CityGoNetworkRule $rules 'lowest' 1 'Outbound' 'Deny' '0.0.0.0/0'
Add-CityGoNetworkRule $rules 'highest' 65535 'Inbound' 'Deny' '::/0'
[ordered]@{rejected=$rejected;weights=@($rules.ToArray()|ForEach-Object{$_.weight})}|ConvertTo-Json -Compress`);
    assert.deepEqual(result.rejected, [true, true, true, true]);
    assert.deepEqual(result.weights, [1, 65_535]);
  },
);

test(
  "raw inventory binding, duplicate/unknown keys and noncanonical IP syntax are rejected",
  { skip: !available },
  () => {
    assert.equal(plan(fixture(), { sha: "0".repeat(64) }).planValid, false);
    const duplicate = JSON.stringify(fixture()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    assert.equal(plan(duplicate).planValid, false);
    assert.equal(
      plan(
        duplicate.replace(
          '"schemaVersion":1,"schemaVersion":1',
          '"schemaVersion":1,"SchemaVersion":1',
        ),
      ).planValid,
      false,
    );
    assert.equal(
      plan(
        JSON.stringify(fixture()).replace(
          '"schemaVersion"',
          '"\\u0073chemaVersion"',
        ),
      ).planValid,
      false,
    );
    assert.equal(
      plan(JSON.stringify(fixture()).replace(/}$/, ",}")).planValid,
      false,
    );
    for (const address of [
      "127.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "256.1.1.1",
      "::ffff:127.0.0.1",
      "1.1.1.1;echo",
      "1.1.1.1\n",
    ]) {
      const result = plan(fixture({ productionIPv4: [address] }));
      assert.equal(result.planValid, false, address);
      assert.equal(result.readyForApply, false);
      assert.deepEqual(result.rules, []);
    }
    assert.equal(
      plan(fixture({ lanVpnPrefixes: ["192.168.50.1/24"] })).planValid,
      false,
    );
  },
);

test(
  "network/device/relative inventory paths fail before any file access",
  { skip: !available },
  () => {
    const paths = [
      "\\\\untrusted.invalid\\inventory.json",
      "//untrusted.invalid/inventory.json",
      "\\\\?\\C:\\inventory.json",
      "C:inventory.json",
      "C:\\inventory.json:stream.json",
      "inventory.json",
      "C:/safe/../inventory.json",
    ];
    const encoded = Buffer.from(JSON.stringify(paths)).toString("base64");
    const result =
      powershell(`function Get-Item { throw 'unexpected_file_access' }
$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
$results=@(foreach($path in $paths){try{Read-CityGoNetworkInventory $path ('a'*64);'unexpected_accept'}catch{$_.Exception.Message}})
ConvertTo-Json -InputObject $results -Compress`);
    assert.deepEqual(
      result,
      paths.map(() => "inventory_path_invalid"),
    );
  },
);
