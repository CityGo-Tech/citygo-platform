// Only AST-checked function definitions run. All native and filesystem I/O is
// mocked; tests cannot detach a DVD, disconnect a NIC or modify a real file/VM.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/Finalize-CityGoSealedBase.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell =
  process.platform === "win32"
    ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    : "pwsh";
const allowed = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "PATH",
  "TEMP",
  "TMP",
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())),
);
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    env,
    windowsHide: true,
    timeout: 10000,
  }).status === 0;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const sha = (value) => createHash("sha256").update(value).digest("hex");

function run(command) {
  const input = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse_failed'}
$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|ForEach-Object{$_.Name})
$native=@('ConvertFrom-Json','ConvertTo-Json','Get-Acl','Get-Item','Get-VM','Get-VMHardDiskDrive','Get-VHD',
 'Get-VMFirmware','Get-VMAssignableDevice','Get-VMNetworkAdapter','Get-VMDvdDrive','Set-VMDvdDrive',
 'Disconnect-VMNetworkAdapter','Test-Path','Where-Object','Start-Sleep')
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
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const op = "12345678-1234-4234-8234-123456789abc";
const vmId = "33333333-3333-4333-8333-333333333333";
const control = `D:\\CityGo-CI\\control\\${op}`;
const diskBytes =
  "synthetic CURRENT post-seal stopped disk, not historical bytes";
const isoBytes = "synthetic opaque ISO, never parsed or extracted";
const seal = {
  version: 1,
  scope: "trusted_bootstrap_auth_seal",
  operationId: op,
  installerReportSha256: "a".repeat(64),
  code: "guest_auth_sealed_poweroff_required",
  ok: true,
  mutationsStarted: true,
  preflightPassed: true,
  bootstrapAuthorizedKeyAbsent: true,
  bootstrapSudoRuleRemovedOtherEntriesPreserved: true,
  fixedHostKeysAbsent: true,
  persistentCloudArtifactsAbsent: true,
  machineIdUninitialized: true,
  cloudInitLogsAbsent: true,
  installerReportPreserved: true,
  volatileRuntimeDataMayRemainUntilPoweroff: true,
  vmPoweredOff: false,
  seedIsoDetached: false,
  guestIsolationVerified: false,
  githubJobsAuthorized: false,
  goldenImageSealed: false,
  freshCloneIdentityVerified: false,
};
const replay = {
  version: 1,
  scope: "trusted_bootstrap_tools_replay",
  allSelectedChecksPassed: true,
  guestIsolationVerified: false,
  githubJobsAuthorized: false,
  goldenImageSealed: false,
  versions: {
    node: { state: "observed", matchesExpected: true, observed: "v24.22.0" },
    pnpm: { state: "observed", matchesExpected: true, observed: "10.15.0" },
    python: { matchesExpectedMajorMinor: true, observed: "3.12.3" },
  },
  compose: { state: "observed", observedVersion: "2.24.6+ds1-0ubuntu2" },
  buildx: { state: "observed", observedVersion: "0.20.1+ds1-0ubuntu1" },
  docker: {
    state: "observed",
    nativeLinuxLayoutMatches: true,
    osType: "linux",
    socketType: "unix_socket",
    endpoint: "unix:///var/run/docker.sock",
    rootDir: "/var/lib/docker",
  },
  mounts: {
    state: "observed",
    noForbiddenTypesObserved: true,
    provesHostIsolation: false,
    forbiddenTypesObserved: [],
    types: ["ext4", "tmpfs", "proc"],
  },
  chromium: {
    ok: true,
    dataUriOnly: true,
    contextOffline: true,
    chromiumSandboxRequested: false,
    provesNetworkIsolation: false,
    code: "data_uri_smoke_passed",
    externalPageRequests: 0,
    browserVersion: "149.0.0.0",
  },
  containerRuntimeSmoke: {
    attempted: false,
    runtimeExecutionVerified: false,
    reason: "no_offline_image_selected",
  },
};
function fixture(s = seal, r = replay) {
  return `
$seal=ConvertFrom-CityGoSealedJson ${quote(JSON.stringify(s))}
$replay=ConvertFrom-CityGoSealedJson ${quote(JSON.stringify(r))}
$request=[ordered]@{operationId=${quote(op)};vmId=${quote(vmId)};guestSealPath=${quote(control + "\\guest-seal.json")};guestSealSha256=('b'*64);
 toolsReplayPath=${quote(control + "\\tools-replay.json")};toolsReplaySha256=('c'*64);seedIsoSha256=${quote(sha(isoBytes))};apply=$false;acknowledge=''}
$now=[DateTimeOffset]'2026-10-19T08:00:00Z'
`;
}
const mocks = `
$script:calls=[Collections.Generic.List[string]]::new();$script:held=[Collections.Generic.List[object]]::new();$script:receipt=$null
$script:failure='';$script:receiptExists=$false;$script:otherReference=$false;$script:parentReference=$false;$script:nativeAfterDisconnectRunning=$false
$plan=Get-CityGoSealedPlan $request
$script:vm=[pscustomobject]@{Id=[guid]$plan.vmId;Name=$plan.vmName;Path=$plan.vmPath;State='Off';Generation=2;ProcessorCount=4;MemoryStartup=6GB;
 DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false}
$script:other=[pscustomobject]@{Id=[guid]'77777777-7777-4777-8777-777777777777'}
$script:nic=[pscustomobject]@{Id=('Microsoft:'+$plan.vmId+'\\44444444-4444-4444-8444-444444444444');VMId=[guid]$plan.vmId;SwitchId=[guid]'55555555-5555-4555-8555-555555555555';SwitchName='Default Switch';
 MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovWeight=0;IovQueuePairsAssigned=0;IovUsage=0;PortMirroringMode='None';AllowTeaming='Off'}
$script:dvd=[pscustomobject]@{Path=$plan.seedPath}
$script:disk=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=${Buffer.byteLength(diskBytes)}}
function Track([string]$Name){$script:calls.Add($Name);if($script:failure -ceq $Name){throw 'synthetic_failure'}}
function Get-CityGoSealedOwnerSid {Track 'identity';return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoSealedPlainPath {param($Path,$Directory);Track 'plain'}
function Assert-CityGoSealedPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'private'}
function Test-Path {param($LiteralPath,$ErrorAction);Track 'receipt_absent';return $script:receiptExists}
function Read-CityGoSealedEvidence {param($Path,$Expected,$OwnerSid)
 Track 'evidence';$stream=[IO.MemoryStream]::new();$script:held.Add($stream)
 if($Path -ieq $plan.guestSealPath -and $Expected -ceq ('b'*64)){return @{value=$seal;stream=$stream}}
 if($Path -ieq $plan.toolsReplayPath -and $Expected -ceq ('c'*64)){return @{value=$replay;stream=$stream}}
 throw 'wrong_evidence'
}
function Open-CityGoSealedReadLock {param($Path)
 Track 'source_lock';$bytes=$null
 if($Path -ieq $plan.seedPath){$bytes=[Text.Encoding]::ASCII.GetBytes(${quote(isoBytes)})}
 elseif($Path -ieq $plan.basePath){$bytes=[Text.Encoding]::ASCII.GetBytes(${quote(diskBytes)})}
 else{throw 'wrong_lock'}
 $stream=[IO.MemoryStream]::new([byte[]]$bytes);$script:held.Add($stream);return ,$stream
}
function Get-VM {param($Id,$ErrorAction)
 Track 'get_vm';if($Id){if($Id -ne $script:vm.Id){throw 'wrong_vm'};return $script:vm}
 if($script:otherReference -or $script:parentReference){return @($script:vm,$script:other)};return $script:vm
}
function Get-VMHardDiskDrive {param($VM,$ErrorAction)
 Track 'get_drive';if($VM.Id -eq $script:other.Id){return [pscustomobject]@{Path=$(if($script:parentReference){'D:\\other-child.avhdx'}else{$plan.basePath})}}
 return [pscustomobject]@{Path=$plan.basePath;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}
}
function Get-VHD {param($Path,$ErrorAction);Track 'get_vhd';if($Path -ceq 'D:\\other-child.avhdx'){return [pscustomobject]@{ParentPath=$plan.basePath}};return $script:disk}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'firmware';return [pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'devices'}
function Get-VMNetworkAdapter {param($VM,[switch]$All,$ErrorAction);Track 'get_nic';return $script:nic}
function Get-VMDvdDrive {param($VM,$ErrorAction);Track 'get_dvd';return $script:dvd}
function Set-VMDvdDrive {param($VMDvdDrive,$Path,$ErrorAction);Track 'detach';if($VMDvdDrive -ne $script:dvd -or $null -ne $Path){throw 'wrong_detach'};$script:dvd.Path=$null}
function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,$ErrorAction)
 Track 'disconnect';if($VMNetworkAdapter -ne $script:nic){throw 'wrong_nic'}
 $script:nic.SwitchId=$null;$script:nic.SwitchName='';if($script:nativeAfterDisconnectRunning){$script:vm.State='Running'}
}
function Write-CityGoSealedReceipt {param($Plan,$Receipt,$OwnerSid);Track 'write_receipt';$script:receipt=($Receipt|ConvertTo-Json -Depth 6|ConvertFrom-Json)}
`;

test("source mutation boundary is exactly DVD detach, owned NIC disconnect, and CreateNew flushed receipt", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-\w+|New-VM|Set-VM\s|Set-VHD|Mount-VHD|Copy-Item|Move-Item|Start-Process|Invoke-WebRequest|Import-Module|Register-\w+)\b/i,
  );
  assert.doesNotMatch(
    source,
    /-ComputerName\b|-ManagementOS\b|-Credential\b|\$env:|ExecutionPolicy|Get-Content/i,
  );
  assert.match(source, /Set-VMDvdDrive -VMDvdDrive \$native\.dvd -Path \$null/);
  assert.match(
    source,
    /Disconnect-VMNetworkAdapter -VMNetworkAdapter \$native\.nic/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.FileShare\]::Read/);
  assert.match(source, /\$file\.Flush\(\$true\)/);
});

test(
  "default offline plan makes no native/file calls and pins only same-op exact control paths",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$result=Invoke-CityGoSealedFinalization $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 7 -Compress`);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.equal(out.result.receiptWritten, false);
    assert.equal(out.result.ciJobsAdmitted, false);
    assert.deepEqual(out.calls, []);
    assert.equal(out.result.plan.receiptPath, `${control}\\sealed-base.json`);
  },
);

test(
  "nested JSON repeats across objects are allowed, duplicates/comment/trailing/escaped keys are not",
  { skip: !available },
  () => {
    const out = run(`
$valid=ConvertFrom-CityGoSealedJson '{"left":{"ok":true},"right":{"ok":true},"names":["{fake}","a,b"]}'
$blocked=@();foreach($raw in @('{"ok":true,"ok":false}','{"ok":true,"OK":false}','{"one":{"x":1,"x":2}}','{"x":1,}','{/*comment*/"x":1}','{"\\u006fk":true}')){
 try{$null=ConvertFrom-CityGoSealedJson $raw;$blocked+=$false}catch{$blocked+=$true}
}
[ordered]@{valid=$valid.left.ok;blocked=$blocked}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.valid, true);
    assert.deepEqual(out.blocked, Array(6).fill(true));
  },
);

test(
  "synthetic apply detaches/disconnects only after proof+Off guards, writes exact creator schema with CURRENT disk SHA",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$request.acknowledge=$plan.requiredAcknowledgement
$result=Invoke-CityGoSealedFinalization $request $now
[ordered]@{result=$result;receipt=$script:receipt;calls=@($script:calls.ToArray());handlesClosed=(@($script:held|Where-Object{$_.CanRead}).Count -eq 0)}|ConvertTo-Json -Depth 7 -Compress`);
    assert.equal(
      out.result.stage,
      "sealed_off_disconnected_clone_validation_pending",
    );
    assert.equal(out.result.currentBaseSha256, sha(diskBytes));
    assert.equal(out.result.receiptWritten, true);
    assert.equal(out.handlesClosed, true);
    assert.deepEqual(
      Object.keys(out.receipt).sort(),
      [
        "schemaVersion",
        "scope",
        "observedAt",
        "basePath",
        "baseSha256",
        "diskSizeBytes",
        "bootstrapAccessRemoved",
        "seedDetached",
        "cloudInitCacheRemoved",
        "sshHostKeysRemoved",
        "toolsReplayed",
        "sourceVmState",
        "githubRunnerRegistered",
        "checkoutPresent",
        "sharedHostMountsPresent",
        "guestIsolationVerified",
        "ciJobsAdmitted",
      ].sort(),
    );
    assert.equal(out.receipt.baseSha256, sha(diskBytes));
    assert.equal(out.receipt.diskSizeBytes, 96 * 1024 ** 3);
    assert.equal(out.receipt.scope, "sealed_base_for_local_canary_only");
    assert.equal(out.receipt.sourceVmState, "Off");
    for (const key of [
      "githubRunnerRegistered",
      "checkoutPresent",
      "sharedHostMountsPresent",
      "guestIsolationVerified",
      "ciJobsAdmitted",
    ])
      assert.equal(out.receipt[key], false);
    assert.equal(out.calls.filter((x) => x === "detach").length, 1);
    assert.equal(out.calls.filter((x) => x === "disconnect").length, 1);
    assert.ok(out.calls.indexOf("get_vhd") < out.calls.indexOf("detach"));
    assert.ok(out.calls.indexOf("source_lock") < out.calls.indexOf("detach"));
  },
);

test(
  "final native readback accepts exactly one owned empty DVD with a disconnected NIC, for null and empty-string paths",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$script:nic.SwitchId=$null;$script:nic.SwitchName='';$accepted=@()
foreach($empty in @($null,'')){
 $script:dvd.Path=$empty
 try{$observed=Get-CityGoSealedNative $plan $true;$accepted+=($observed.disconnected -and -not $observed.dvd.Path)}catch{$accepted+=$false}
}
$denied=@();foreach($unexpected in @($plan.seedPath,'D:\\foreign.iso',' ')){
 $script:dvd.Path=$unexpected
 try{$null=Get-CityGoSealedNative $plan $true;$denied+=$false}catch{$denied+=$true}
}
[ordered]@{accepted=$accepted;denied=$denied;mutated=($script:calls.Contains('detach') -or $script:calls.Contains('disconnect') -or $script:calls.Contains('write_receipt'))}|ConvertTo-Json -Depth 4 -Compress`);
    assert.deepEqual(out.accepted, [true, true]);
    assert.deepEqual(out.denied, [true, true, true]);
    assert.equal(out.mutated, false);
  },
);

test(
  "bounded post-write refresh tolerates only the original owned stale state and never repeats mutations",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$request.acknowledge=$plan.requiredAcknowledgement
$script:pendingReads=0;$script:disconnectedWritten=$false
function Start-Sleep {param($Milliseconds);if($Milliseconds -ne 250){throw 'wrong_sleep'};Track 'wait_refresh'}
function Get-VMDvdDrive {param($VM,$ErrorAction)
 Track 'get_dvd'
 if($script:disconnectedWritten -and $script:pendingReads -gt 0){$script:pendingReads--;return [pscustomobject]@{Path=$plan.seedPath}}
 return $script:dvd
}
function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,$ErrorAction)
 Track 'disconnect';if($VMNetworkAdapter -ne $script:nic){throw 'wrong_nic'}
 $script:nic.SwitchId=$null;$script:nic.SwitchName='';$script:disconnectedWritten=$true;$script:pendingReads=2
}
$result=Invoke-CityGoSealedFinalization $request $now
[ordered]@{result=$result;calls=@($script:calls.ToArray());receiptWritten=($null -ne $script:receipt)}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(
      out.result.stage,
      "sealed_off_disconnected_clone_validation_pending",
    );
    assert.equal(out.receiptWritten, true);
    assert.equal(
      out.calls.filter((value) => value === "wait_refresh").length,
      2,
    );
    assert.equal(out.calls.filter((value) => value === "detach").length, 1);
    assert.equal(out.calls.filter((value) => value === "disconnect").length, 1);
  },
);

test(
  "post-write refresh refuses unknown media immediately and stops known stale state at ten readbacks",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$results=@();foreach($kind in @('foreign-media','wrong-count','changed-vm','never-settles')){
 $script:calls.Clear();$script:readbacks=0
 $script:vm.State='Off';$script:dvd.Path=$plan.seedPath
 function Start-Sleep {param($Milliseconds);if($Milliseconds -ne 250){throw 'wrong_sleep'};Track 'wait_refresh'}
 function Get-VMDvdDrive {param($VM,$ErrorAction)
  Track 'get_dvd';$script:readbacks++
  if($script:kind -ceq 'foreign-media'){return [pscustomobject]@{Path='D:\\foreign.iso'}}
  if($script:kind -ceq 'wrong-count'){return @([pscustomobject]@{Path=$null},[pscustomobject]@{Path=$null})}
  return $script:dvd
 }
 $script:kind=$kind;if($kind -ceq 'changed-vm'){$script:vm.State='Running'}
 $code='not-blocked';try{$null=Wait-CityGoSealedNativeReadback $plan}catch{$code=$_.Exception.Message}
 $results+=[ordered]@{kind=$kind;code=$code;readbacks=$script:readbacks;waits=(@($script:calls|Where-Object{$_ -ceq 'wait_refresh'}).Count);
  mutated=($script:calls.Contains('detach') -or $script:calls.Contains('disconnect') -or $script:calls.Contains('write_receipt'))}
}
ConvertTo-Json -InputObject $results -Depth 5 -Compress`);
    assert.equal(out.length, 4);
    for (const item of out) {
      assert.equal(item.mutated, false, item.kind);
      if (item.kind === "never-settles") {
        assert.equal(item.code, "native_final_readback_not_settled");
        assert.equal(item.readbacks, 10);
        assert.equal(item.waits, 9);
      } else {
        assert.equal(
          item.code,
          item.kind === "changed-vm"
            ? "owned_off_vm_required"
            : "seed_dvd_unexpected",
        );
        assert.equal(item.waits, 0, item.kind);
        assert.ok(item.readbacks <= 1, item.kind);
      }
    }
  },
);

test(
  "wrong identities, evidence types/admission, disk references and native state refuse without mutation",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$blocked=@();foreach($kind in @('running','vm-path','id','nic-id','dvd','attached','parent','other-ref','child-ref','receipt','guest-op','guest-not-sealed','guest-bool','guest-admitted','tools-not-pass','tools-version','tools-admitted','mounts','iso-hash')){
 $script:vm.State='Off';$script:vm.Path=$plan.vmPath;$script:nic.Id=('Microsoft:'+$plan.vmId+'\\44444444-4444-4444-8444-444444444444');$script:dvd.Path=$plan.seedPath
 $script:disk.Attached=$false;$script:disk.ParentPath=$null;$script:otherReference=$false;$script:parentReference=$false;$script:receiptExists=$false
 $ss=($seal|ConvertTo-Json -Depth 10|ConvertFrom-Json);$rr=($replay|ConvertTo-Json -Depth 10|ConvertFrom-Json)
 $local=[ordered]@{};foreach($key in $request.Keys){$local[$key]=$request[$key]};$local.apply=$true;$local.acknowledge=$plan.requiredAcknowledgement
 if($kind -ceq 'running'){$script:vm.State='Running'}
 if($kind -ceq 'vm-path'){$script:vm.Path='D:\\foreign'}
 if($kind -ceq 'id'){$local.operationId='00000000-0000-0000-0000-000000000000'}
 if($kind -ceq 'nic-id'){$script:nic.Id='Microsoft:foreign'}
 if($kind -ceq 'dvd'){$script:dvd.Path='D:\\foreign.iso'}
 if($kind -ceq 'attached'){$script:disk.Attached=$true}
 if($kind -ceq 'parent'){$script:disk.ParentPath='D:\\parent.vhdx'}
 if($kind -ceq 'other-ref'){$script:otherReference=$true}
 if($kind -ceq 'child-ref'){$script:parentReference=$true}
 if($kind -ceq 'receipt'){$script:receiptExists=$true}
 if($kind -ceq 'guest-op'){$ss.operationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
 if($kind -ceq 'guest-not-sealed'){$ss.code='plan_only_no_changes'}
 if($kind -ceq 'guest-bool'){$ss.fixedHostKeysAbsent='true'}
 if($kind -ceq 'guest-admitted'){$ss.githubJobsAuthorized=$true}
 if($kind -ceq 'tools-not-pass'){$rr.allSelectedChecksPassed=$false}
 if($kind -ceq 'tools-version'){$rr.versions.node.observed='v22.0.0'}
 if($kind -ceq 'tools-admitted'){$rr.githubJobsAuthorized=$true}
 if($kind -ceq 'mounts'){$rr.mounts.types=@('ext4','cifs')}
 if($kind -ceq 'iso-hash'){$local.seedIsoSha256=('f'*64);$local.acknowledge=(Get-CityGoSealedPlan $local).requiredAcknowledgement}
 $script:calls.Clear();$originalSeal=$seal;$originalReplay=$replay;$seal=$ss;$replay=$rr
 try{$result=Invoke-CityGoSealedFinalization $local $now;$refused=$result.stage -like 'failed_*'}catch{$refused=$true}
 $seal=$originalSeal;$replay=$originalReplay
 $blocked+=[ordered]@{kind=$kind;refused=$refused;mutated=($script:calls.Contains('detach') -or $script:calls.Contains('disconnect') -or $script:calls.Contains('write_receipt'))}
}
ConvertTo-Json -InputObject $blocked -Depth 4 -Compress`);
    assert.equal(out.length, 19);
    for (const item of out) {
      assert.equal(item.refused, true, item.kind);
      assert.equal(item.mutated, false, item.kind);
    }
  },
);

test(
  "partial native failure preserves resources, closes held streams, emits no seal receipt and no false CI claim",
  { skip: !available },
  () => {
    const out = run(`${fixture()}${mocks}
$request.apply=$true;$request.acknowledge=$plan.requiredAcknowledgement;$script:failure='disconnect'
$result=Invoke-CityGoSealedFinalization $request $now
[ordered]@{result=$result;receipt=$script:receipt;calls=@($script:calls.ToArray());dvdEmpty=(-not $script:dvd.Path);handlesClosed=(@($script:held|Where-Object{$_.CanRead}).Count -eq 0)}|ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(out.result.stage, "failed_preserved_state_unverified");
    assert.equal(out.result.receiptWritten, false);
    assert.equal(out.receipt, null);
    assert.equal(out.dvdEmpty, true);
    assert.equal(out.handlesClosed, true);
    assert.equal(out.result.ciJobsAdmitted, false);
    assert.equal(out.calls.includes("write_receipt"), false);
  },
);
