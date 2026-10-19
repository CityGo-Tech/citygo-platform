// Pure offline, unprivileged fixtures. Only AST-checked function definitions are
// loaded; every Hyper-V / network / filesystem-mutating boundary is mocked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/Set-CityGoBootstrapNetwork.ps1", import.meta.url),
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
$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|ForEach-Object{$_.Name})
$native=@('Add-VMNetworkAdapterExtendedAcl','Connect-VMNetworkAdapter','Disconnect-VMNetworkAdapter',
 'ConvertFrom-Json','ConvertTo-Json','ForEach-Object','Get-Acl','Get-Command','Get-FileHash','Get-Item','Get-NetIPAddress',
 'Get-VM','Get-VMAssignableDevice','Get-VMFirmware','Get-VMHardDiskDrive','Get-VMNetworkAdapter','Get-VMNetworkAdapterAcl',
 'Get-VMNetworkAdapterExtendedAcl','Get-VMNetworkAdapterIsolation','Get-VMNetworkAdapterVlan','Get-VMSwitch','Sort-Object','Test-Path','Where-Object')
foreach($call in $ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)){
 if($call.GetCommandName() -cnotin (@($functions)+$native)){throw 'unreviewed_command'}
}
foreach($definition in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 . ([scriptblock]::Create($definition.Extent.Text))
}
${command}`;
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

const op = "12345678-1234-4234-8234-123456789abc";
const vmId = "33333333-3333-4333-8333-333333333333";
const adapterId =
  "Microsoft:33333333-3333-4333-8333-333333333333\\44444444-4444-4444-8444-444444444444";
const switchId = "55555555-5555-4555-8555-555555555555";
const control = "D:\\CityGo-CI\\control\\" + op;
const inventory = {
  schemaVersion: 1,
  capturedAt: "2026-10-19T03:00:00Z",
  operationId: op,
  vmId,
  vmName: `citygo-ci-base-${op}`,
  guestAdapterId: adapterId,
  guestAdapterName: "Network Adapter",
  switchId,
  switchName: "Default Switch",
  switchType: "Internal",
  switchKind: "DefaultSwitch",
  gatewayCidr: "172.29.192.1/20",
  capturedDhcpServerIPv4: "172.29.192.1",
  bootstrapCandidateDhcpMode: "disabled",
  bootstrapCandidateDhcpIPv4: null,
  hostIPv4: ["127.0.0.1", "172.29.192.1", "192.168.50.10", "45.67.89.10"],
  lanVpnPrefixes: ["192.168.50.0/24", "45.60.0.0/16"],
  productionIPv4: ["80.90.100.110"],
  inventoriesComplete: true,
  guestNicCount: 1,
  macSpoofingEnabled: false,
  dhcpGuardEnabled: true,
  routerGuardEnabled: true,
  sriovEnabled: false,
  devicePassthroughEnabled: false,
  extendedAclSupported: true,
  statefulAclSupported: true,
  ipv6AclSupported: true,
  idleSessionTimeoutSupported: true,
  natVerified: true,
};
const creation = {
  schemaVersion: 1,
  scope: "stopped_bootstrap_vm_only",
  operationId: op,
  vmName: inventory.vmName,
  vmId,
  baseSha256: "a".repeat(64),
  stage: "failed_preserved_receipt_unavailable",
  guestIsolationVerified: false,
  githubRunnerRegistered: false,
};
const verification = {
  version: 1,
  scope: "independent_readonly_bootstrap_verification",
  observedAt: "2026-10-18T01:00:00Z",
  operationId: op,
  vmId,
  state: "Off",
  generation: 2,
  vCpu: 4,
  memoryGiB: 6,
  vhdxGiB: 96,
  vhdxSha256: creation.baseSha256,
  secureBoot: "On",
  secureBootTemplate: "MicrosoftUEFICertificateAuthority",
  nicCount: 1,
  switchConnected: false,
  stage: "verified_off_disconnected_bootstrap_only",
  guestIsolationVerified: false,
  githubRunnerRegistered: false,
  hostConfigurationChanged: false,
  historicalFailedStagingReceiptPreserved: true,
};
function fixture(i = inventory, c = creation, v = verification) {
  return `
$i=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(i))}
$c=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(c))}
$v=ConvertFrom-CityGoBootstrapNetworkJson ${quote(JSON.stringify(v))}
$request=[ordered]@{inventoryPath=${quote(control + "\\network-inventory.json")};inventorySha256=('b'*64);
 creationReceiptPath=${quote(control + "\\result.json")};creationReceiptSha256=('c'*64);
 verificationPath=${quote(control + "\\independent-verification.json")};verificationSha256=('d'*64);apply=$false;acknowledge=''}
$now=[datetime]'2026-10-19T03:05:00Z'
`;
}

const mocks = `
$script:calls=[Collections.Generic.List[string]]::new();$script:acl=[Collections.Generic.List[object]]::new()
$script:fail='';$script:result=$null;$script:wrongReadback=$false
$script:vm=[pscustomobject]@{Id=[guid]$i.vmId;Name=$i.vmName;State='Off';Generation=2;ProcessorCount=4;
 MemoryStartup=6GB;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';
 AutomaticCheckpointsEnabled=$false;Path=('D:\\CityGo-CI\\bootstrap\\'+$i.operationId+'\\'+$i.vmName)}
$script:nic=[pscustomobject]@{Id=$i.guestAdapterId;VMId=[guid]$i.vmId;Name=$i.guestAdapterName;SwitchId=$null;SwitchName='';
 MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovQueuePairsAssigned=0;IovUsage=0;PortMirroringMode='None';AllowTeaming='Off'}
$script:sw=[pscustomobject]@{Id=[guid]$i.switchId;Name='Default Switch';SwitchType='Internal';IovEnabled=$false}
function Track([string]$name){$script:calls.Add($name);if($script:fail -ceq $name){throw 'synthetic_failure'}}
function Get-CityGoNetworkOwnerSid {param($RequireAdministrator);Track 'identity';return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoNetworkPlainPath {param($Path);Track 'plain';return [pscustomobject]@{PSIsContainer=($Path -notlike '*.vhdx')}}
function Assert-CityGoNetworkPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'private'}
function Test-Path {param($LiteralPath,$ErrorAction);Track 'absent';return $false}
function Get-FileHash {param($LiteralPath,$Algorithm,$ErrorAction);Track 'disk_hash';return [pscustomobject]@{Hash=$c.baseSha256}}
function Get-VM {param($Id,$ErrorAction);Track 'get_vm';if($Id -ne $script:vm.Id){throw 'wrong_vm'};return $script:vm}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get_disk';return [pscustomobject]@{Path=('D:\\CityGo-CI\\bootstrap\\'+$i.operationId+'\\bootstrap.vhdx');DiskNumber=$null}}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'firmware';return [pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'devices'}
function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get_nic';return $script:nic}
function Get-VMNetworkAdapterVlan {param($VMNetworkAdapter,$ErrorAction);Track 'vlan';return [pscustomobject]@{OperationMode='Untagged'}}
function Get-VMNetworkAdapterIsolation {param($VMNetworkAdapter,$ErrorAction);Track 'isolation';return [pscustomobject]@{IsolationMode='None'}}
function Get-VMNetworkAdapterAcl {param($VMNetworkAdapter,$ErrorAction);Track 'legacy_acl'}
function Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction);Track 'read_acl';return $script:acl.ToArray()}
function Get-VMSwitch {param($Id,$ErrorAction);Track 'get_switch';if($Id -ne $script:sw.Id){throw 'wrong_switch'};return $script:sw}
function Get-NetIPAddress {param($AddressFamily,$ErrorAction);Track 'host_ips';foreach($ip in $i.hostIPv4){[pscustomobject]@{IPAddress=$ip}}}
function Add-VMNetworkAdapterExtendedAcl {
 param($VMNetworkAdapter,$Action,$Direction,$LocalIPAddress,$RemoteIPAddress,$Weight,$Stateful,$ErrorAction,
  $Protocol='ANY',$LocalPort=$null,$RemotePort=$null,$IdleSessionTimeout=0)
 Track 'add_acl';if($VMNetworkAdapter.Id -cne $i.guestAdapterId){throw 'wrong_adapter'}
 $script:acl.Add([pscustomobject]@{Action=$Action;Direction=$Direction;LocalIPAddress=$LocalIPAddress;RemoteIPAddress=$RemoteIPAddress;
  Weight=$Weight;Stateful=$Stateful;Protocol=$Protocol;LocalPort=$LocalPort;RemotePort=$RemotePort;IdleSessionTimeout=$IdleSessionTimeout;
  IsolationID=0;ParentAdapter=$script:nic;IsTemplate=$false;IsDeleted=$false})
}
function Connect-VMNetworkAdapter {param($VMNetworkAdapter,$VMSwitch,$ErrorAction)
 Track 'connect';if($VMNetworkAdapter.Id -cne $i.guestAdapterId -or $VMSwitch.Id -ne [guid]$i.switchId){throw 'wrong_connect'}
 $script:nic.SwitchId=$VMSwitch.Id;$script:nic.SwitchName=$VMSwitch.Name
}
function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,$ErrorAction)
 Track 'disconnect';if($VMNetworkAdapter.Id -cne $i.guestAdapterId){throw 'wrong_disconnect'}
 $script:nic.SwitchId=$null;$script:nic.SwitchName=''
}
function Write-CityGoBootstrapNetworkResult {param($Plan,$Result,$OwnerSid);Track 'receipt';$script:result=($Result|ConvertTo-Json -Depth 5|ConvertFrom-Json)}
`;

test("source limits mutations to exact-vNIC ACL, connect/disconnect and a CreateNew private receipt", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Remove-Item|Remove-VMNetworkAdapter|Remove-VMNetworkAdapterExtendedAcl|New-VMSwitch|Set-VMSwitch|New-NetNat|Set-NetFirewall\w*|Invoke-WebRequest|Start-Process|Mount-VHD|Register-\w+)\b/i,
  );
  assert.doesNotMatch(
    source,
    /-ManagementOS\b|-ComputerName\b|-Credential\b|ExecutionPolicy|\$env:/i,
  );
  assert.match(
    source,
    /Connect-VMNetworkAdapter -VMNetworkAdapter \$adapter -VMSwitch \$switches\[0\]/,
  );
  assert.match(
    source,
    /Disconnect-VMNetworkAdapter -VMNetworkAdapter \$matches\[0\]/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.FileShare\]::Read/);
});

test(
  "default plan trusts no host state, preserves actual historical failure and never claims isolation",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$result=Invoke-CityGoBootstrapNetwork $i $c $v $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray());history=$c.stage}|ConvertTo-Json -Depth 8 -Compress`);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.githubJobsAuthorized, false);
    assert.equal(out.history, "failed_preserved_receipt_unavailable");
    assert.deepEqual(out.calls, []);
  },
);

test(
  "localized printable vNIC names are data only; control characters and unexpected ownership paths are refused",
  { skip: !available },
  () => {
    const localized = { ...inventory, guestAdapterName: "Сетевой адаптер" };
    const out = run(`${fixture(localized)}${mocks}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
$nic=Get-CityGoOwnedBootstrapNetworkAdapter $plan $false
$denied=@();foreach($name in @("bad\u0000name","bad\u000aname",'   ')){
 $copy=($i|ConvertTo-Json -Depth 4|ConvertFrom-Json);$copy.guestAdapterName=$name
 try{$null=Get-CityGoBootstrapNetworkPlan $copy $c $v $request $now;$denied+=$false}catch{$denied+=$true}
}
$script:vm.Path='D:\\CityGo-CI\\bootstrap\\another-operation'
try{$null=Get-CityGoOwnedBootstrapNetworkAdapter $plan $false;$denied+=$false}catch{$denied+=$true}
[ordered]@{name=$nic.Name;denied=$denied}|ConvertTo-Json -Compress`);
    assert.equal(out.name, localized.guestAdapterName);
    assert.deepEqual(out.denied, [true, true, true, true]);
  },
);

test(
  "fresh exact resume inventory can rebuild the same offline policy; arbitrary paths, stale capture and invalid hashes are refused",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$original=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
$request.inventoryPath=${quote(control + "\\network-resume-inventory.json")}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
$denied=@();foreach($kind in @('arbitrary-name','other-operation','stale','future','hash','creation-path','verification-path')){
 $copy=($i|ConvertTo-Json -Depth 4|ConvertFrom-Json);$rr=[ordered]@{};foreach($key in $request.Keys){$rr[$key]=$request[$key]}
 if($kind -ceq 'arbitrary-name'){$rr.inventoryPath=${quote(control + "\\network-resume-inventory-v2.json")}}
 if($kind -ceq 'other-operation'){$rr.inventoryPath='D:\\CityGo-CI\\control\\aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\network-resume-inventory.json'}
 if($kind -ceq 'stale'){$copy.capturedAt='2026-10-19T02:49:59Z'}
 if($kind -ceq 'future'){$copy.capturedAt='2026-10-19T03:05:01Z'}
 if($kind -ceq 'hash'){$rr.inventorySha256='not-a-sha256'}
 if($kind -ceq 'creation-path'){$rr.creationReceiptPath=${quote(control + "\\other-result.json")}}
 if($kind -ceq 'verification-path'){$rr.verificationPath=${quote(control + "\\other-verification.json")}}
 try{$null=Get-CityGoBootstrapNetworkPlan $copy $c $v $rr $now;$denied+=$false}catch{$denied+=$true}
}
[ordered]@{rulesMatch=(($plan.rules|ConvertTo-Json -Depth 5 -Compress) -ceq ($original.rules|ConvertTo-Json -Depth 5 -Compress));
 resultPath=$plan.resultPath;remaining=$plan.remainingFreshSeconds;inventoryHash=$plan.inventorySha256;
 denied=$denied;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 4 -Compress`);
    assert.equal(out.rulesMatch, true);
    assert.equal(out.resultPath, control + "\\bootstrap-network-result.json");
    assert.equal(out.remaining, 600);
    assert.equal(out.inventoryHash, "b".repeat(64));
    assert.deepEqual(out.denied, Array(7).fill(true));
    assert.deepEqual(out.calls, []);
  },
);

test(
  "both inventory filenames retain one-shot Apply refusal for an existing result or existing ACL",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$cases=@()
foreach($filename in @('network-inventory.json','network-resume-inventory.json')){
 $request.inventoryPath=('D:\\CityGo-CI\\control\\'+$i.operationId+'\\'+$filename)
 $request.acknowledge=(Get-CityGoBootstrapNetworkPlan $i $c $v $request $now).requiredAcknowledgement
 foreach($kind in @('existing-result','existing-acl')){
  $script:calls.Clear();$script:acl.Clear();$script:existingResult=($kind -ceq 'existing-result')
  function Test-Path {param($LiteralPath,$ErrorAction);Track 'absent';return $script:existingResult}
  if($kind -ceq 'existing-acl'){$script:acl.Add([pscustomobject]@{})}
  $code='not-blocked';try{$null=Invoke-CityGoBootstrapNetwork $i $c $v $request $now}catch{$code=$_.Exception.Message}
  $cases+=[ordered]@{kind=$kind;code=$code;mutated=($script:calls.Contains('add_acl') -or $script:calls.Contains('connect') -or $script:calls.Contains('disconnect') -or $script:calls.Contains('receipt'))}
 }
}
ConvertTo-Json -InputObject $cases -Depth 4 -Compress`);
    assert.equal(out.length, 4);
    for (const item of out) {
      assert.equal(
        item.code,
        item.kind === "existing-result"
          ? "network_result_already_exists"
          : "existing_extended_acl_refused",
      );
      assert.equal(item.mutated, false);
    }
  },
);

test(
  "strict identities, historical chain, numeric/boolean types, freshness and unknown DHCP fail closed",
  { skip: !available },
  () => {
    const out = run(`${fixture()}
$changes=@(
 {param($i,$c,$v) $i.capturedDhcpServerIPv4=$null}, {param($i,$c,$v) $i.capturedDhcpServerIPv4='192.168.1.1'},
 {param($i,$c,$v) $i.vmId='00000000-0000-0000-0000-000000000000'}, {param($i,$c,$v) $i.guestAdapterId='*'},
 {param($i,$c,$v) $i.switchKind='ExplicitNat'}, {param($i,$c,$v) $i.switchName='Other'},
 {param($i,$c,$v) $i.schemaVersion=$true}, {param($i,$c,$v) $i.guestNicCount='1'},
 {param($i,$c,$v) $i.inventoriesComplete='True'}, {param($i,$c,$v) $i.macSpoofingEnabled=$true},
 {param($i,$c,$v) $i.sriovEnabled=$true}, {param($i,$c,$v) $i.devicePassthroughEnabled=$true},
 {param($i,$c,$v) $i.statefulAclSupported=$false}, {param($i,$c,$v) $i.natVerified=$false},
 {param($i,$c,$v) $i.capturedAt='2026-10-19T02:00:00Z'}, {param($i,$c,$v) $i.capturedAt='2026-10-19T03:06:00Z'},
 {param($i,$c,$v) $i.lanVpnPrefixes=@('0.0.0.0/0')}, {param($i,$c,$v) $i.hostIPv4=@('127.0.0.1')},
 {param($i,$c,$v) $i.productionIPv4=@()}, {param($i,$c,$v) $i.gatewayCidr='8.8.8.8/24'},
 {param($i,$c,$v) $i | Add-Member Unknown $true}, {param($i,$c,$v) $c.stage='other'},
 {param($i,$c,$v) $c.vmId='44444444-4444-4444-8444-444444444444'}, {param($i,$c,$v) $c.baseSha256='no'},
 {param($i,$c,$v) $v.stage='staged_verified_off_no_network'}, {param($i,$c,$v) $v.vCpu='4'},
 {param($i,$c,$v) $v.vhdxSha256=('f'*64)}, {param($i,$c,$v) $v.switchConnected=$true},
 {param($i,$c,$v) $v.historicalFailedStagingReceiptPreserved=$false}, {param($i,$c,$v) $v.guestIsolationVerified=$true}
)
$denied=@();foreach($change in $changes){
 $ii=($i|ConvertTo-Json -Depth 4|ConvertFrom-Json);$cc=($c|ConvertTo-Json|ConvertFrom-Json);$vv=($v|ConvertTo-Json|ConvertFrom-Json)
 & $change $ii $cc $vv;try{$null=Get-CityGoBootstrapNetworkPlan $ii $cc $vv $request $now;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 30);
    assert.deepEqual(out, Array(out.length).fill(true));
  },
);

test(
  "policy has only narrow bootstrap SSH/DHCP plus public web/fixed DNS with higher special, host, LAN and production denies",
  { skip: !available },
  () => {
    const rules = run(`${fixture()}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
ConvertTo-Json -InputObject $plan.rules -Depth 4 -Compress`);
    assert.equal(new Set(rules.map((x) => x.Weight)).size, rules.length);
    assert.ok(rules.every((x) => x.Weight >= 1 && x.Weight <= 65_535));
    const allows = rules.filter((x) => x.Action === "Allow");
    assert.equal(allows.length, 10);
    const ssh = allows.filter(
      (x) => x.Direction === "Inbound" && x.Protocol === "TCP",
    );
    assert.equal(ssh.length, 1);
    assert.equal(ssh[0].RemoteIPAddress, "172.29.192.1/32");
    assert.equal(ssh[0].LocalPort, "22");
    assert.equal(ssh[0].Stateful, true);
    const dhcp = allows.filter(
      (x) => x.Protocol === "UDP" && x.LocalPort === "68",
    );
    assert.equal(dhcp.length, 3);
    assert.ok(
      dhcp.every((x) =>
        ["172.29.192.1/32", "255.255.255.255/32"].includes(x.RemoteIPAddress),
      ),
    );
    for (const remote of [
      "::/0",
      "169.254.0.0/16",
      "168.63.129.16/32",
      "172.29.192.1/32",
      "45.67.89.10/32",
      "45.60.0.0/16",
      "80.90.100.110/32",
    ]) {
      for (const direction of ["Inbound", "Outbound"]) {
        assert.ok(
          rules.some(
            (x) =>
              x.Action === "Deny" &&
              x.Direction === direction &&
              x.RemoteIPAddress === remote &&
              x.Weight > 5_000,
          ),
        );
      }
    }
    assert.equal(allows.filter((x) => x.RemotePort === "53").length, 4);
    assert.ok(
      allows
        .filter((x) => x.RemotePort === "53")
        .every((x) => ["1.1.1.1/32", "8.8.8.8/32"].includes(x.RemoteIPAddress)),
    );
    assert.ok(
      rules.some(
        (x) =>
          x.Weight === 1 && x.Direction === "Outbound" && x.Action === "Deny",
      ),
    );
  },
);

test(
  "owner-approved HNS gateway candidate is explicit, exact /32, unverified and bootstrap-only",
  { skip: !available },
  () => {
    const candidate = {
      ...inventory,
      capturedDhcpServerIPv4: null,
      bootstrapCandidateDhcpMode: "hns_gateway_candidate",
      bootstrapCandidateDhcpIPv4: "172.29.192.1",
    };
    const out = run(`${fixture(candidate)}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
$denied=@();foreach($kind in @('other-ip','pretend-captured','unknown-mode','disabled-with-candidate')){
 $copy=($i|ConvertTo-Json -Depth 4|ConvertFrom-Json)
 if($kind -ceq 'other-ip'){$copy.bootstrapCandidateDhcpIPv4='172.29.192.2'}
 if($kind -ceq 'pretend-captured'){$copy.capturedDhcpServerIPv4='172.29.192.1'}
 if($kind -ceq 'unknown-mode'){$copy.bootstrapCandidateDhcpMode='guess'}
 if($kind -ceq 'disabled-with-candidate'){$copy.bootstrapCandidateDhcpMode='disabled'}
 try{$null=Get-CityGoBootstrapNetworkPlan $copy $c $v $request $now;$denied+=$false}catch{$denied+=$true}
}
[ordered]@{admission=$plan.dhcpAdmission;verified=$plan.guestIsolationVerified;jobs=$plan.githubJobsAuthorized;
 dhcp=@($plan.rules|Where-Object{$_.LocalPort -ceq '68'});denied=$denied}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.admission, "hns_gateway_candidate_not_verified");
    assert.equal(out.verified, false);
    assert.equal(out.jobs, false);
    assert.deepEqual(out.denied, Array(4).fill(true));
    assert.ok(
      out.dhcp.every((x) =>
        ["172.29.192.1/32", "255.255.255.255/32"].includes(x.RemoteIPAddress),
      ),
    );
  },
);

test(
  "mocked Apply independently reads back all ACLs before connecting one owned Off vNIC and never starts it",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoBootstrapNetworkPlan $i $c $v $request $now).requiredAcknowledgement
$result=Invoke-CityGoBootstrapNetwork $i $c $v $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray());count=$script:acl.Count;switch=$script:nic.SwitchName}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(
      out.result.stage,
      "bootstrap_connected_vm_off_canaries_pending",
    );
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.vmStarted, false);
    assert.equal(out.switch, "Default Switch");
    assert.ok(out.count > 40);
    const connect = out.calls.indexOf("connect");
    assert.equal(out.calls.filter((x) => x === "connect").length, 1);
    assert.equal(out.calls.filter((x) => x === "add_acl").length, out.count);
    assert.ok(out.calls.lastIndexOf("add_acl") < connect);
    assert.ok(
      out.calls
        .slice(out.calls.lastIndexOf("add_acl"), connect)
        .includes("read_acl"),
    );
    assert.ok(out.calls.slice(connect + 1).includes("read_acl"));
    assert.ok(!out.calls.includes("disconnect"));
  },
);

test(
  "bad acknowledgement and preconditions never add ACLs or connect, including existing ACL and changed host IPv4",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$denied=$false;try{$null=Invoke-CityGoBootstrapNetwork $i $c $v $request $now}catch{$denied=$true}
$early=@($script:calls.ToArray());$request.acknowledge=(Get-CityGoBootstrapNetworkPlan $i $c $v $request $now).requiredAcknowledgement
$cases=@('running','connected','wrong-nic','broad-switch','existing-acl','changed-host','disk-changed','two-nics')
$failures=@();foreach($kind in $cases){
 $script:calls.Clear();$script:vm.State='Off';$script:nic.SwitchName='';$script:nic.Id=$i.guestAdapterId;$script:sw.Name='Default Switch';$script:acl.Clear()
 function Get-NetIPAddress {param($AddressFamily,$ErrorAction);Track 'host_ips';foreach($ip in $i.hostIPv4){[pscustomobject]@{IPAddress=$ip}}}
 function Get-FileHash {param($LiteralPath,$Algorithm,$ErrorAction);Track 'disk_hash';return [pscustomobject]@{Hash=$c.baseSha256}}
 function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get_nic';return $script:nic}
 if($kind -ceq 'running'){$script:vm.State='Running'}
 if($kind -ceq 'connected'){$script:nic.SwitchName='Unexpected'}
 if($kind -ceq 'wrong-nic'){$script:nic.Id='different'}
 if($kind -ceq 'broad-switch'){$script:sw.Name='Other'}
 if($kind -ceq 'existing-acl'){$script:acl.Add([pscustomobject]@{})}
 if($kind -ceq 'changed-host'){function Get-NetIPAddress {param($AddressFamily,$ErrorAction);Track 'host_ips';return [pscustomobject]@{IPAddress='127.0.0.1'}}}
 if($kind -ceq 'disk-changed'){function Get-FileHash {param($LiteralPath,$Algorithm,$ErrorAction);Track 'disk_hash';return [pscustomobject]@{Hash=('e'*64)}}}
 if($kind -ceq 'two-nics'){function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get_nic';return @($script:nic,$script:nic)}}
 $blocked=$false;try{$null=Invoke-CityGoBootstrapNetwork $i $c $v $request $now}catch{$blocked=$true}
 $failures+=($blocked -and -not $script:calls.Contains('add_acl') -and -not $script:calls.Contains('connect') -and -not $script:calls.Contains('disconnect'))
}
[ordered]@{denied=$denied;early=$early;failures=$failures}|ConvertTo-Json -Compress`);
    assert.equal(out.denied, true);
    assert.deepEqual(out.early, []);
    assert.deepEqual(out.failures, Array(8).fill(true));
  },
);

test(
  "partial ACL/connect failures preserve ACLs, disconnect only the owned adapter and do not report success",
  { skip: !available },
  () => {
    for (const fail of ["add_acl", "connect", "receipt"]) {
      const out = run(`${fixture()}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoBootstrapNetworkPlan $i $c $v $request $now).requiredAcknowledgement
$script:fail=${quote(fail)};$result=Invoke-CityGoBootstrapNetwork $i $c $v $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray());switch=$script:nic.SwitchName}|ConvertTo-Json -Depth 5 -Compress`);
      assert.match(out.result.stage, /^failed_/);
      assert.equal(out.switch, "");
      assert.equal(out.calls.filter((x) => x === "disconnect").length, 1);
      assert.equal(out.result.guestIsolationVerified, false);
    }
  },
);

test(
  "replacement NIC after failure is never touched by recovery",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
function Connect-VMNetworkAdapter {param($VMNetworkAdapter,$VMSwitch,$ErrorAction);Track 'connect';$script:nic.Id='replacement';throw 'synthetic_failure'}
$request.apply=$true;$request.acknowledge=(Get-CityGoBootstrapNetworkPlan $i $c $v $request $now).requiredAcknowledgement
$result=Invoke-CityGoBootstrapNetwork $i $c $v $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 4 -Compress`);
    assert.equal(out.result.stage, "failed_preserved_disconnect_unverified");
    assert.ok(!out.calls.includes("disconnect"));
  },
);

test(
  "independent ACL readback rejects extra, duplicate, wrong owner, wider allow and timeout/stateful mismatch",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
$denied=@();foreach($kind in @('extra','duplicate','owner','address','timeout','stateful')){
 $script:acl.Clear();foreach($rule in $plan.rules){Add-CityGoBootstrapNativeAcl $script:nic $rule}
 if($kind -ceq 'extra'){$script:acl.Add($script:acl[0])}
 if($kind -ceq 'duplicate'){$script:acl[1]=$script:acl[0]}
 if($kind -ceq 'owner'){$script:acl[0].ParentAdapter=[pscustomobject]@{Id='other';VMId=[guid]$i.vmId}}
 if($kind -ceq 'address'){$script:acl[2].RemoteIPAddress='0.0.0.0/0'}
 if($kind -ceq 'timeout'){$script:acl[2].IdleSessionTimeout=3600}
 if($kind -ceq 'stateful'){$script:acl[2].Stateful=$false}
 try{Assert-CityGoBootstrapAclReadback $script:nic $plan;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, Array(6).fill(true));
  },
);

test(
  "native ANY/empty wildcards, protocol sentinel/numbers, host /32 and unused stateless timeout normalize without weakening stateful checks",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$plan=Get-CityGoBootstrapNetworkPlan $i $c $v $request $now
foreach($rule in $plan.rules){Add-CityGoBootstrapNativeAcl $script:nic $rule}
foreach($row in $script:acl){
 if($row.LocalIPAddress -ceq 'ANY'){$row.LocalIPAddress=''}
 if($null -eq $row.LocalPort){$row.LocalPort='ANY'}
 if($null -eq $row.RemotePort){$row.RemotePort='ANY'}
 if($row.Protocol -ceq 'ANY'){$row.Protocol='256'}elseif($row.Protocol -ceq 'TCP'){$row.Protocol='6'}else{$row.Protocol='17'}
 if($row.RemoteIPAddress -like '*/32'){$row.RemoteIPAddress=$row.RemoteIPAddress.Replace('/32','')}
 if(-not $row.Stateful){$row.IdleSessionTimeout=255}
}
Assert-CityGoBootstrapAclReadback $script:nic $plan
$denied=@();foreach($weight in @(0,65536,1000000)){
 try{$list=[Collections.Generic.List[object]]::new();Add-CityGoBootstrapRule $list $weight 'Inbound' 'Deny' '::/0';$denied+=$false}catch{$denied+=$true}
}
[ordered]@{normalized=$true;denied=$denied}|ConvertTo-Json -Compress`);
    assert.equal(out.normalized, true);
    assert.deepEqual(out.denied, [true, true, true]);
  },
);

test(
  "strict JSON rejects duplicate/escaped keys, nested metadata, comments/trailing commas and unsafe paths before access",
  { skip: !available },
  () => {
    const bad = [
      '{"a":1,"a":2}',
      '{"a":1,"A":2}',
      '{"\\u0061":1}',
      '{"a":{"b":1}}',
      '{"a":1,}',
      '{"a":1/*x*/}',
      "true",
      "[]",
    ];
    const out = run(`
$bad=ConvertFrom-Json ${quote(JSON.stringify(bad))};$denied=@()
foreach($raw in $bad){try{$null=ConvertFrom-CityGoBootstrapNetworkJson $raw;$denied+=$false}catch{$denied+=$true}}
function Get-Item {throw 'file_access_not_allowed'}
foreach($path in @('\\\\server\\share\\x.json','D:x.json','D:\\CityGo-CI\\control\\..\\x.json','D:\\CityGo-CI\\control\\x.json:ads','\\\\?\\D:\\x.json')){
 try{$null=Read-CityGoBootstrapNetworkEvidence $path ('a'*64) 'synthetic';$denied+=$false}catch{$denied+=($_.Exception.Message -cne 'file_access_not_allowed')}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 13);
    assert.deepEqual(out, Array(out.length).fill(true));
  },
);
