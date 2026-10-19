// Offline PS5 AST fixtures only; native operations and private evidence are
// mocked. No VM, network, credential or production operation is executed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/Set-CityGoCanaryNetwork.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const allowedEnvironment = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "PATH",
  "TEMP",
  "TMP",
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    allowedEnvironment.has(key.toUpperCase()),
  ),
);
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    env,
    windowsHide: true,
    timeout: 10_000,
  }).status === 0;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

function run(command) {
  const input = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse_failed'}
foreach($definition in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 . ([scriptblock]::Create($definition.Extent.Text))
}
$testLibraryLocks=@()
try {
 foreach($library in @(Get-CityGoCanaryNetworkLibraries)){
  $loaded=Open-CityGoCanaryNetworkLibrary ${quote(dirname(script))} $library;$testLibraryLocks+=,$loaded
  foreach($definition in $loaded.definitions){. ([scriptblock]::Create($definition))}
 }
 ${command}
} finally {foreach($loaded in $testLibraryLocks){$loaded.stream.Dispose()}}
`;
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(input, "utf16le").toString("base64"),
    ],
    { env, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const operationId = "12345678-1234-4234-8234-123456789abc";
const vmId = "33333333-3333-4333-8333-333333333333";
const nicGuid = "44444444-4444-4444-8444-444444444444";
const nicId = `Microsoft:${vmId}\\${nicGuid.toUpperCase()}`;
const switchId = "55555555-5555-4555-8555-555555555555";
const control = `D:\\CityGo-CI\\control\\${operationId}`;
const targetDirectory = `D:\\CityGo-CI\\canaries\\${operationId}`;
const manifest = {
  schemaVersion: 1,
  scope: "local_canary_creation",
  operationId,
  vmName: `citygo-ci-canary-${operationId}`,
  vmId,
  nicId,
  nicName: "Сетевой адаптер",
  targetDirectory,
  targetVhdx: `${targetDirectory}\\canary.vhdx`,
  vmPath: `${targetDirectory}\\citygo-ci-canary-${operationId}`,
  diskIdentifier: "66666666-6666-4666-8666-666666666666",
  diskSizeBytes: 96 * 1024 ** 3,
  diskFormat: "VHDX",
  diskType: "Dynamic",
  controllerType: "SCSI",
  controllerNumber: 0,
  controllerLocation: 0,
  sourceBaseSha256: "a".repeat(64),
  sealedBaseEvidenceSha256: "b".repeat(64),
  preflightSha256: "c".repeat(64),
  stage: "created_off_disconnected",
  directoryCreated: true,
  diskVerified: true,
  vmCreated: true,
  guestIsolationVerified: false,
  githubRunnerRegistered: false,
};
const inventory = {
  schemaVersion: 1,
  capturedAt: "2026-10-19T03:00:00Z",
  operationId,
  vmId,
  guestAdapterId: nicId,
  guestAdapterName: manifest.nicName,
  switchId,
  switchName: "Default Switch",
  switchType: "Internal",
  switchKind: "DefaultSwitch",
  gatewayCidr: "172.29.192.1/20",
  capturedDhcpServerIPv4: "172.29.192.1",
  hostIPv4: ["127.0.0.1", "172.29.192.1", "192.168.50.10", "45.67.89.10"],
  lanVpnPrefixes: ["192.168.50.0/24", "45.60.0.0/16"],
  productionIPv4: ["80.90.100.110"],
  productionDnsIPv4: ["80.90.100.110"],
  productionDnsIPv6: [],
  routeFingerprintSha256: "d".repeat(64),
  inventoriesComplete: true,
  guestNicCount: 1,
  natVerified: true,
  macSpoofingEnabled: false,
  dhcpGuardEnabled: true,
  routerGuardEnabled: true,
  sriovEnabled: false,
  devicePassthroughEnabled: false,
  extendedAclSupported: true,
  statefulAclSupported: true,
  ipv6AclSupported: true,
  idleSessionTimeoutSupported: true,
};
const request = {
  inventoryPath: `${control}\\canary-network-inventory.json`,
  inventorySha256: "e".repeat(64),
  manifestPath: `${control}\\canary-creation.json`,
  manifestSha256: "f".repeat(64),
  apply: false,
  acknowledge: "",
};
const fixture = (i = inventory, m = manifest, r = request) => `
$i=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(i))}
$m=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(m))}
$r=@{}; (ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(r))}).PSObject.Properties|ForEach-Object{$r[$_.Name]=$_.Value}
$now=[datetime]'2026-10-19T03:00:10Z'
`;
const refusal = (i, m = manifest, r = request) =>
  run(`${fixture(i, m, r)}
try{$null=Get-CityGoCanaryNetworkPlan $i $m $r $now;throw 'unexpected_success'}catch{$_.Exception.Message|ConvertTo-Json -Compress}`);

test("entrypoint has no VM start/stop/delete, global networking, runner or arbitrary helper execution", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Remove-Item|New-NetNat|Set-NetFirewall\w*|Remove-VMNetworkAdapterExtendedAcl)\b/,
  );
  assert.doesNotMatch(
    source,
    /&\s*\$|\.\s*\$path|Invoke-Expression|Start-Process/,
  );
  assert.match(source, /guestIsolationVerified=\$false/);
  assert.match(source, /githubJobsAuthorized=\$false/);
  assert.match(source, /FileShare\]::Read/);
  assert.match(source, /FileMode\]::Open/);
  assert.equal((source.match(/sha='[a-f0-9]{64}'/g) || []).length, 3);
  for (const name of [
    "New-CityGoRunnerNetworkPlan.ps1",
    "Set-CityGoBootstrapNetwork.ps1",
    "Remove-CityGoCanaryVm.ps1",
  ]) {
    assert.ok(readFileSync(join(dirname(script), name)).length < 131072);
  }
});

test(
  "exact library pins load function definitions only; tampered pin refuses",
  { skip: !available },
  () => {
    assert.equal(
      run(`$library=(Get-CityGoCanaryNetworkLibraries)[0];$library.sha='0'*64
try{$null=Open-CityGoCanaryNetworkLibrary ${quote(dirname(script))} $library;throw 'unexpected_success'}catch{$_.Exception.Message|ConvertTo-Json -Compress}`),
      "library_hash_mismatch",
    );
  },
);

test(
  "offline proposal retains full native NIC and final CI rules, with no SSH/candidate",
  { skip: !available },
  () => {
    const result = run(
      `${fixture()}Get-CityGoCanaryNetworkPlan $i $m $r $now|ConvertTo-Json -Depth 8 -Compress`,
    );
    assert.equal(result.adapterId, nicId);
    assert.equal(result.vmId, vmId);
    assert.equal(result.scope, "owned_canary_direct_ip_network_policy");
    assert.equal(result.resultPath, `${control}\\canary-network-result.json`);
    assert.ok(
      result.rules.every((rule) => rule.Weight >= 1 && rule.Weight <= 65535),
    );
    assert.equal(
      result.rules.filter(
        (rule) => rule.Protocol === "UDP" && rule.LocalPort === "68",
      ).length,
      3,
    );
    assert.equal(
      result.rules.filter(
        (rule) => rule.Action === "Allow" && rule.Direction === "Inbound",
      ).length,
      1,
    );
    assert.ok(
      result.rules.some(
        (rule) =>
          rule.RemoteIPAddress === "::/0" &&
          rule.Action === "Deny" &&
          rule.Direction === "Outbound",
      ),
    );
    assert.ok(
      !result.rules.some(
        (rule) => rule.LocalPort === "22" || rule.RemotePort === "22",
      ),
    );
  },
);

test(
  "unknown fields, candidate DHCP, stale capture, foreign native NIC and partial manifests refuse",
  { skip: !available },
  () => {
    assert.equal(
      refusal({
        ...inventory,
        bootstrapCandidateDhcpMode: "hns_gateway_candidate",
      }),
      "evidence_keys_invalid",
    );
    assert.equal(
      refusal({ ...inventory, capturedDhcpServerIPv4: null }),
      "dhcp_server_unverified",
    );
    assert.equal(
      refusal({ ...inventory, capturedAt: "2026-10-19T02:00:00Z" }),
      "inventory_not_fresh",
    );
    assert.equal(
      refusal({ ...inventory, guestAdapterId: nicGuid }),
      "inventory_creation_binding_mismatch",
    );
    assert.equal(
      refusal(inventory, { ...manifest, vmCreated: false }),
      "complete_creation_manifest_required",
    );
    assert.equal(
      refusal({ ...inventory, switchKind: "ExplicitNat" }),
      "only_existing_default_switch_admitted",
    );
  },
);

test(
  "production DNS must be denied; DHCP production collision and bad route fingerprint refuse",
  { skip: !available },
  () => {
    assert.equal(
      refusal({ ...inventory, productionDnsIPv4: ["80.90.100.111"] }),
      "production_dns_not_denied",
    );
    assert.equal(
      refusal({
        ...inventory,
        productionIPv4: [
          ...inventory.productionIPv4,
          inventory.capturedDhcpServerIPv4,
        ],
      }),
      "dhcp_production_collision",
    );
    assert.equal(
      refusal({ ...inventory, routeFingerprintSha256: "not-a-hash" }),
      "route_fingerprint_required",
    );
    assert.equal(
      refusal({ ...inventory, productionDnsIPv6: ["not-ipv6"] }),
      "production_dns_ipv6_invalid",
    );
  },
);

const nativeFresh = `
function Get-NetIPAddress {param($AddressFamily,$ErrorAction) foreach($address in $i.hostIPv4){[pscustomobject]@{IPAddress=$address}}}
function Get-CityGoCanaryRouteFingerprint {return ('d'*64)}
function Get-VMSwitch {param($Id,$ErrorAction) [pscustomobject]@{Id=[guid]$i.switchId;Name='Default Switch';SwitchType='Internal';IovEnabled=$false}}
function Get-HnsNetwork {param($ErrorAction) [pscustomobject]@{ID=$i.switchId;Name='Default Switch';Type='ICS';Subnets=@([pscustomobject]@{AddressPrefix='172.29.192.0/20';GatewayAddress='172.29.192.1'})}}
function Resolve-DnsName {param($Name,$Type,[switch]$DnsOnly,[switch]$NoHostsFile,$ErrorAction) if($Name -cnotin @('app.xn--c1ajazlh.xn--p1ai','pilot.xn--c1ajazlh.xn--p1ai')){throw 'foreign_dns'};[pscustomobject]@{Type='A';IPAddress='80.90.100.110'}}
`;
test(
  "fresh readback binds actual host/routes/HNS/current production DNS",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${nativeFresh}
$p=Get-CityGoCanaryNetworkPlan $i $m $r $now
$s=Assert-CityGoCanaryFreshNetwork $i $p $now
$errors=@()
function Get-CityGoCanaryRouteFingerprint {return ('1'*64)}
try{$null=Assert-CityGoCanaryFreshNetwork $i $p $now}catch{$errors+=,$_.Exception.Message}
function Get-CityGoCanaryRouteFingerprint {return ('d'*64)}
function Get-HnsNetwork {param($ErrorAction) [pscustomobject]@{ID=$i.switchId;Name='Default Switch';Type='ICS';Subnets=@([pscustomobject]@{AddressPrefix='172.30.0.0/20';GatewayAddress='172.30.0.1'})}}
try{$null=Assert-CityGoCanaryFreshNetwork $i $p $now}catch{$errors+=,$_.Exception.Message}
@{name=$s.Name;errors=$errors}|ConvertTo-Json -Compress`);
    assert.equal(result.name, "Default Switch");
    assert.deepEqual(result.errors, [
      "host_routes_changed",
      "hns_subnet_changed",
    ]);
  },
);

test(
  "fresh readback rejects stale/future capture, changed host addresses and production A/AAAA",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${nativeFresh}
$p=Get-CityGoCanaryNetworkPlan $i $m $r $now;$errors=@()
foreach($time in @([datetime]'2026-10-19T02:59:59Z',[datetime]'2026-10-19T04:00:00Z')){
try{$null=Assert-CityGoCanaryFreshNetwork $i $p $time}catch{$errors+=,$_.Exception.Message}}
function Get-NetIPAddress {param($AddressFamily,$ErrorAction) [pscustomobject]@{IPAddress='127.0.0.1'}}
try{$null=Assert-CityGoCanaryFreshNetwork $i $p $now}catch{$errors+=,$_.Exception.Message}
function Get-NetIPAddress {param($AddressFamily,$ErrorAction) foreach($address in $i.hostIPv4){[pscustomobject]@{IPAddress=$address}}}
function Resolve-DnsName {param($Name,$Type,[switch]$DnsOnly,[switch]$NoHostsFile,$ErrorAction) [pscustomobject]@{Type='AAAA';IPAddress='2001:db8::1'}}
try{$null=Assert-CityGoCanaryFreshNetwork $i $p $now}catch{$errors+=,$_.Exception.Message}
ConvertTo-Json -InputObject $errors -Compress`);
    assert.deepEqual(result, [
      "inventory_expired",
      "inventory_expired",
      "host_ipv4_changed",
      "production_dns_changed",
    ]);
  },
);

test(
  "route digest is order independent, includes both families, and excludes only Dead rows",
  { skip: !available },
  () => {
    const result = run(`
$global:routeOrder=$false
function Get-NetRoute {param($PolicyStore,$ErrorAction)
 $rows=@([pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=2;DestinationPrefix='0.0.0.0/0';NextHop='192.168.1.1';RouteMetric=10;Protocol='NetMgmt';State='Alive'},
 [pscustomobject]@{AddressFamily='IPv6';InterfaceIndex=2;DestinationPrefix='::/0';NextHop='fe80::1';RouteMetric=10;Protocol='NetMgmt';State='Alive'},
 [pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=2;DestinationPrefix='10.0.0.0/8';NextHop='192.168.1.2';RouteMetric=10;Protocol='NetMgmt';State='Dead'})
 if($global:routeOrder){[array]::Reverse($rows)};$rows
}
$a=Get-CityGoCanaryRouteFingerprint;$global:routeOrder=$true;$b=Get-CityGoCanaryRouteFingerprint
@{a=$a;b=$b}|ConvertTo-Json -Compress`);
    assert.match(result.a, /^[a-f0-9]{64}$/);
    assert.equal(result.a, result.b);
  },
);

const applyMocks = `
$global:events=[Collections.Generic.List[string]]::new();$global:acl=[Collections.Generic.List[object]]::new();$global:connected=$false
$nic=[pscustomobject]@{Id=$i.guestAdapterId;VMId=[guid]$i.vmId;Name=$i.guestAdapterName}
$sw=[pscustomobject]@{Id=[guid]$i.switchId;Name='Default Switch'}
function Get-CityGoNetworkOwnerSid {param($RequireAdministrator) 'S-1-5-21-test'}
function Assert-CityGoNetworkPlainPath {param($Path) }
function Assert-CityGoNetworkPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory) }
function Test-Path {param($LiteralPath,$ErrorAction) $false}
function Assert-CityGoCanaryNetworkCapabilities {$global:events.Add('capabilities')}
function Get-CityGoCanaryNetworkAdapter {param($Plan,$Connected) if($Connected -ne $global:connected){throw 'mock_wrong_connection'};$global:events.Add('owned');$nic}
function Assert-CityGoCanaryFreshNetwork {param($Inventory,$Plan) $global:events.Add('fresh');$sw}
function Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction) $global:acl.ToArray()}
function Add-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$Action,$Direction,$LocalIPAddress,$RemoteIPAddress,$Weight,$Stateful,$Protocol='ANY',$LocalPort=$null,$RemotePort=$null,$IdleSessionTimeout=255,$ErrorAction)
 if($VMNetworkAdapter.Id -cne $nic.Id){throw 'wrong_adapter'};$global:events.Add('add')
 $global:acl.Add([pscustomobject]@{ParentAdapter=$nic;Action=$Action;Direction=$Direction;LocalIPAddress=$LocalIPAddress;RemoteIPAddress=$RemoteIPAddress;Weight=$Weight;Stateful=$Stateful;Protocol=$Protocol;LocalPort=$LocalPort;RemotePort=$RemotePort;IdleSessionTimeout=$IdleSessionTimeout;IsolationID=0;IsTemplate=$false;IsDeleted=$false})
}
function Connect-VMNetworkAdapter {param($VMNetworkAdapter,$VMSwitch,$ErrorAction) if($global:acl.Count -lt 1){throw 'connected_without_acl'};$global:events.Add('connect');$global:connected=$true}
function Disconnect-CityGoExactOwnedBootstrapNic {param($Plan) $global:events.Add('disconnect');$global:connected=$false}
function Write-CityGoBootstrapNetworkResult {param($Plan,$Result,$OwnerSid) $global:events.Add('receipt')}
$r.apply=$true;$p=Get-CityGoCanaryNetworkPlan $i $m $r $now;$r.acknowledge=$p.requiredAcknowledgement
`;
test(
  "apply adds all owned ACLs before connect, readbacks twice and never admits jobs",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
$result=Invoke-CityGoCanaryNetwork $i $m $r $now
@{result=$result;events=@($global:events.ToArray());aclCount=$global:acl.Count;connected=$global:connected}|ConvertTo-Json -Depth 8 -Compress`);
    assert.equal(
      result.result.stage,
      "ci_policy_connected_vm_off_acceptance_pending",
    );
    assert.equal(result.connected, true);
    assert.equal(result.result.guestIsolationVerified, false);
    assert.equal(result.result.githubJobsAuthorized, false);
    assert.equal(result.result.vmStarted, false);
    assert.ok(result.aclCount > 40);
    assert.ok(
      result.events.lastIndexOf("add") < result.events.indexOf("connect"),
    );
    assert.equal(result.events.filter((event) => event === "fresh").length, 3);
  },
);

test(
  "wrong acknowledgement or existing ACL refuses before writes/connect",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
$r.acknowledge='wrong';$errors=@()
try{$null=Invoke-CityGoCanaryNetwork $i $m $r $now}catch{$errors+=,$_.Exception.Message}
$r.acknowledge=$p.requiredAcknowledgement
function Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction) [pscustomobject]@{foreign=$true}}
try{$null=Invoke-CityGoCanaryNetwork $i $m $r $now}catch{$errors+=,$_.Exception.Message}
@{errors=$errors;events=@($global:events.ToArray())}|ConvertTo-Json -Compress`);
    assert.deepEqual(result.errors, [
      "typed_acknowledgement_required",
      "existing_extended_acl_refused",
    ]);
    assert.ok(!result.events.includes("add"));
    assert.ok(!result.events.includes("connect"));
  },
);

test(
  "partial add failure disconnects exact owned NIC and preserves ACL/result, no replacement",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
function Add-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$Action,$Direction,$LocalIPAddress,$RemoteIPAddress,$Weight,$Stateful,$Protocol,$LocalPort,$RemotePort,$IdleSessionTimeout,$ErrorAction) $global:events.Add('add');throw 'synthetic_add_refused'}
$result=Invoke-CityGoCanaryNetwork $i $m $r $now
@{result=$result;events=@($global:events.ToArray());connected=$global:connected}|ConvertTo-Json -Compress`);
    assert.equal(result.result.stage, "failed_disconnected_acl_preserved");
    assert.equal(result.result.failurePhase, "add_owned_acl");
    assert.equal(result.connected, false);
    assert.ok(result.events.includes("disconnect"));
    assert.ok(!result.events.includes("connect"));
  },
);

test(
  "full native ACL readback rejects missing/foreign entries before connect",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
function Assert-CityGoBootstrapAclReadback {param($Adapter,$Plan) throw 'acl_readback_owner_invalid'}
$result=Invoke-CityGoCanaryNetwork $i $m $r $now
@{result=$result;events=@($global:events.ToArray())}|ConvertTo-Json -Compress`);
    assert.equal(result.result.failurePhase, "readback_owned_acl");
    assert.equal(result.result.stage, "failed_disconnected_acl_preserved");
    assert.ok(!result.events.includes("connect"));
  },
);

test(
  "network drift after adding policy disconnects without connecting",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
$global:freshCalls=0
function Assert-CityGoCanaryFreshNetwork {param($Inventory,$Plan) $global:freshCalls++;if($global:freshCalls -gt 1){throw 'host_routes_changed'};$sw}
$result=Invoke-CityGoCanaryNetwork $i $m $r $now
@{result=$result;events=@($global:events.ToArray())}|ConvertTo-Json -Compress`);
    assert.equal(result.result.stage, "failed_disconnected_acl_preserved");
    assert.equal(result.result.failureCode, "host_routes_changed");
    assert.ok(!result.events.includes("connect"));
  },
);

test(
  "post-connect readback failure disconnects and never claims verified isolation",
  { skip: !available },
  () => {
    const result = run(`${fixture()}${applyMocks}
function Assert-CityGoBootstrapAclReadback {param($Adapter,$Plan) if($global:connected){throw 'acl_readback_missing'}}
$result=Invoke-CityGoCanaryNetwork $i $m $r $now
@{result=$result;events=@($global:events.ToArray());connected=$global:connected}|ConvertTo-Json -Compress`);
    assert.equal(result.result.stage, "failed_disconnected_acl_preserved");
    assert.equal(result.result.failurePhase, "readback_connected_policy");
    assert.equal(result.result.guestIsolationVerified, false);
    assert.equal(result.connected, false);
    assert.ok(
      result.events.indexOf("connect") < result.events.indexOf("disconnect"),
    );
  },
);

test(
  "native binder requires exact Off/configuration/disk/NIC/firmware and no bypasses",
  { skip: !available },
  () => {
    const result = run(`${fixture()}
$p=Get-CityGoCanaryNetworkPlan $i $m $r $now
$vm=[pscustomobject]@{Id=[guid]$m.vmId;Name=$m.vmName;Path=$m.vmPath;State='Off';Generation=2;ProcessorCount=4;MemoryStartup=6GB;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false}
$nic=[pscustomobject]@{Id=$m.nicId;VMId=[guid]$m.vmId;Name=$m.nicName;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovQueuePairsAssigned=0;IovUsage=0;PortMirroringMode='None';AllowTeaming='Off';SwitchId=[guid]::Empty;SwitchName=''}
$disk=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath='';Attached=$false;Size=96GB;FileSize=1;DiskIdentifier=$m.diskIdentifier}
$firmware=[pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory)}
function Test-Path {param($LiteralPath,$ErrorAction) $true}
function Get-VM {param($ErrorAction) $vm}
function Get-VMHardDiskDrive {param($VM,$ErrorAction) [pscustomobject]@{Path=$m.targetVhdx;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}}
function Get-VMNetworkAdapter {param($VM,$ErrorAction) $nic}
function Get-VMSnapshot {param($VM,$ErrorAction)}
function Get-VMAssignableDevice {param($VM,$ErrorAction)}
function Get-VHD {param($Path,$ErrorAction) $disk}
function Get-VMFirmware {param($VM,$ErrorAction) $firmware}
function Get-VMNetworkAdapterVlan {param($VMNetworkAdapter,$ErrorAction) [pscustomobject]@{OperationMode='Untagged'}}
function Get-VMNetworkAdapterIsolation {param($VMNetworkAdapter,$ErrorAction) [pscustomobject]@{IsolationMode='None'}}
function Get-VMNetworkAdapterAcl {param($VMNetworkAdapter,$ErrorAction)}
$valid=Get-CityGoCanaryNetworkAdapter $p $false;$errors=@()
$vm.State='Running';try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$vm.State='Off'
$vm.ProcessorCount=8;try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$vm.ProcessorCount=4
$firmware.SecureBoot='Off';try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$firmware.SecureBoot='On'
$nic.MacAddressSpoofing='On';try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$nic.MacAddressSpoofing='Off'
$nic.SwitchId=[guid]$i.switchId;$nic.SwitchName='Default Switch';try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$nic.SwitchId=[guid]::Empty;$nic.SwitchName=''
$disk.DiskIdentifier='77777777-7777-4777-8777-777777777777';try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message};$disk.DiskIdentifier=$m.diskIdentifier
function Get-VMNetworkAdapterAcl {param($VMNetworkAdapter,$ErrorAction) [pscustomobject]@{foreign=$true}}
try{$null=Get-CityGoCanaryNetworkAdapter $p $false}catch{$errors+=,$_.Exception.Message}
@{id=$valid.Id;errors=$errors}|ConvertTo-Json -Compress`);
    assert.equal(result.id, nicId);
    assert.deepEqual(result.errors, [
      "owned_vm_changed_or_not_off",
      "owned_canary_configuration_changed",
      "owned_canary_firmware_changed",
      "owned_canary_nic_changed",
      "owned_canary_already_connected",
      "disk_identity_or_state_changed",
      "owned_canary_vlan_or_legacy_acl_changed",
    ]);
  },
);

test(
  "resumed creation chain is checked/read-locked before any native action and disposed on refusal",
  { skip: !available },
  () => {
    const initial = {
      ...manifest,
      vmId: null,
      nicId: null,
      nicName: null,
      diskIdentifier: null,
      diskType: null,
      stage: "failed_preserved_state_unverified",
      diskVerified: false,
      vmCreated: false,
    };
    const resumed = {
      ...manifest,
      initialCreationReceiptSha256: "1".repeat(64),
      resumeVerificationSha256: "2".repeat(64),
    };
    const proof = {
      schemaVersion: 1,
      scope: "verified_owned_copy_before_resume",
      operationId,
      initialCreationReceiptSha256: resumed.initialCreationReceiptSha256,
      sourceBaseSha256: manifest.sourceBaseSha256,
      targetSha256: manifest.sourceBaseSha256,
      sourceDiskIdentifier: "77777777-7777-4777-8777-777777777777",
      targetDiskIdentifier: "77777777-7777-4777-8777-777777777777",
      noVmOrReferencesObserved: true,
      sourceVmOff: true,
      targetStandaloneUnattached: true,
      targetTreeOnlyDisk: true,
      guestIsolationVerified: false,
      githubRunnerRegistered: false,
      ciJobsAdmitted: false,
    };
    const result =
      run(`${fixture(inventory, resumed, { ...request, manifestPath: `${control}\\canary-resume-creation.json` })}
$initial=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(initial))}
$proof=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(proof))}
$global:streams=[Collections.Generic.List[object]]::new();$global:reads=[Collections.Generic.List[string]]::new();$global:native=0
function Get-CityGoNetworkOwnerSid {param($RequireAdministrator) 'S-1-5-21-test'}
function Read-CityGoBootstrapNetworkEvidence {param($Path,$ExpectedHash,$OwnerSid)
 $global:reads.Add($Path);$s=[IO.MemoryStream]::new();$global:streams.Add($s)
 if($Path -ceq ${quote(`${control}\\canary-creation.json`)} -and $ExpectedHash -ceq ('1'*64)){return @{value=$initial;stream=$s}}
 if($Path -ceq ${quote(`${control}\\canary-resume-verification.json`)} -and $ExpectedHash -ceq ('2'*64)){return @{value=$proof;stream=$s}}
 throw 'wrong_evidence_binding'
}
function Get-CityGoCanaryNetworkAdapter {param($Plan,$Connected) $global:native++;throw 'native_should_not_run'}
$ok=Invoke-CityGoCanaryNetwork $i $m $r $now
$proof.targetTreeOnlyDisk=$false
try{$null=Invoke-CityGoCanaryNetwork $i $m $r $now;throw 'unexpected_success'}catch{$code=$_.Exception.Message}
@{stage=$ok.stage;code=$code;native=$global:native;readCount=$global:reads.Count;liveStreams=@($global:streams.ToArray()|Where-Object{$_.CanRead}).Count}|ConvertTo-Json -Compress`);
    assert.equal(result.stage, "plan_only_unverified");
    assert.equal(result.code, "resume_verification_step_unverified");
    assert.equal(result.native, 0);
    assert.equal(result.readCount, 4);
    assert.equal(result.liveStreams, 0);
  },
);
