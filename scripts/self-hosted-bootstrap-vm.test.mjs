import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/New-CityGoBootstrapVm.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
// Windows path/ACL semantics are intentional. Linux may parse the source, but
// must not pretend these Windows-only behavioral fixtures ran successfully.
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
  }).status === 0;
const hash = createHash("sha256").update("synthetic-vhdx-only").digest("hex");

function run(command) {
  // Parse and load ONLY function definitions; never execute the script entrypoint.
  // Hyper-V and all filesystem-mutating functions are mocked before apply tests.
  const input = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse-failed'}
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
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const request = String.raw`
$request=[ordered]@{
 operationId='12345678-1234-4234-8234-123456789abc'
 basePath='D:\CityGo-CI\images\reviewed.vhdx'; baseSha256='${hash}'
 preflightPath='D:\CityGo-CI\control\12345678-1234-4234-8234-123456789abc\fresh.json'; preflightSha256=('b'*64)
 apply=$false; acknowledge=''
}
`;
const mocks = String.raw`
$script:calls=[Collections.Generic.List[string]]::new(); $script:receipts=@(); $script:failAt=''
$script:vm=[pscustomobject]@{Id=[Guid]'98765432-1234-4234-8234-123456789abc';Name='citygo-ci-base-12345678-1234-4234-8234-123456789abc';State='Off';Generation=2;ProcessorCount=4;MemoryStartup=6GB;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false}
$script:nic=[pscustomobject]@{SwitchName='';SwitchId=[Guid]::Empty;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On'}
$script:firmware=[pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}
function Track([string]$name){$script:calls.Add($name);if($script:failAt -eq $name){throw 'synthetic-failure'}}
function Get-CityGoBootstrapIdentity {Track 'identity';return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoBootstrapPreflight {param($Plan,$OwnerSid);Track 'preflight'}
function Assert-CityGoBootstrapControl {param($Plan,$OwnerSid);Track 'private-control'}
function Assert-CityGoPlainExistingPath {param($Path,$Directory);Track 'plain-path'}
function Assert-CityGoPrivateAcl {param($Path,$OwnerSid);Track 'private-acl'}
function Assert-CityGoBootstrapDestinationsAbsent {param($Plan);Track 'absent'}
function Set-CityGoPrivateDirectoryAcl {param($Path,$OwnerSid);Track 'set-private-acl'}
function Open-CityGoBootstrapSource {param($Path);Track 'open-source';return [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('synthetic-vhdx-only'))}
function Copy-CityGoVerifiedBootstrapDisk {param($Source,$Plan);Track 'copy'}
function Write-CityGoBootstrapReceipt {param($Plan,$Receipt,$OwnerSid);Track 'receipt';$script:receipts+=($Receipt|ConvertTo-Json -Compress|ConvertFrom-Json)}
function New-Item {param($Path,$ItemType,$ErrorAction);Track 'mkdir';return [pscustomobject]@{}}
function Get-VHD {param($Path,$ErrorAction);Track 'get-vhd';return [pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=100}}
function New-VM {param($Name,$Generation,$MemoryStartupBytes,$VHDPath,$Path,$ErrorAction);Track 'new-vm';if($PSBoundParameters.ContainsKey('SwitchName')){throw 'network-forbidden'};return $script:vm}
function Set-VM {param($VM,$AutomaticStartAction,$AutomaticCheckpointsEnabled,$CheckpointType,$ErrorAction);Track 'set-vm'}
function Set-VMProcessor {param($VM,$Count,$ErrorAction);Track 'set-cpu'}
function Set-VMMemory {param($VM,$DynamicMemoryEnabled,$StartupBytes,$ErrorAction);Track 'set-memory'}
function Set-VMFirmware {param($VM,$EnableSecureBoot,$SecureBootTemplate,$ErrorAction);Track 'set-firmware'}
function Get-VM {param($Id,$ErrorAction);Track 'get-vm';return $script:vm}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get-disks';return [pscustomobject]@{Path='D:\CityGo-CI\bootstrap\12345678-1234-4234-8234-123456789abc\bootstrap.vhdx';DiskNumber=$null}}
function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get-nic';return $script:nic}
function Set-VMNetworkAdapter {param($VMNetworkAdapter,$MacAddressSpoofing,$DhcpGuard,$RouterGuard,$ErrorAction);Track 'protect-nic'}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'get-firmware';return $script:firmware}
`;

test("bootstrap has no start/network/cleanup/registration commands and uses locked CreateNew copies", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Remove-Item|Connect-VMNetworkAdapter|New-VMSwitch|New-NetNat|Add-VMNetworkAdapter|Invoke-WebRequest|Start-Process|Register-\w+|Mount-VHD|Add-VMHardDiskDrive)\b/i,
  );
  assert.doesNotMatch(
    source,
    /\$env:|ExecutionPolicy|Exception\.Message|Force\s*[:=]|SwitchName\s+\$/i,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.FileShare\]::Read/);
  assert.match(source, /guestIsolationVerified = \$false/);
  assert.match(source, /-Generation 2 -MemoryStartupBytes 6GB/);
  assert.match(
    source,
    /-AutomaticStartAction Nothing -AutomaticCheckpointsEnabled \$false -CheckpointType Disabled/,
  );
  assert.match(source, /-MacAddressSpoofing Off -DhcpGuard On -RouterGuard On/);
});

test(
  "default plan loads no host inventory, creates nothing and does not claim readiness",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$plan=Invoke-CityGoBootstrapVm $request
[ordered]@{plan=$plan;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.plan.stage, "plan_only_unverified");
    assert.equal(out.plan.guestIsolationVerified, false);
    assert.equal(out.plan.githubRunnerRegistered, false);
    assert.deepEqual(out.calls, []);
  },
);

test(
  "canonical path, image root, hashes and unique operation guard reject unsafe inputs",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$cases=@(
 @{basePath='D:\CityGo-CI\images\..\base\x.vhdx'},@{basePath='D:\Other\x.vhdx'},
 @{basePath='D:\CityGo-CI\images\x.avhdx'},@{basePath='D:\CityGo-CI\images\x.vhdx:stream'},
 @{basePath='\\server\share\x.vhdx'},@{basePath='D:\CityGo-CI\images\x?.vhdx'},
 @{operationId='00000000-0000-0000-0000-000000000000'},@{operationId='..'},@{baseSha256=''},@{preflightSha256='invalid'}
)
$denied=@();foreach($change in $cases){$r=[ordered]@{};foreach($k in $request.Keys){$r[$k]=$request[$k]};foreach($k in $change.Keys){$r[$k]=$change[$k]};try{$null=Get-CityGoBootstrapPlan $r;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 10);
    assert.ok(out.every(Boolean));
  },
);

test(
  "receipt is pinned to the separate operation control directory and never the Hyper-V managed target",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$plan=Get-CityGoBootstrapPlan $request
$request.preflightPath='D:\CityGo-CI\control\another-operation\fresh.json'
$denied=$false;try{$null=Get-CityGoBootstrapPlan $request}catch{$denied=$true}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$writer=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-CityGoBootstrapReceipt'},$true).Extent.Text
[ordered]@{control=$plan.controlDirectory;receipt=$plan.receiptPath;target=$plan.targetDirectory;preflight=$plan.preflightPath;denied=$denied;writer=$writer}|ConvertTo-Json -Compress`);
    assert.equal(
      out.control,
      String.raw`D:\CityGo-CI\control\12345678-1234-4234-8234-123456789abc`,
    );
    assert.equal(
      out.receipt,
      out.control + String.raw`\bootstrap-receipt.json`,
    );
    assert.equal(out.preflight, out.control + String.raw`\fresh.json`);
    assert.ok(!out.receipt.startsWith(out.target));
    assert.equal(out.denied, true);
    assert.match(out.writer, /Assert-CityGoBootstrapControl \$Plan \$OwnerSid/);
    assert.doesNotMatch(out.writer, /targetDirectory|Set-Acl|Set-CityGo/);
  },
);

test(
  "control receipt requires an existing plain private protected directory and refuses overwrite without mutation",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$script:protected=$true;$script:exists=$false;$script:private=$true;$script:calls=@()
function Assert-CityGoPlainExistingPath {param($Path,$Directory);$script:calls+='plain-control';if(-not $Directory){throw 'directory-required'}}
function Assert-CityGoPrivateAcl {param($Path,$OwnerSid);$script:calls+='private-control';if(-not $script:private){throw 'private-acl-required'}}
function Get-Acl {param($LiteralPath,$ErrorAction);$script:calls+='read-control-acl';return [pscustomobject]@{AreAccessRulesProtected=$script:protected}}
function Test-Path {param($LiteralPath,$ErrorAction);$script:calls+='receipt-absent';return $script:exists}
$plan=Get-CityGoBootstrapPlan $request
Assert-CityGoBootstrapControl $plan 'synthetic-owner'
$success=@($script:calls);$denied=@()
foreach($kind in @('inherited-acl','existing-receipt','broad-acl')){
 $script:protected=($kind -ne 'inherited-acl');$script:exists=($kind -eq 'existing-receipt');$script:private=($kind -ne 'broad-acl')
 try{Assert-CityGoBootstrapControl $plan 'synthetic-owner';$denied+=$false}catch{$denied+=$true}
}
[ordered]@{success=$success;denied=$denied}|ConvertTo-Json -Compress`);
    assert.deepEqual(out.success, [
      "plain-control",
      "private-control",
      "read-control-acl",
      "receipt-absent",
    ]);
    assert.deepEqual(out.denied, [true, true, true]);
  },
);

test(
  "fresh v2 private-report content is observation only and rejects stale, missing, false and string readiness",
  { skip: !available },
  () => {
    const out = run(`
$base=@{version=2;scope='elevated_read_only_host_inventory';status='observed-not-approved';observedAt='2026-10-19T01:00:00Z';errorCode=$null;vmCreated=$false;networkChanged=$false;servicesChanged=$false;runnerRegistered=$false;diagnostic=@{schemaVersion=1;scope='host_readiness_only';readyForVmProvisioning=$true;blockers=@();inventory=@{administrator=$true;hypervFeature='Enabled';vmmsState='Running'};configuredResources=@{guestVcpu=4;guestMemoryGiB=6};guestIsolationVerified=$false;githubRunnerRegistered=$false};management=@{inventoryReadSucceeded=$true;guestIsolationVerified=$false}}
$now=[DateTimeOffset]'2026-10-19T01:05:00Z';Assert-CityGoBootstrapPreflightContent $base $now
$changes=@(
 {param($x) $x.observedAt='2026-10-19T00:00:00Z'}, {param($x) $x.observedAt='2026-10-19T01:06:00Z'},
 {param($x) $x.scope='other'}, {param($x) $x.version=1}, {param($x) $x.status='approved'},
 {param($x) $x.vmCreated=$true}, {param($x) $x.vmCreated='False'},
 {param($x) $x.diagnostic.readyForVmProvisioning=$false}, {param($x) $x.diagnostic.inventory.administrator='True'},
 {param($x) $x.diagnostic.blockers=@('blocked')}, {param($x) $x.diagnostic.configuredResources.guestMemoryGiB=4},
 {param($x) $x.management.inventoryReadSucceeded=$null}
)
$denied=@();foreach($change in $changes){$r=($base|ConvertTo-Json -Depth 8|ConvertFrom-Json);& $change $r;try{Assert-CityGoBootstrapPreflightContent $r $now;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 12);
    assert.ok(out.every(Boolean));
  },
);

test(
  "apply requires exact typed acknowledgement and all guards before its first mutation",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$request.apply=$true;$denied=$false;try{$null=Invoke-CityGoBootstrapVm $request}catch{$denied=$true}
$early=@($script:calls.ToArray());$script:calls.Clear()
$request.acknowledge=(Get-CityGoBootstrapPlan $request).requiredAcknowledgement
$script:failAt='preflight';try{$null=Invoke-CityGoBootstrapVm $request}catch{}
[ordered]@{denied=$denied;early=$early;guardCalls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.equal(out.denied, true);
    assert.deepEqual(out.early, []);
    assert.deepEqual(out.guardCalls, [
      "identity",
      "private-control",
      "preflight",
    ]);
  },
);

test(
  "an unverified base hash cannot create even an empty VM or a destination directory",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$request.apply=$true;$request.baseSha256=('a'*64);$request.acknowledge=(Get-CityGoBootstrapPlan $request).requiredAcknowledgement
$result=Invoke-CityGoBootstrapVm $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receipts=$script:receipts}|ConvertTo-Json -Depth 5 -Compress`);
    assert.match(out.result.stage, /^failed_preserved_/);
    assert.ok(!out.calls.includes("mkdir"));
    assert.ok(!out.calls.includes("new-vm"));
    assert.ok(!out.calls.includes("get-vhd"));
    assert.equal(out.receipts.length, 1);
    assert.equal(out.receipts[0].failureStage, "verify_base");
  },
);

test(
  "standalone VHDX and existing namespace checks fail closed without adoption",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$disk=@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=100}
Assert-CityGoPlainVhdx $disk
$denied=@();foreach($change in @(@{VhdFormat='VHD'},@{VhdType='Differencing'},@{ParentPath='D:\parent.vhdx'},@{Attached=$true},@{Size=0},@{Size=95GB},@{Size=97GB},@{Size=(96GB+1)},@{FileSize=0})){
 $copy=@{};foreach($k in $disk.Keys){$copy[$k]=$disk[$k]};foreach($k in $change.Keys){$copy[$k]=$change[$k]}
 try{Assert-CityGoPlainVhdx $copy;$denied+=$false}catch{$denied+=$true}
}
function Assert-CityGoPlainExistingPath {param($Path,$Directory)}
function Test-Path {param($LiteralPath,$ErrorAction);return $true}
function Get-VM {throw 'vm-inventory-must-not-run-for-existing-path'}
try{Assert-CityGoBootstrapDestinationsAbsent (Get-CityGoBootstrapPlan $request);$denied+=$false}catch{$denied+=($_.Exception.Message -eq 'destination-exists')}
function Test-Path {param($LiteralPath,$ErrorAction);return $false}
function Get-VM {param($ErrorAction);return [pscustomobject]@{Name='citygo-ci-base-12345678-1234-4234-8234-123456789abc'}}
try{Assert-CityGoBootstrapDestinationsAbsent (Get-CityGoBootstrapPlan $request);$denied+=$false}catch{$denied+=($_.Exception.Message -eq 'vm-name-exists')}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 11);
    assert.ok(out.every(Boolean));
  },
);

test(
  "plain-path guard inspects root and every ancestor and rejects reparses",
  { skip: !available },
  () => {
    const out = run(String.raw`
$script:bad='';$script:seen=@()
function Get-Item {param($LiteralPath,[switch]$Force,$ErrorAction)
 $script:seen+=$LiteralPath
 return [pscustomobject]@{Attributes=$(if($LiteralPath -eq $script:bad){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal});PSProvider=[pscustomobject]@{Name='FileSystem'};PSIsContainer=($LiteralPath -notlike '*.vhdx')}
}
$denied=@();foreach($bad in @('D:\','D:\CityGo-CI','D:\CityGo-CI\images','D:\CityGo-CI\images\x.vhdx')){
 $script:bad=$bad;try{Assert-CityGoPlainExistingPath 'D:\CityGo-CI\images\x.vhdx' $false;$denied+=$false}catch{$denied+=$true}
}
$script:bad='';$script:seen=@();Assert-CityGoPlainExistingPath 'D:\CityGo-CI\images\x.vhdx' $false
[ordered]@{denied=$denied;seen=$script:seen}|ConvertTo-Json -Compress`);
    assert.deepEqual(out.denied, [true, true, true, true]);
    assert.equal(out.seen.length, 4);
  },
);

test(
  "mocked apply stages exactly one off VM and a private receipt without a switch or start",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoBootstrapPlan $request).requiredAcknowledgement
$result=Invoke-CityGoBootstrapVm $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receipts=$script:receipts}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.result.stage, "staged_verified_off_no_network");
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.vmId, "98765432-1234-4234-8234-123456789abc");
    assert.equal(out.calls.filter((x) => x === "new-vm").length, 1);
    assert.equal(out.calls.filter((x) => x === "preflight").length, 2);
    assert.ok(out.calls.indexOf("get-vhd") < out.calls.indexOf("mkdir"));
    assert.ok(out.calls.indexOf("protect-nic") < out.calls.indexOf("receipt"));
    assert.equal(out.receipts.length, 1);
  },
);

test(
  "failure after owned creation preserves resources and records an unverified failure, never false off-success",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoBootstrapPlan $request).requiredAcknowledgement
$script:failAt='set-firmware';$result=Invoke-CityGoBootstrapVm $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receipts=$script:receipts}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.result.stage, "failed_preserved_state_unverified");
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.receipts[0].stage, "failed_preserved_state_unverified");
    assert.equal(out.receipts[0].failureStage, "set_secure_boot");
    assert.equal(out.receipts[0].failureCode, "bootstrap_stage_failed");
    assert.equal(out.calls.filter((x) => x === "new-vm").length, 1);
  },
);

test(
  "actual postcondition validator rejects attached NIC, extra adapters/disks, running state and wrong firmware",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$plan=Get-CityGoBootstrapPlan $request
$denied=@();foreach($kind in @('running','network','firmware','two-nics','two-disks')){
 $script:vm.State='Off';$script:nic.SwitchName='';$script:firmware.SecureBoot='On'
 if($kind -eq 'running'){$script:vm.State='Running'}
 if($kind -eq 'network'){$script:nic.SwitchName='Unexpected'}
 if($kind -eq 'firmware'){$script:firmware.SecureBoot='Off'}
 if($kind -eq 'two-nics'){function Get-VMNetworkAdapter {param($VM,$ErrorAction);return @($script:nic,$script:nic)}}
 if($kind -eq 'two-disks'){function Get-VMNetworkAdapter {param($VM,$ErrorAction);return $script:nic};function Get-VMHardDiskDrive {param($VM,$ErrorAction);return @([pscustomobject]@{Path=$plan.targetVhdx},[pscustomobject]@{Path=$plan.targetVhdx})}}
 try{$null=Assert-CityGoStoppedBootstrapVm $script:vm $plan;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, [true, true, true, true, true]);
  },
);
