import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/Stop-CityGoOwnedCanaryVm.ps1", import.meta.url),
);
const cleanupPath = fileURLToPath(
  new URL("../deploy/ci/Remove-CityGoCanaryVm.ps1", import.meta.url),
);
const source = readFileSync(path, "utf8");
const shell = "powershell.exe";
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10000,
  }).status === 0;

function run(command) {
  // Parse definitions ONLY; neither entrypoint nor native VM commands run.
  // Every inventory, clock, shutdown and evidence I/O below is mocked.
  const code = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @('${cleanupPath.replaceAll("'", "''")}','${path.replaceAll("'", "''")}')){
 $tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'parse-failed'}
 foreach($definition in $ast.FindAll({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($definition.Extent.Text))}
}
${command}`;
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(code, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const fixture = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$vmId='98765432-1234-4234-8234-123456789abc';$diskId='11111111-2222-4333-8444-555555555555'
$target='D:\CityGo-CI\canaries\'+$op;$name='citygo-ci-canary-'+$op;$control='D:\CityGo-CI\control\'+$op
$manifest=[pscustomobject][ordered]@{schemaVersion=1;scope='local_canary_creation';operationId=$op;vmName=$name;vmId=$vmId;
 nicId=('Microsoft:'+$vmId+'\22222222-3333-4444-8555-666666666666');nicName='Network Adapter';targetDirectory=$target;targetVhdx=($target+'\canary.vhdx');vmPath=($target+'\'+$name);
 diskIdentifier=$diskId;diskSizeBytes=[long]103079215104;diskFormat='VHDX';diskType='Dynamic';controllerType='SCSI';controllerNumber=0;controllerLocation=0;
 sourceBaseSha256=('a'*64);sealedBaseEvidenceSha256=('b'*64);preflightSha256=('c'*64);stage='created_off_disconnected';directoryCreated=$true;diskVerified=$true;vmCreated=$true;guestIsolationVerified=$false;githubRunnerRegistered=$false}
$request=[ordered]@{operationId=$op;vmId=$vmId;manifestSha256=('d'*64);resumedCreation=$false;seedPath='';seedSha256='';graceSeconds=1;turnOffSeconds=1;apply=$false;acknowledge=''}
`;

const mocks = String.raw`
$script:fixtureManifest=$manifest
$script:calls=[Collections.Generic.List[string]]::new();$script:receipts=@{};$script:held=[Collections.Generic.List[object]]::new()
$script:now=[DateTimeOffset]::Parse('2026-10-19T00:00:00Z');$script:gracefulWorks=$true;$script:turnOffWorks=$true;$script:failAt='';$script:foreign=$false
$script:vm=[pscustomobject]@{Id=[guid]$vmId;Name=$name;Path=$script:fixtureManifest.vmPath;State='Running';Generation=2;ProcessorCount=4;MemoryStartup=6GB;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false}
$script:nic=[pscustomobject]@{Id=$script:fixtureManifest.nicId;VMId=[guid]$vmId;Name=$script:fixtureManifest.nicName;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovWeight=0;IovQueuePairsAssigned=0;IovUsage=0;PortMirroringMode='None';AllowTeaming='Off'}
$script:vhd=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$true;Size=96GB;FileSize=1000;DiskIdentifier=[string]$diskId}
$script:dvd=[pscustomobject]@{Path=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=1}
$script:component=[pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='Msvm_ShutdownComponent'};SystemCreationClassName='Msvm_ComputerSystem';SystemName=$vmId;DeviceID=('Microsoft:'+$vmId+'\33333333-4444-4555-8666-777777777777');EnabledState=2;OperationalStatus=@(2)}
function Track([string]$Name){$script:calls.Add($Name);if($script:failAt-ceq$Name){throw 'PRIVATE_NATIVE_ERROR_NOT_FOR_JSON'}}
function SetOff {$script:vm.State='Off';$script:vhd.Attached=$false}
function Get-CityGoCanaryStopOwner {Track 'admin';return 'S-1-5-21-1-2-3-1001'}
function Import-CityGoCanaryStopReadOnlyGuards {param($Plan,$OwnerSid);Track 'import-pinned';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory);Track 'plain'}
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash)
 Track 'read-evidence';$s=[IO.MemoryStream]::new();$script:held.Add($s)
 if($Path-ceq($control+'\canary-creation.json') -and $ExpectedHash-ceq('d'*64)){return @{value=$script:fixtureManifest;stream=$s}}
 if($script:receipts.ContainsKey($Path)){return @{value=($script:receipts[$Path]|ConvertTo-Json -Compress|ConvertFrom-Json);stream=$s}}
 $s.Dispose();throw 'evidence_hash_mismatch'
}
function Open-CityGoCanaryStopRaw {param($Path,$OwnerSid,$ExpectedHash,$MaximumBytes,$SeedVmSid)
 Track 'lock-seed';if($Path-cne$request.seedPath -or $ExpectedHash-cne$request.seedSha256 -or $MaximumBytes-ne32MB -or $SeedVmSid-cne'S-1-5-83-1-2-3-4'){throw 'wrong-seed-binding'}
 $s=[IO.MemoryStream]::new();$script:held.Add($s);return $s
}
function Get-CityGoCanaryStopVmSid {param($Plan);Track 'vm-sid';return 'S-1-5-83-1-2-3-4'}
function Write-CityGoCanaryStopReceipt {param($Path,$Receipt,$Plan,$OwnerSid)
 Track 'write-receipt';if($script:receipts.ContainsKey($Path)){throw 'overwrite-forbidden'}
 $script:receipts[$Path]=($Receipt|ConvertTo-Json -Compress|ConvertFrom-Json)
}
function Test-Path {param($LiteralPath,$ErrorAction);return $script:receipts.ContainsKey($LiteralPath)}
function Get-VM {param($ErrorAction);Track 'get-vms';$script:vm;if($script:foreign){[pscustomobject]@{Id=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';Name='foreign';Path='D:\Foreign'}}}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get-drives';[pscustomobject]@{Path=$script:fixtureManifest.targetVhdx;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}}
function Get-VHD {param($Path,$ErrorAction);Track 'get-vhd';return $script:vhd}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'firmware';[pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}}
function Get-VMNetworkAdapter {param($VM,[switch]$All,$ErrorAction);Track 'get-nics';return $script:nic}
function Get-VMDvdDrive {param($VM,$ErrorAction);Track 'get-dvds';return $script:dvd}
function Get-VMSnapshot {param($VM,$ErrorAction);Track 'snapshots'}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'devices'}
function Get-CimInstance {param($Namespace,$ClassName,$Filter,$OperationTimeoutSec,$ErrorAction)
 Track 'cim-read';if($Namespace-cne'root/virtualization/v2' -or $ClassName-cne'Msvm_ShutdownComponent' -or $Filter-cne("SystemName = '"+$vmId+"'") -or $OperationTimeoutSec-lt1 -or $OperationTimeoutSec-gt5){throw 'unbound-cim'}
 return $script:component
}
function Invoke-CimMethod {param($InputObject,$MethodName,$Arguments,$OperationTimeoutSec,$ErrorAction)
 Track 'graceful';if($InputObject-ne$script:component -or $MethodName-cne'InitiateShutdown' -or $Arguments.Force-ne$false -or $OperationTimeoutSec-lt1 -or $OperationTimeoutSec-gt5){throw 'unsafe-graceful'}
 if($script:gracefulWorks){SetOff};return [pscustomobject]@{ReturnValue=[uint32]0}
}
function Stop-VM {param($VM,[switch]$TurnOff,[switch]$AsJob,[switch]$Confirm,$ErrorAction)
 Track 'turnoff';if(-not $TurnOff -or -not $AsJob -or $Confirm -or $VM.Id.ToString('D')-cne$vmId -or $VM.State-cne'Running' -or $script:now-lt[DateTimeOffset]::Parse('2026-10-19T00:00:01Z')){throw 'unsafe-stop'}
 if($script:turnOffWorks){SetOff};return $null
}
function Get-CityGoCanaryStopNow {return $script:now}
function Start-Sleep {param($Milliseconds);Track 'sleep';if($Milliseconds-ne250){throw 'unbounded-wait'};$script:now=$script:now.AddMilliseconds($Milliseconds)}
`;

const invoke = String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryStopPlan $request).requiredAcknowledgement
$result=Invoke-CityGoOwnedCanaryStop $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receipts=$script:receipts.Count;now=$script:now.ToString('o');closed=(@($script:held|Where-Object{$_.CanRead}).Count -eq 0)}|ConvertTo-Json -Depth 6 -Compress
`;

test("stop source permits only exact graceful CIM and deadline TurnOff; no Force/save/deletion/network/base operations", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(cleanupPath)).digest("hex"),
    "70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098",
    "Read-only guard source must be re-reviewed rather than silently adopting a new helper",
  );
  assert.doesNotMatch(
    source,
    /^\s*(?:Stop-VM[^\r\n]*-Force\b|(?:Remove-VM|Remove-Item|Stop-Job|Start-VM|Set-VHD|Set-VM|Disconnect-VMNetworkAdapter|Connect-VMNetworkAdapter|Set-Acl|Start-Process)\b)/im,
  );
  assert.doesNotMatch(
    source,
    /\$env:|Exception\.Message|Wait-Job|Receive-Job|Get-Job|Invoke-Expression|\.\s+\$Plan\.helperPath/,
  );
  assert.match(
    source,
    /Stop-VM -VM \$vm -TurnOff -AsJob -Confirm:\$false -ErrorAction Stop/,
  );
  assert.equal((source.match(/^\s*\$jobs\+=,\(Stop-VM/gm) || []).length, 1);
  assert.match(
    source,
    /Force=\$false;Reason='CityGo owned disposable canary shutdown'/,
  );
  assert.match(source, /OperationTimeoutSec \$timeout/);
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\$stream\.Flush\(\$true\)/);
  assert.match(
    source,
    /70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098/,
  );
});

test(
  "pure default plan performs no filesystem/admin/native/shutdown reads",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$r=Invoke-CityGoOwnedCanaryStop $request
[ordered]@{result=$r;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.equal(out.result.vmOff, false);
    assert.equal(out.result.ciJobsAdmitted, false);
    assert.deepEqual(out.calls, []);
  },
);

test(
  "strict plan binds canonical IDs, bounded deadlines, closed seed names and paired seed hash",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}
$accepted=@();foreach($filename in @('offline-cidata.iso','network-cidata.iso','lifecycle-cidata.iso','runner-cidata.iso')){
 $request.seedPath='D:\CityGo-CI\seeds\'+$op+'\'+$filename;$request.seedSha256=('a'*64);$accepted+=((Get-CityGoCanaryStopPlan $request).seedPath-ceq$request.seedPath)
}
$request.seedPath='';$request.seedSha256='';$bad=@()
foreach($kind in @('guid','upper-hash','grace-zero','grace-large','final-zero','final-large','one-seed','one-hash','other-op','arbitrary-seed','boolean-string')){
 $r=[ordered]@{};foreach($key in $request.Keys){$r[$key]=$request[$key]}
 if($kind-eq'guid'){$r.vmId='invalid'};if($kind-eq'upper-hash'){$r.manifestSha256=('D'*64)}
 if($kind-eq'grace-zero'){$r.graceSeconds=0};if($kind-eq'grace-large'){$r.graceSeconds=121}
 if($kind-eq'final-zero'){$r.turnOffSeconds=0};if($kind-eq'final-large'){$r.turnOffSeconds=61}
 if($kind-eq'one-seed'){$r.seedPath='D:\CityGo-CI\seeds\'+$op+'\network-cidata.iso'}
 if($kind-eq'one-hash'){$r.seedSha256=('a'*64)}
 if($kind-eq'other-op'){$r.seedPath='D:\CityGo-CI\seeds\aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\network-cidata.iso';$r.seedSha256=('a'*64)}
 if($kind-eq'arbitrary-seed'){$r.seedPath='D:\CityGo-CI\seeds\'+$op+'\custom.iso';$r.seedSha256=('a'*64)}
 if($kind-eq'boolean-string'){$r.resumedCreation='false'}
 try{$null=Get-CityGoCanaryStopPlan $r;$bad+=$false}catch{$bad+=$true}
}
[ordered]@{accepted=$accepted;denied=$bad}|ConvertTo-Json -Compress`);
    assert.deepEqual(out.accepted, Array(4).fill(true));
    assert.deepEqual(out.denied, Array(11).fill(true));
  },
);

test(
  "typed acknowledgement is required before any privileged or host operation",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$denied=$false;try{$null=Invoke-CityGoOwnedCanaryStop $request}catch{$denied=$true}
[ordered]@{denied=$denied;calls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, { denied: true, calls: [] });
  },
);

test(
  "complete manifest raw hash and requested VM identity fail before all native inventory",
  { skip: !available },
  () => {
    for (const change of [
      "$request.manifestSha256=('a'*64)",
      "$request.vmId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'",
      "$script:fixtureManifest.vmCreated=$false",
    ]) {
      const out = run(`${fixture}${mocks}${change}
${invoke}`);
      assert.equal(out.result.stage, "failed_preserved_requires_inspection");
      assert.ok(!out.calls.includes("get-vms"));
      assert.equal(out.receipts, 0);
      assert.equal(out.closed, true);
    }
  },
);

test(
  "resumed COMPLETE creation holds both raw-hash linked proofs before all native operations",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}${mocks}
$initial=($manifest|ConvertTo-Json -Compress|ConvertFrom-Json)
$initial.stage='failed_preserved_state_unverified';$initial.diskVerified=$false;$initial.vmCreated=$false
foreach($key in @('vmId','nicId','nicName','diskIdentifier','diskType')){$initial.$key=$null}
$initial.preflightSha256=('0'*64)
$manifest|Add-Member -MemberType NoteProperty -Name initialCreationReceiptSha256 -Value ('e'*64)
$manifest|Add-Member -MemberType NoteProperty -Name resumeVerificationSha256 -Value ('f'*64)
$request.resumedCreation=$true
$proof=[pscustomobject][ordered]@{schemaVersion=1;scope='verified_owned_copy_before_resume';operationId=$op;
initialCreationReceiptSha256=('e'*64);sourceBaseSha256=$manifest.sourceBaseSha256;targetSha256=$manifest.sourceBaseSha256;
sourceDiskIdentifier='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';targetDiskIdentifier='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
noVmOrReferencesObserved=$true;sourceVmOff=$true;targetStandaloneUnattached=$true;targetTreeOnlyDisk=$true;guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash)
 $s=[IO.MemoryStream]::new();$script:held.Add($s)
 if($Path-ceq($control+'\canary-resume-creation.json') -and $ExpectedHash-ceq('d'*64)){Track 'read-manifest';return @{value=$script:fixtureManifest;stream=$s}}
 if($Path-ceq($control+'\canary-creation.json') -and $ExpectedHash-ceq('e'*64)){Track 'read-initial';return @{value=$initial;stream=$s}}
 if($Path-ceq($control+'\canary-resume-verification.json') -and $ExpectedHash-ceq('f'*64)){Track 'read-proof';return @{value=$proof;stream=$s}}
 throw 'evidence_hash_mismatch'
}
${invoke}`);
    assert.equal(out.result.stage, "stopped_off_verified");
    assert.ok(out.calls.indexOf("read-initial") < out.calls.indexOf("get-vms"));
    assert.ok(out.calls.indexOf("read-proof") < out.calls.indexOf("get-vms"));
    assert.equal(out.closed, true);
  },
);

test(
  "successful guest shutdown creates durable intent before CIM and verifies Off without TurnOff",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}${invoke}`);
    assert.equal(out.result.stage, "stopped_off_verified");
    assert.equal(out.result.vmOff, true);
    assert.equal(out.result.ciJobsAdmitted, false);
    assert.equal(out.receipts, 2);
    assert.ok(
      out.calls.indexOf("write-receipt") < out.calls.indexOf("graceful"),
    );
    assert.equal(out.calls.filter((x) => x === "graceful").length, 1);
    assert.ok(!out.calls.includes("turnoff"));
    assert.equal(out.closed, true);
  },
);

test(
  "Stopping is observed only during bounded waits, never admitted for a new stop command",
  { skip: !available },
  () => {
    for (const fallback of [false, true]) {
      const out = run(`${fixture}${mocks}
$script:gracefulWorks=${fallback ? "$false" : "$true"}
function Invoke-CimMethod {param($InputObject,$MethodName,$Arguments,$OperationTimeoutSec,$ErrorAction)
 Track 'graceful';if($script:gracefulWorks){$script:vm.State='Stopping'};return [pscustomobject]@{ReturnValue=[uint32]0}
}
function Stop-VM {param($VM,[switch]$TurnOff,[switch]$AsJob,[switch]$Confirm,$ErrorAction)
 Track 'turnoff';if(-not $TurnOff -or -not $AsJob -or $Confirm -or $VM.State-cne'Running'){throw 'unsafe-stop'}
 $script:vm.State='Stopping';return $null
}
function Start-Sleep {param($Milliseconds)
 Track 'sleep';$script:now=$script:now.AddMilliseconds($Milliseconds)
 if($script:vm.State-ceq'Stopping'){SetOff}
}
${invoke}`);
      assert.equal(out.result.stage, "stopped_off_verified");
      assert.equal(out.calls.filter((x) => x === "graceful").length, 1);
      assert.equal(
        out.calls.filter((x) => x === "turnoff").length,
        fallback ? 1 : 0,
      );
      assert.equal(
        out.calls.filter((x) => x === "sleep").length,
        fallback ? 5 : 1,
      );
    }
  },
);

test(
  "already Off is verified honestly without invoking either shutdown primitive",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}SetOff
${invoke}`);
    assert.equal(out.result.stage, "stopped_off_verified");
    assert.ok(!out.calls.includes("graceful"));
    assert.ok(!out.calls.includes("turnoff"));
    assert.equal(out.receipts, 2);
  },
);

test(
  "unresponsive guest gets one TurnOff only after durable deadline and fresh native checks",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}$script:gracefulWorks=$false
${invoke}`);
    assert.equal(out.result.stage, "stopped_off_verified");
    assert.equal(out.receipts, 3);
    assert.equal(out.calls.filter((x) => x === "turnoff").length, 1);
    assert.equal(out.calls.filter((x) => x === "sleep").length, 4);
    const turnOff = out.calls.indexOf("turnoff");
    assert.ok(
      out.calls.lastIndexOf("write-receipt", turnOff) >
        out.calls.indexOf("sleep"),
    );
    assert.ok(
      out.calls.lastIndexOf("get-vhd", turnOff) >
        out.calls.lastIndexOf("write-receipt", turnOff),
    );
  },
);

test(
  "shutdown integration missing/degraded and CIM failure never trigger immediate TurnOff",
  { skip: !available },
  () => {
    for (const change of [
      "$script:component.EnabledState=3",
      "$script:component.OperationalStatus=@(12)",
      "function Get-CimInstance {param($Namespace,$ClassName,$Filter,$OperationTimeoutSec,$ErrorAction);Track 'cim-read'}",
      "$script:failAt='graceful'",
      "function Invoke-CimMethod {param($InputObject,$MethodName,$Arguments,$OperationTimeoutSec,$ErrorAction);Track 'graceful';return [pscustomobject]@{ReturnValue=[uint32]32781}}",
    ]) {
      const out = run(`${fixture}${mocks}${change}
${invoke}`);
      assert.equal(out.result.stage, "stopped_off_verified", change);
      assert.equal(out.calls.filter((x) => x === "turnoff").length, 1, change);
      assert.equal(out.calls.filter((x) => x === "sleep").length, 4, change);
    }
  },
);

test(
  "wrong CIM VM/class/device association refuses shutdown without poweroff",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}${mocks}
$denied=@();foreach($kind in @('vm','class','device','system-class')){
 $script:receipts=@{};$script:calls.Clear();$script:component.SystemName=$vmId;$script:component.CimClass.CimClassName='Msvm_ShutdownComponent';$script:component.DeviceID='Microsoft:'+$vmId+'\33333333-4444-4555-8666-777777777777';$script:component.SystemCreationClassName='Msvm_ComputerSystem'
 if($kind-eq'vm'){$script:component.SystemName='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}
 if($kind-eq'class'){$script:component.CimClass.CimClassName='foreign'}
 if($kind-eq'device'){$script:component.DeviceID='foreign'}
 if($kind-eq'system-class'){$script:component.SystemCreationClassName='foreign'}
 $request.apply=$true;$request.acknowledge=(Get-CityGoCanaryStopPlan $request).requiredAcknowledgement
 $r=Invoke-CityGoOwnedCanaryStop $request
 $denied+=($r.stage-ceq'failed_preserved_requires_inspection' -and -not $script:calls.Contains('graceful') -and -not $script:calls.Contains('turnoff'))
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, Array(4).fill(true));
  },
);

test(
  "never report success until final Off; timeouts are bounded and reveal no native details",
  { skip: !available },
  () => {
    const out =
      run(`${fixture}${mocks}$script:gracefulWorks=$false;$script:turnOffWorks=$false
${invoke}`);
    assert.equal(out.result.stage, "failed_preserved_requires_inspection");
    assert.equal(out.result.vmOff, false);
    assert.equal(out.result.failureCode, "owned_canary_stop_failed");
    assert.equal(out.result.failurePhase, "wait_turnoff_off_readback");
    assert.equal(out.calls.filter((x) => x === "turnoff").length, 1);
    assert.equal(out.calls.filter((x) => x === "sleep").length, 8);
    assert.equal(out.receipts, 2);
    assert.doesNotMatch(JSON.stringify(out.result), /PRIVATE_NATIVE/);
  },
);

test(
  "Saved/Paused/unknown and modified VM/NIC/disk/firmware/snapshot/DDA preserve all resources before intent",
  { skip: !available },
  () => {
    for (const change of [
      "$script:vm.State='Saved'",
      "$script:vm.State='Paused'",
      "$script:vm.State='Stopping'",
      "$script:vm.Name='foreign'",
      "$script:vm.MemoryStartup=7GB",
      "$script:nic.Id='foreign'",
      "$script:nic.RouterGuard='Off'",
      "$script:vhd.DiskIdentifier='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'",
      "$script:vhd.ParentPath='D:\\foreign.vhdx'",
      "SetOff;$script:vhd.Attached=$true",
      "function Get-VMFirmware {param($VM,$ErrorAction);[pscustomobject]@{SecureBoot='Off';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}}",
      "function Get-VMSnapshot {param($VM,$ErrorAction);return 'snapshot'}",
      "function Get-VMAssignableDevice {param($VM,$ErrorAction);return 'device'}",
      "$script:foreign=$true",
    ]) {
      const out = run(`${fixture}${mocks}${change}
${invoke}`);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        change,
      );
      assert.equal(out.receipts, 0, change);
      assert.ok(!out.calls.includes("graceful"), change);
      assert.ok(!out.calls.includes("turnoff"), change);
    }
  },
);

test(
  "native string/uppercase/Guid disk identifiers remain semantically bound to immutable manifest",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$p=Get-CityGoCanaryStopPlan $request;$b=Get-CityGoCanaryCleanupPlan $manifest @{manifestPath=$p.manifestPath;manifestSha256=$p.manifestSha256}
foreach($key in @('vmName','nicId','nicName','targetDirectory','targetVhdx','vmPath','diskIdentifier','diskType')){$p[$key]=$b[$key]}
$accepted=@();foreach($id in @([string]$diskId,$diskId.ToUpperInvariant(),[guid]$diskId)){$script:vhd.DiskIdentifier=$id;$accepted+=((Get-CityGoCanaryStopNative $p).Id.ToString('D')-ceq$vmId)}
$denied=@();foreach($id in @($null,'invalid',7,[guid]::Empty)){$script:vhd.DiskIdentifier=$id;try{$null=Get-CityGoCanaryStopNative $p;$denied+=$false}catch{$denied+=$true}}
[ordered]@{accepted=$accepted;denied=$denied}|ConvertTo-Json -Compress`);
    assert.deepEqual(out.accepted, Array(3).fill(true));
    assert.deepEqual(out.denied, Array(4).fill(true));
  },
);

test(
  "empty DVD or exact SHA-locked seed only; foreign/missing media is refused",
  { skip: !available },
  () => {
    const good = run(String.raw`${fixture}${mocks}
$request.seedPath='D:\CityGo-CI\seeds\'+$op+'\network-cidata.iso';$request.seedSha256=('a'*64);$script:dvd.Path=$request.seedPath
${invoke}`);
    assert.equal(good.result.stage, "stopped_off_verified");
    assert.ok(good.calls.indexOf("lock-seed") < good.calls.indexOf("get-vms"));
    for (const change of [
      "$script:dvd.Path='D:\\unowned.iso'",
      "$request.seedPath='D:\\CityGo-CI\\seeds\\'+$op+'\\network-cidata.iso';$request.seedSha256=('a'*64)",
      "$script:dvd.ControllerLocation=2",
    ]) {
      const out = run(`${fixture}${mocks}${change}
${invoke}`);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        change,
      );
      assert.equal(out.receipts, 0, change);
      assert.ok(!out.calls.includes("graceful"));
    }
  },
);

test(
  "resume holds exact durable intent, skips duplicate graceful dispatch and can perform authorized fallback once",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryStopPlan $request).requiredAcknowledgement
$script:failAt='cim-read';$first=Invoke-CityGoOwnedCanaryStop $request
$script:failAt='';$script:calls.Clear();$script:now=$script:now.AddSeconds(1)
$second=Invoke-CityGoOwnedCanaryStop $request;$secondCalls=@($script:calls.ToArray())
$script:calls.Clear();$third=Invoke-CityGoOwnedCanaryStop $request
[ordered]@{first=$first;second=$second;secondCalls=$secondCalls;third=$third;thirdCalls=@($script:calls.ToArray());receipts=$script:receipts.Count}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.first.stage, "failed_preserved_requires_inspection");
    assert.equal(out.first.stopIntentRecorded, true);
    assert.equal(out.second.stage, "stopped_off_verified");
    assert.ok(!out.secondCalls.includes("graceful"));
    assert.equal(out.secondCalls.filter((x) => x === "turnoff").length, 1);
    assert.equal(out.third.stage, "stopped_off_verified");
    assert.ok(!out.thirdCalls.includes("graceful"));
    assert.ok(!out.thirdCalls.includes("turnoff"));
    assert.ok(!out.thirdCalls.includes("write-receipt"));
    assert.equal(out.receipts, 3);
  },
);

test(
  "interruption after TurnOff intent never resubmits ambiguous pending native command",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryStopPlan $request).requiredAcknowledgement
$script:gracefulWorks=$false;$script:failAt='turnoff';$first=Invoke-CityGoOwnedCanaryStop $request
$script:failAt='';$script:calls.Clear();$second=Invoke-CityGoOwnedCanaryStop $request
[ordered]@{first=$first;second=$second;calls=@($script:calls.ToArray());receipts=$script:receipts.Count}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.first.failurePhase, "submit_authorized_turnoff_once");
    assert.equal(out.second.failurePhase, "wait_turnoff_off_readback");
    assert.ok(!out.calls.includes("turnoff"));
    assert.ok(!out.calls.includes("graceful"));
    assert.equal(out.receipts, 2);
  },
);

test(
  "wrong intent fields, booleans/deadlines or VM restarted after completion never authorize another stop",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryStopPlan $request).requiredAcknowledgement
$null=Invoke-CityGoOwnedCanaryStop $request
$p=Get-CityGoCanaryStopPlan $request;$complete=$script:receipts[$p.resultPath];$original=$script:receipts[$p.intentPath]
$blocked=@();foreach($kind in @('id','hash','bool','extra','future','deadline')){
 $script:vm.State='Running';$script:vhd.Attached=$true;$script:receipts=@{};$script:calls.Clear()
 $r=($original|ConvertTo-Json -Compress|ConvertFrom-Json)
 if($kind-eq'id'){$r.vmId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};if($kind-eq'hash'){$r.creationManifestSha256=('a'*64)}
 if($kind-eq'bool'){$r.ciJobsAdmitted='false'};if($kind-eq'extra'){$r|Add-Member -MemberType NoteProperty -Name extra -Value $false}
 if($kind-eq'future'){$r.observedAt='2099-10-19T00:00:00.0000000Z'};if($kind-eq'deadline'){$r.graceDeadline='2026-10-19T00:10:00.0000000Z'}
 $script:receipts[$p.intentPath]=$r;$result=Invoke-CityGoOwnedCanaryStop $request
 $blocked+=($result.stage-ceq'failed_preserved_requires_inspection' -and -not $script:calls.Contains('graceful') -and -not $script:calls.Contains('turnoff'))
}
$script:receipts=@{};$script:receipts[$p.resultPath]=$complete;$script:calls.Clear();$restarted=Invoke-CityGoOwnedCanaryStop $request
[ordered]@{blocked=$blocked;restarted=$restarted;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 5 -Compress`);
    assert.deepEqual(out.blocked, Array(6).fill(true));
    assert.equal(out.restarted.stage, "failed_preserved_requires_inspection");
    assert.equal(out.restarted.failurePhase, "verify_existing_stop_result");
    assert.ok(!out.calls.includes("turnoff"));
  },
);

test(
  "fresh ownership change after deadline blocks TurnOff even after graceful intent",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$script:gracefulWorks=$false
function Start-Sleep {param($Milliseconds);$script:now=$script:now.AddMilliseconds($Milliseconds);if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:01Z')){$script:nic.Id='replaced'}}
${invoke}`);
    assert.equal(out.result.stage, "failed_preserved_requires_inspection");
    assert.ok(!out.calls.includes("turnoff"));
    assert.equal(out.receipts, 1);
  },
);

test(
  "pinned read-only guard importer loads named definitions only, never cleanup entrypoint/mutators",
  { skip: !available },
  () => {
    const out = run(`${fixture}
$script:closed=$null;$script:pin=$null
function Open-CityGoCanaryStopRaw {param($Path,$OwnerSid,$ExpectedHash,$MaximumBytes,$SeedVmSid)
 $script:pin=$ExpectedHash;$bytes=[IO.File]::ReadAllBytes('${cleanupPath.replaceAll("'", "''")}');$script:closed=[IO.MemoryStream]::new($bytes);return $script:closed
}
Remove-Item -LiteralPath 'Function:Invoke-CityGoCanaryCleanup' -ErrorAction SilentlyContinue
$plan=Get-CityGoCanaryStopPlan $request;$stream=Import-CityGoCanaryStopReadOnlyGuards $plan 'S-1-5-21-1-2-3-1001'
$binding=Get-CityGoCanaryCleanupPlan $manifest @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
[ordered]@{pin=$script:pin;held=$stream.CanRead;vmId=$binding.vmId;mutatorLoaded=[bool](Get-Command Invoke-CityGoCanaryCleanup -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress
$stream.Dispose()`);
    assert.equal(
      out.pin,
      "70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098",
    );
    assert.equal(out.held, true);
    assert.equal(out.vmId, "98765432-1234-4234-8234-123456789abc");
    assert.equal(out.mutatorLoaded, false);
  },
);

test(
  "only exact seed VM SID read rights are allowed; control ACLs never permit VM capability",
  { skip: !available },
  () => {
    const out = run(String.raw`
$owner='S-1-5-21-1-2-3-1001';$script:grant='S-1-5-83-1-2-3-4';$script:rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute
function Get-Acl {param($LiteralPath,$ErrorAction)
 $a=[pscustomobject]@{AreAccessRulesProtected=$true}
 $a|Add-Member -MemberType ScriptMethod -Name GetOwner -Value {param($Type);[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'}}
 $a|Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {param($x,$y,$z);[pscustomobject]@{AccessControlType=[Security.AccessControl.AccessControlType]::Allow;IdentityReference=[pscustomobject]@{Value=$script:grant};FileSystemRights=$script:rights}}
 return $a
}
Assert-CityGoCanaryStopAcl 'D:\synthetic.iso' $owner $false 'S-1-5-83-1-2-3-4'
$bad=@();foreach($kind in @('control','other-vm','all-vms','write','everyone')){
 $script:grant='S-1-5-83-1-2-3-4';$script:rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute;$seed='S-1-5-83-1-2-3-4'
 if($kind-eq'control'){$seed=''};if($kind-eq'other-vm'){$script:grant='S-1-5-83-9-9-9-9'};if($kind-eq'all-vms'){$script:grant='S-1-5-83-0'};if($kind-eq'everyone'){$script:grant='S-1-1-0'};if($kind-eq'write'){$script:rights=[Security.AccessControl.FileSystemRights]::FullControl}
 try{Assert-CityGoCanaryStopAcl 'D:\synthetic' $owner $true $seed;$bad+=$false}catch{$bad+=$true}
}
ConvertTo-Json -InputObject $bad -Compress`);
    assert.deepEqual(out, Array(5).fill(true));
  },
);

test(
  "seed read capability reaches both the parent directory and file, never helper/control reads",
  { skip: !available },
  () => {
    const out = run(String.raw`
$script:checks=[Collections.Generic.List[object]]::new()
function Assert-CityGoCanaryStopPlainPath {param($Path,$Directory)}
function Assert-CityGoCanaryStopAcl {param($Path,$OwnerSid,$ProtectedDirectory,$SeedVmSid)
 $script:checks.Add([ordered]@{directory=[bool]$ProtectedDirectory;seedSid=[string]$SeedVmSid})
}
$stream=Open-CityGoCanaryStopRaw '${path.replaceAll("'", "''")}' 'S-1-5-21-1-2-3-1001' '${createHash("sha256").update(source).digest("hex")}' 65536 'S-1-5-83-1-2-3-4'
$stream.Dispose()
$stream=Open-CityGoCanaryStopRaw '${path.replaceAll("'", "''")}' 'S-1-5-21-1-2-3-1001' '${createHash("sha256").update(source).digest("hex")}'
$stream.Dispose()
ConvertTo-Json -InputObject @($script:checks.ToArray()) -Compress`);
    assert.deepEqual(out, [
      { directory: true, seedSid: "S-1-5-83-1-2-3-4" },
      { directory: false, seedSid: "S-1-5-83-1-2-3-4" },
      { directory: true, seedSid: "" },
      { directory: false, seedSid: "" },
    ]);
  },
);
