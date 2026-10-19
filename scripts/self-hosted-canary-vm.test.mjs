import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../deploy/ci/New-CityGoCanaryVm.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell = "powershell.exe";
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
  }).status === 0;
const hash = createHash("sha256")
  .update("synthetic-sealed-vhdx-only")
  .digest("hex");

function run(command) {
  // Never evaluate the entrypoint. All native and write boundaries in apply
  // fixtures are replaced before the selected function can be called.
  const input = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse-failed'}
foreach($definition in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 . ([scriptblock]::Create($definition.Extent.Text))
}
${command}`;
  const env = Object.fromEntries(
    ["SystemRoot", "WINDIR", "SYSTEMDRIVE", "PATH", "TEMP", "TMP"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(input, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 20_000, env },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const request = String.raw`
$request=[ordered]@{
 operationId='12345678-1234-4234-8234-123456789abc'
 basePath='D:\CityGo-CI\bootstrap\11111111-1111-4111-8111-111111111111\bootstrap.vhdx';baseSha256='${hash}'
 sealedBaseEvidencePath='D:\CityGo-CI\control\11111111-1111-4111-8111-111111111111\sealed-base.json';sealedBaseEvidenceSha256=('c'*64)
 preflightPath='D:\CityGo-CI\control\12345678-1234-4234-8234-123456789abc\preflight.json';preflightSha256=('b'*64)
 apply=$false;acknowledge=''
}
`;
const evidence = String.raw`
$preflight=[pscustomobject]@{
 version=2;scope='elevated_read_only_host_inventory';status='observed-not-approved';observedAt=[DateTimeOffset]::UtcNow.AddSeconds(-5).ToString('yyyy-MM-ddTHH:mm:ssZ');errorCode=$null
 vmCreated=$false;networkChanged=$false;servicesChanged=$false;runnerRegistered=$false
 diagnostic=[pscustomobject]@{schemaVersion=1;scope='host_readiness_only';readyForVmProvisioning=$true;blockers=@();inventory=[pscustomobject]@{administrator=$true;hypervFeature='Enabled';vmmsState='Running'};configuredResources=[pscustomobject]@{guestVcpu=4;guestMemoryGiB=6;guestDiskGiB=96};guestIsolationVerified=$false;githubRunnerRegistered=$false}
 management=[pscustomobject]@{inventoryReadSucceeded=$true;guestIsolationVerified=$false}
}
$seal=[pscustomobject][ordered]@{
 schemaVersion=1;scope='sealed_base_for_local_canary_only';observedAt='2026-10-01T00:00:00Z';basePath=$request.basePath;baseSha256=$request.baseSha256;diskSizeBytes=96GB
 bootstrapAccessRemoved=$true;seedDetached=$true;cloudInitCacheRemoved=$true;sshHostKeysRemoved=$true;toolsReplayed=$true;sourceVmState='Off'
 githubRunnerRegistered=$false;checkoutPresent=$false;sharedHostMountsPresent=$false;guestIsolationVerified=$false;ciJobsAdmitted=$false
}
`;
const mocks = String.raw`
$script:calls=[Collections.Generic.List[string]]::new();$script:receipts=@();$script:failAt=''
$script:sourceDiskId='11111111-2222-4333-8444-555555555555';$script:targetDiskId=$script:sourceDiskId
$script:newDiskId='22222222-3333-4444-8555-666666666666';$script:failReset=$false
$script:vm=[pscustomobject]@{Id=[Guid]'98765432-1234-4234-8234-123456789abc';Name='citygo-ci-canary-12345678-1234-4234-8234-123456789abc';Path='D:\CityGo-CI\canaries\12345678-1234-4234-8234-123456789abc\citygo-ci-canary-12345678-1234-4234-8234-123456789abc';State='Off';Generation=2;ProcessorCount=4;MemoryStartup=6GB;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false}
$script:nic=[pscustomobject]@{Id='Microsoft:98765432-1234-4234-8234-123456789abc\33333333-4444-4555-8666-777777777777';VMId=$script:vm.Id;Name='Сетевой адаптер';SwitchName='';SwitchId=[Guid]::Empty;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovWeight=0;AllowTeaming='Off';PortMirroringMode='None'}
$script:firmware=[pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}
function Track([string]$Name){$script:calls.Add($Name);if($script:failAt -eq $Name){throw 'synthetic-failure'}}
function Get-CityGoCanaryIdentity {Track 'identity';return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoCanaryControl {param($Plan,$OwnerSid);Track 'control'}
function Assert-CityGoCanaryPlainPath {param($Path,$Directory);Track 'plain'}
function Assert-CityGoCanaryPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'private'}
function Assert-CityGoCanaryDestinationsAbsent {param($Plan,$OwnerSid);Track 'absent'}
function Set-CityGoCanaryPrivateDirectory {param($Path,$OwnerSid);Track 'private-new-directory'}
function Read-CityGoCanaryEvidence {param($Path,$Expected,$OwnerSid,$MaximumBytes)
 Track 'evidence';$value=$(if($Path -like '*sealed-base.json'){$seal}else{$preflight})
 return @{value=$value;raw=($value|ConvertTo-Json -Depth 8 -Compress);stream=[IO.MemoryStream]::new()}
}
function Open-CityGoCanarySource {param($Path);Track 'open-source';return ,[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('synthetic-sealed-vhdx-only'))}
function Copy-CityGoVerifiedCanaryDisk {param($Source,$Plan);Track 'verified-copy'}
function Write-CityGoCanaryCreation {param($Plan,$Receipt,$OwnerSid);Track 'receipt';$script:receipts+=($Receipt|ConvertTo-Json -Compress|ConvertFrom-Json)}
function New-Item {param($Path,$ItemType,$ErrorAction);Track 'mkdir';return [pscustomobject]@{}}
function Get-VHD {param($Path,$ErrorAction)
 Track 'get-vhd';$id=$(if($Path -eq $request.basePath){$script:sourceDiskId}else{$script:targetDiskId})
 return [pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=100;DiskIdentifier=$id}
}
function Set-VHD {param($Path,[switch]$ResetDiskIdentifier,[switch]$Force,$ErrorAction)
 Track 'reset-new-disk-id';if($Path -eq $request.basePath -or -not $ResetDiskIdentifier -or $Path -ne (Get-CityGoCanaryPlan $request).targetVhdx){throw 'source-or-unowned-disk-write'}
 if(-not $Force){throw 'native-confirmation-required'}
 if(-not $script:failReset){$script:targetDiskId=$script:newDiskId}
}
function New-VM {param($Name,$Generation,$MemoryStartupBytes,$VHDPath,$Path,$ErrorAction);Track 'new-vm';return $script:vm}
function Set-VM {param($VM,$AutomaticStartAction,$AutomaticCheckpointsEnabled,$CheckpointType,$ErrorAction);Track 'set-vm'}
function Set-VMProcessor {param($VM,$Count,$ErrorAction);Track 'set-cpu'}
function Set-VMMemory {param($VM,$DynamicMemoryEnabled,$StartupBytes,$ErrorAction);Track 'set-memory'}
function Set-VMFirmware {param($VM,$EnableSecureBoot,$SecureBootTemplate,$ErrorAction);Track 'set-firmware'}
function Get-VM {param($Id,$ErrorAction);Track 'get-vm';return $script:vm}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get-disk';return [pscustomobject]@{Path=(Get-CityGoCanaryPlan $request).targetVhdx;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}}
function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get-nic';return $script:nic}
function Set-VMNetworkAdapter {param($VMNetworkAdapter,$MacAddressSpoofing,$DhcpGuard,$RouterGuard,$IovWeight,$AllowTeaming,$PortMirroring,$ErrorAction);Track 'protect-nic'}
function Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction);Track 'get-extended-acl'}
function Get-VMNetworkAdapterAcl {param($VMNetworkAdapter,$ErrorAction);Track 'get-acl'}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'get-device'}
function Get-VMDvdDrive {param($VM,$ErrorAction);Track 'get-dvd'}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'get-firmware';return $script:firmware}
`;

test("canary source has no start, connect, cleanup, host setup, network fetch or key access", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Remove-Item|Connect-VMNetworkAdapter|New-VMSwitch|New-NetNat|Add-VMNetworkAdapter|Invoke-WebRequest|Start-Process|Mount-VHD|Add-VMHardDiskDrive)\b/i,
  );
  assert.doesNotMatch(
    source,
    /\$env:|ExecutionPolicy|Exception\.Message|\.ssh|\.env\b/i,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.FileShare\]::Read/);
  assert.match(
    source,
    /Set-VHD -Path \$plan.targetVhdx -ResetDiskIdentifier -Force -ErrorAction Stop/,
  );
  assert.match(source, /sourceId\) 'copied-disk-identity-unexpected'/);
  assert.match(source, /canaryId -cne \$sourceId/);
  assert.match(source, /-IovWeight 0 -AllowTeaming Off -PortMirroring None/);
  assert.deepEqual(
    source.match(/^\s*\$null=(?:Set|New|Remove)-[^\r\n]*-Force\b[^\r\n]*$/gm),
    [
      "        $null=Set-VHD -Path $plan.targetVhdx -ResetDiskIdentifier -Force -ErrorAction Stop",
    ],
  );
});

test(
  "default is a pure plan with immutable separate ownership receipt",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
$result=Invoke-CityGoCanaryVm $request;$plan=Get-CityGoCanaryPlan $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());plan=$plan}|ConvertTo-Json -Depth 5 -Compress`);
    assert.deepEqual(out.calls, []);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.githubRunnerRegistered, false);
    assert.ok(!Object.hasOwn(out.result, "failurePhase"));
    assert.ok(!Object.hasOwn(out.result, "failureCode"));
    assert.equal(
      out.result.targetVhdx,
      out.plan.targetDirectory + "\\canary.vhdx",
    );
    assert.equal(
      out.plan.receiptPath,
      out.plan.controlDirectory + "\\canary-creation.json",
    );
    assert.ok(!out.plan.receiptPath.startsWith(out.plan.targetDirectory));
    assert.equal(out.result.diskIdentifier, null);
  },
);

test(
  "canonical operation, pinned evidence and approved source namespace reject unsafe inputs",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$changes=@(@{operationId='00000000-0000-0000-0000-000000000000'},@{operationId='bad'},@{baseSha256=''},@{sealedBaseEvidenceSha256='x'},@{preflightSha256='X'},
 @{basePath='D:\CityGo-CI\canaries\old\canary.vhdx'},@{basePath='D:\CityGo-CI\bootstrap\..\x.vhdx'},@{basePath='\\host\share\x.vhdx'},@{basePath='D:\CityGo-CI\images\x.vhdx:ads'},@{basePath='D:\CityGo-CI\images\x.avhdx'},
 @{preflightPath='D:\CityGo-CI\control\11111111-1111-4111-8111-111111111111\preflight.json'},@{sealedBaseEvidencePath='D:\CityGo-CI\control\00000000-0000-0000-0000-000000000000\sealed-base.json'},@{sealedBaseEvidencePath='D:\CityGo-CI\control\------------------------------------\sealed-base.json'})
$denied=@();foreach($change in $changes){$r=[ordered]@{};foreach($k in $request.Keys){$r[$k]=$request[$k]};foreach($k in $change.Keys){$r[$k]=$change[$k]};try{$null=Get-CityGoCanaryPlan $r;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 13);
    assert.ok(out.every(Boolean));
  },
);

test(
  "seal is exact flat private attestation, not a permission to admit jobs",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}${evidence}
$plan=Get-CityGoCanaryPlan $request;$now=[DateTimeOffset]::UtcNow
Assert-CityGoCanarySealContent $seal ($seal|ConvertTo-Json -Compress) $plan $now
$changes=@({param($x)$x.toolsReplayed=$false},{param($x)$x.seedDetached='True'},{param($x)$x.bootstrapAccessRemoved=$null},{param($x)$x.ciJobsAdmitted=$true},{param($x)$x.guestIsolationVerified='False'},
 {param($x)$x.baseSha256=('f'*64)},{param($x)$x.basePath='D:\Other\base.vhdx'},{param($x)$x.diskSizeBytes=95GB},{param($x)$x.sourceVmState='Running'},{param($x)$x.observedAt=$now.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ssZ')},
 {param($x)$x|Add-Member -NotePropertyName extra -NotePropertyValue 'not-allowed'})
$denied=@();foreach($change in $changes){$x=$seal|ConvertTo-Json|ConvertFrom-Json;& $change $x;try{Assert-CityGoCanarySealContent $x ($x|ConvertTo-Json -Compress) $plan $now;$denied+=$false}catch{$denied+=$true}}
$raw=$seal|ConvertTo-Json -Compress
foreach($bad in @($raw.Replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'),$raw.Replace('"scope"','"Scope"'),$raw.Replace('"scope"','"sc\u006fpe"'),$raw.Replace('"schemaVersion":1','"schemaVersion":1/*x*/'))){try{Assert-CityGoCanarySealContent $seal $bad $plan $now;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 15);
    assert.ok(out.every(Boolean));
  },
);

test(
  "private host preflight is fresh and never string or false readiness",
  { skip: !available },
  () => {
    const out = run(`${request}${evidence}
$now=[DateTimeOffset]::UtcNow;Assert-CityGoCanaryPreflightContent $preflight $now
$changes=@({param($x)$x.observedAt=$now.AddSeconds(-901).ToString('yyyy-MM-ddTHH:mm:ssZ')},{param($x)$x.observedAt=$now.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ssZ')},
 {param($x)$x.version='2'},{param($x)$x.runnerRegistered='False'},{param($x)$x.diagnostic.readyForVmProvisioning='True'},{param($x)$x.diagnostic.blockers=@('blocked')},
 {param($x)$x.diagnostic.configuredResources.guestDiskGiB=95},{param($x)$x.management.inventoryReadSucceeded=$null})
$denied=@();foreach($change in $changes){$x=$preflight|ConvertTo-Json -Depth 8|ConvertFrom-Json;& $change $x;try{Assert-CityGoCanaryPreflightContent $x $now;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 8);
    assert.ok(out.every(Boolean));
  },
);

test(
  "exact acknowledgement and verified source precede any clone or VM mutation",
  { skip: !available },
  () => {
    const out = run(`${request}${evidence}${mocks}
$request.apply=$true;$denied=$false;try{$null=Invoke-CityGoCanaryVm $request}catch{$denied=$true};$early=@($script:calls.ToArray());$script:calls.Clear()
$request.baseSha256=('a'*64);$seal.baseSha256=$request.baseSha256;$request.acknowledge=(Get-CityGoCanaryPlan $request).requiredAcknowledgement
$result=Invoke-CityGoCanaryVm $request
[ordered]@{denied=$denied;early=$early;result=$result;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.denied, true);
    assert.deepEqual(out.early, []);
    assert.equal(out.result.stage, "failed_preserved_state_unverified");
    assert.equal(out.result.failurePhase, "verify_source_hash");
    assert.equal(out.result.failureCode, "canary_creation_failed");
    assert.ok(!out.calls.includes("mkdir"));
    assert.ok(!out.calls.includes("reset-new-disk-id"));
    assert.ok(!out.calls.includes("new-vm"));
  },
);

test(
  "standalone source validation and destination conflicts cannot adopt existing resources",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}
$disk=@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=100;DiskIdentifier='11111111-2222-4333-8444-555555555555'}
$null=Assert-CityGoCanaryVhd $disk;$denied=@()
foreach($change in @(@{ParentPath='D:\parent.vhdx'},@{Attached=$true},@{Attached='False'},@{Size=(96GB+1)},@{VhdType='Differencing'},@{DiskIdentifier=[guid]::Empty},@{DiskIdentifier='bad'})){
 $x=@{};foreach($k in $disk.Keys){$x[$k]=$disk[$k]};foreach($k in $change.Keys){$x[$k]=$change[$k]};try{$null=Assert-CityGoCanaryVhd $x;$denied+=$false}catch{$denied+=$true}
}
function Assert-CityGoCanaryPlainPath {param($Path,$Directory)}
function Assert-CityGoCanaryPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory)}
function Test-Path {param($LiteralPath,$ErrorAction);return $true}
function Get-VM {throw 'must-not-enumerate-for-existing-target'}
try{Assert-CityGoCanaryDestinationsAbsent (Get-CityGoCanaryPlan $request) 'owner';$denied+=$false}catch{$denied+=($_.Exception.Message -eq 'canary-destination-exists')}
function Test-Path {param($LiteralPath,$ErrorAction);return $false}
function Get-VM {param($ErrorAction);return [pscustomobject]@{Name=(Get-CityGoCanaryPlan $request).vmName}}
try{Assert-CityGoCanaryDestinationsAbsent (Get-CityGoCanaryPlan $request) 'owner';$denied+=$false}catch{$denied+=($_.Exception.Message -eq 'canary-name-exists')}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 9);
    assert.ok(out.every(Boolean));
  },
);

test(
  "mocked apply resets only verified clone ID and records one Off disconnected standalone VM",
  { skip: !available },
  () => {
    const out = run(`${request}${evidence}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryPlan $request).requiredAcknowledgement
$result=Invoke-CityGoCanaryVm $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receipts=$script:receipts;sourceId=$script:sourceDiskId;targetId=$script:targetDiskId}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.result.stage, "created_off_disconnected");
    assert.equal(out.result.vmId, "98765432-1234-4234-8234-123456789abc");
    assert.equal(out.result.diskIdentifier, out.targetId);
    assert.notEqual(out.targetId, out.sourceId);
    assert.equal(out.result.controllerType, "SCSI");
    assert.equal(out.result.controllerNumber, 0);
    assert.equal(out.result.controllerLocation, 0);
    assert.equal(out.result.directoryCreated, true);
    assert.equal(out.result.diskVerified, true);
    assert.equal(out.result.vmCreated, true);
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.githubRunnerRegistered, false);
    assert.ok(!Object.hasOwn(out.result, "failurePhase"));
    assert.ok(!Object.hasOwn(out.result, "failureCode"));
    assert.equal(out.receipts.length, 1);
    assert.equal(out.calls.filter((x) => x === "new-vm").length, 1);
    assert.equal(out.calls.filter((x) => x === "reset-new-disk-id").length, 1);
    assert.ok(
      out.calls.indexOf("verified-copy") <
        out.calls.indexOf("reset-new-disk-id"),
    );
    assert.ok(
      out.calls.indexOf("reset-new-disk-id") < out.calls.indexOf("new-vm"),
    );
    assert.ok(out.calls.indexOf("protect-nic") < out.calls.indexOf("receipt"));
  },
);

test(
  "reset failure and partial creation preserve resources without cleanup or false success",
  { skip: !available },
  () => {
    const out = run(`${request}${evidence}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryPlan $request).requiredAcknowledgement
$script:failReset=$true;$first=Invoke-CityGoCanaryVm $request;$firstCalls=@($script:calls.ToArray());$script:calls.Clear()
$script:failReset=$false;$script:targetDiskId=$script:sourceDiskId;$script:failAt='set-firmware';$second=Invoke-CityGoCanaryVm $request
[ordered]@{first=$first;firstCalls=$firstCalls;second=$second;calls=@($script:calls.ToArray());receipts=$script:receipts}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.first.stage, "failed_preserved_state_unverified");
    assert.equal(out.first.directoryCreated, true);
    assert.equal(out.first.diskVerified, false);
    assert.equal(out.first.vmCreated, false);
    assert.equal(out.first.failurePhase, "verify_reset_canary_disk_identifier");
    assert.equal(out.first.failureCode, "canary_creation_failed");
    assert.ok(!out.firstCalls.includes("new-vm"));
    assert.equal(out.second.stage, "failed_preserved_state_unverified");
    assert.equal(out.second.vmCreated, true);
    assert.equal(out.second.diskVerified, true);
    assert.equal(out.second.failurePhase, "configure_canary_firmware");
    assert.equal(out.second.failureCode, "canary_creation_failed");
    assert.equal(out.receipts.length, 2);
    assert.equal(out.receipts[1].stage, "failed_preserved_state_unverified");
  },
);

test(
  "native reset failure has only fixed safe failed-receipt phase/code and never creates a VM",
  { skip: !available },
  () => {
    const out = run(`${request}${evidence}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryPlan $request).requiredAcknowledgement
$script:failAt='reset-new-disk-id';$result=Invoke-CityGoCanaryVm $request
[ordered]@{result=$result;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.result.stage, "failed_preserved_state_unverified");
    assert.equal(out.result.failurePhase, "reset_canary_disk_identifier");
    assert.equal(out.result.failureCode, "canary_creation_failed");
    assert.equal(out.result.directoryCreated, true);
    assert.equal(out.result.diskVerified, false);
    assert.equal(out.result.vmCreated, false);
    assert.ok(!out.calls.includes("new-vm"));
    assert.doesNotMatch(
      JSON.stringify(out.result),
      /synthetic-failure|native-confirmation-required/,
    );
  },
);

test(
  "postcheck rejects connected or malformed NIC, extra resources and mutable VM state",
  { skip: !available },
  () => {
    const out = run(String.raw`${request}${evidence}${mocks}
$plan=Get-CityGoCanaryPlan $request;$script:targetDiskId=$script:newDiskId
$changes=@({$script:vm.State='Running'},{$script:vm.Path='D:\Other'},{$script:nic.SwitchName='Unexpected'},{$script:nic.Id='Microsoft:98765432-1234-4234-8234-123456789abc\00000000-0000-0000-0000-000000000000'},
 {$script:nic.VMId=[guid]::Empty},{$script:nic.IovWeight=1},{$script:nic.AllowTeaming='On'},{$script:nic.PortMirroringMode='Source'},{$script:firmware.SecureBoot='Off'},
 {function script:Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction);return [pscustomobject]@{Action='Allow'}}},
 {function script:Get-VMDvdDrive {param($VM,$ErrorAction);return [pscustomobject]@{Path='D:\seed.iso'}}})
$denied=@();foreach($change in $changes){
 $script:vm.State='Off';$script:vm.Path=$plan.vmPath;$script:nic.SwitchName='';$script:nic.Id='Microsoft:98765432-1234-4234-8234-123456789abc\33333333-4444-4555-8666-777777777777';$script:nic.VMId=$script:vm.Id;$script:nic.IovWeight=0;$script:nic.AllowTeaming='Off';$script:nic.PortMirroringMode='None';$script:firmware.SecureBoot='On'
 function script:Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction)}
 function script:Get-VMDvdDrive {param($VM,$ErrorAction)}
 & $change
 try{$null=Assert-CityGoStoppedCanary $script:vm $plan $script:newDiskId;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 11);
    assert.ok(out.every(Boolean));
  },
);
