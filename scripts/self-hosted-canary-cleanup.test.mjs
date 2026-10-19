import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(
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
  // AST function definitions ONLY; the entrypoint is never evaluated. All
  // native deletion/inventory and D: filesystem operations are synthetic mocks.
  const text = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse-failed'}
foreach($definition in $ast.FindAll({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($definition.Extent.Text))}
${command}`;
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(text, "utf16le").toString("base64"),
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
$request=[ordered]@{manifestPath=($control+'\canary-creation.json');manifestSha256=('d'*64);apply=$false;acknowledge=''}
`;

const mocks = String.raw`
$script:calls=[Collections.Generic.List[string]]::new();$script:receipts=@{};$script:failAt='';$script:ownPresent=$true;$script:diskPresent=$true;$script:dirPresent=$true;$script:otherReference=$false
$script:vm=[pscustomobject]@{Id=[guid]$vmId;Name=$name;Path=$manifest.vmPath;State='Off';Generation=2}
$script:nic=[pscustomobject]@{Id=$manifest.nicId;VMId=[guid]$vmId;Name=$manifest.nicName}
$script:vhd=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null;Attached=$false;Size=96GB;FileSize=1000;DiskIdentifier=[guid]$diskId}
function Track([string]$Name){$script:calls.Add($Name);if($script:failAt-eq$Name){throw 'synthetic-failure'}}
function Get-CityGoCanaryCleanupIdentity {param($RequireAdministrator);Track 'identity';if(-not $RequireAdministrator){throw 'admin-not-requested'};return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory);Track 'plain'}
function Assert-CityGoCanaryCleanupPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'private'}
function Assert-CityGoCanaryCleanupTree {param($Plan);Track 'tree'}
function Remove-CityGoCanaryEmptyDirectories {param($Plan);Track 'empty-owned-dirs';$script:dirPresent=$false}
function Test-Path {param($LiteralPath,$ErrorAction)
 if($LiteralPath-eq$manifest.targetVhdx){return $script:diskPresent}
 if($LiteralPath-eq$manifest.targetDirectory){return $script:dirPresent}
 return $script:receipts.ContainsKey($LiteralPath)
}
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash);Track 'read-receipt';return @{value=($script:receipts[$Path]|ConvertTo-Json -Compress|ConvertFrom-Json);stream=$null}}
function Write-CityGoCanaryCleanupReceipt {param($Path,$Receipt,$Plan,$OwnerSid);Track 'write-receipt';if($script:receipts.ContainsKey($Path)){throw 'overwrite-forbidden'};$script:receipts[$Path]=($Receipt|ConvertTo-Json -Compress|ConvertFrom-Json)}
function Get-VM {param($ErrorAction);Track 'get-vms';if($script:ownPresent){$script:vm};if($script:otherReference){[pscustomobject]@{Id=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';Name='other';Path='D:\Other'}}}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get-disks';return [pscustomobject]@{Path=$manifest.targetVhdx;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}}
function Get-VMNetworkAdapter {param($VM,$ErrorAction);Track 'get-nics';return $script:nic}
function Get-VMSnapshot {param($VM,$ErrorAction);Track 'get-snapshots'}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'get-devices'}
function Get-VHD {param($Path,$ErrorAction);Track 'get-vhd';return $script:vhd}
function Remove-VM {param($VM,[switch]$Confirm,$ErrorAction);Track 'remove-vm';if($VM.Id.ToString('D')-cne$vmId){throw 'foreign-vm'};$script:ownPresent=$false}
function Remove-Item {param($LiteralPath,[switch]$Confirm,$ErrorAction);Track 'remove-disk';if($LiteralPath-cne$manifest.targetVhdx){throw 'foreign-file'};$script:diskPresent=$false}
`;

test("cleanup contains no stop/start/force/recursive/global/network/base mutations", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Stop-VM|Start-VM|Set-VHD|Mount-VHD|Set-Acl|Disconnect-VMNetworkAdapter|Connect-VMNetworkAdapter|New-VMSwitch|New-NetNat|Invoke-WebRequest|Start-Process)\b/i,
  );
  assert.doesNotMatch(
    source,
    /Remove-(?:Item|VM)[^\r\n]*-(?:Recurse|Force)\b|\$env:|ExecutionPolicy|Exception\.Message/,
  );
  assert.match(source, /Remove-VM -VM \$vm -Confirm:\$false -ErrorAction Stop/);
  assert.match(
    source,
    /Remove-Item -LiteralPath \$plan\.targetVhdx -Confirm:\$false/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.FileShare\]::Read/);
  assert.match(source, /Get-VMSnapshot/);
});

test(
  "default is a pure unverified plan without host inventory or mutations",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$result=Invoke-CityGoCanaryCleanup $manifest $request
[ordered]@{result=$result;calls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.deepEqual(out.calls, []);
  },
);

test(
  "native uppercase NIC GUIDs retain exact binding while foreign VM GUIDs fail",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}
$manifest.nicId='Microsoft:'+$vmId.ToUpperInvariant()+'\ABCDEFAB-1234-4567-8ABC-1234567890AB'
$plan=Get-CityGoCanaryCleanupPlan $manifest $request
$preserved=$plan.nicId-ceq$manifest.nicId
$manifest.nicId='Microsoft:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\ABCDEFAB-1234-4567-8ABC-1234567890AB'
$denied=$false;try{$null=Get-CityGoCanaryCleanupPlan $manifest $request}catch{$denied=$true}
[ordered]@{preserved=$preserved;foreignDenied=$denied}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, { preserved: true, foreignDenied: true });
  },
);

test(
  "manifest rejects base/bootstrap paths, partial creation, wrong identifiers and malformed scalar types",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}
$changes=@(@{targetDirectory='D:\CityGo-CI\bootstrap\'+$op},@{targetVhdx='D:\CityGo-CI\base\golden.vhdx'},@{vmPath=$target},@{vmId=[guid]::Empty.ToString()},@{diskIdentifier='not-guid'},@{stage='failed_preserved_state_unverified'},@{vmCreated=$false},@{diskVerified='true'},@{githubRunnerRegistered=$true},@{diskSizeBytes='103079215104'},@{controllerNumber='0'},@{nicId=('Microsoft:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\22222222-3333-4444-8555-666666666666')},@{extra='no'})
$denied=@();foreach($change in $changes){$m=($manifest|ConvertTo-Json -Compress|ConvertFrom-Json);foreach($key in $change.Keys){$m|Add-Member -MemberType NoteProperty -Name $key -Value $change[$key] -Force};try{$null=Get-CityGoCanaryCleanupPlan $m $request;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.equal(out.length, 13);
    assert.ok(out.every(Boolean));
  },
);

test(
  "canonical local path guard rejects UNC, ADS, wildcard and traversal roots",
  { skip: !available },
  () => {
    const out = run(String.raw`
$denied=@();foreach($path in @('\\server\share\file','D:relative','D:\CityGo-CI\canaries\..\base\golden.vhdx','D:\CityGo-CI\canaries\x:stream','D:\CityGo-CI\canaries\*','D:\CityGo-CI\canaries\x.')){try{$null=Get-CityGoCanaryCleanupPath $path;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, [true, true, true, true, true, true]);
  },
);

test(
  "flat manifest JSON rejects duplicates, escaped duplicate keys, nested values and comments",
  { skip: !available },
  () => {
    const out = run(String.raw`
$valid='{"schemaVersion":1,"path":"D:\\CityGo-CI\\canaries\\x"}'
$null=ConvertFrom-CityGoCanaryCleanupJson $valid
$denied=@();foreach($raw in @('{"vmId":"one","vmId":"two"}','{"vmId":"one","\u0076mId":"two"}','{"a":{"b":1}}','{"a":[1]}','{"a":1,}','{/*test*/"a":1}')){try{$null=ConvertFrom-CityGoCanaryCleanupJson $raw;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.ok(out.every(Boolean));
    assert.equal(out.length, 6);
  },
);

test(
  "private evidence ACL guard rejects broad groups, platform capabilities, wrong owner and inherited control ACL",
  { skip: !available },
  () => {
    const out = run(String.raw`
$script:ownerId='S-1-5-21-1-2-3-1001';$script:protected=$true;$script:grant='S-1-5-18'
function Get-Acl {param($LiteralPath,$ErrorAction)
 $acl=[pscustomobject]@{AreAccessRulesProtected=$script:protected}
 $acl|Add-Member -MemberType ScriptMethod -Name GetOwner -Value {param($Type);return [pscustomobject]@{Value=$script:ownerId}}
 $acl|Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {param($Explicit,$Inherited,$Type);return [pscustomobject]@{AccessControlType=[Security.AccessControl.AccessControlType]::Allow;IdentityReference=[pscustomobject]@{Value=$script:grant}}}
 return $acl
}
Assert-CityGoCanaryCleanupPrivateAcl 'D:\synthetic' 'S-1-5-21-1-2-3-1001' $true
$denied=@();foreach($kind in @('everyone','all-vms','capability','owner','unprotected')){
 $script:ownerId='S-1-5-21-1-2-3-1001';$script:protected=$true;$script:grant='S-1-5-18'
 if($kind-eq'everyone'){$script:grant='S-1-1-0'};if($kind-eq'all-vms'){$script:grant='S-1-5-83-0'};if($kind-eq'capability'){$script:grant='S-1-15-3-1024-1-2-3-4-5-6-7-8'}
 if($kind-eq'owner'){$script:ownerId='S-1-5-83-0'};if($kind-eq'unprotected'){$script:protected=$false}
 try{Assert-CityGoCanaryCleanupPrivateAcl 'D:\synthetic' 'S-1-5-21-1-2-3-1001' $true;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, [true, true, true, true, true]);
  },
);

test(
  "plain-path evidence guard checks root and ancestors without following reparse targets",
  { skip: !available },
  () => {
    const out = run(String.raw`
$script:bad='';$script:seen=@()
function Get-Item {param($LiteralPath,[switch]$Force,$ErrorAction)
 $script:seen+=$LiteralPath
 return [pscustomobject]@{PSProvider=[pscustomobject]@{Name='FileSystem'};PSIsContainer=($LiteralPath-notlike'*.vhdx');Attributes=$(if($LiteralPath-eq$script:bad){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal})}
}
$denied=@();foreach($bad in @('D:\','D:\CityGo-CI','D:\CityGo-CI\canaries','D:\CityGo-CI\canaries\x.vhdx')){
 $script:bad=$bad;try{Assert-CityGoCanaryCleanupPlainPath 'D:\CityGo-CI\canaries\x.vhdx' $false;$denied+=$false}catch{$denied+=$true}
}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, [true, true, true, true]);
  },
);

test(
  "apply refuses missing typed acknowledgement before any admin or host action",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$denied=$false;try{$null=Invoke-CityGoCanaryCleanup $manifest $request}catch{$denied=$true}
[ordered]@{denied=$denied;calls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.equal(out.denied, true);
    assert.deepEqual(out.calls, []);
  },
);

test(
  "happy path writes durable intent, removes only off owned VM, then signed disk and empty owned directories",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryCleanupPlan $manifest $request).requiredAcknowledgement
$result=Invoke-CityGoCanaryCleanup $manifest $request
[ordered]@{result=$result;calls=@($script:calls.ToArray());receiptCount=$script:receipts.Count;vm=$script:ownPresent;disk=$script:diskPresent}|ConvertTo-Json -Depth 4 -Compress`);
    assert.equal(out.result.stage, "cleanup_complete_resources_absent");
    assert.equal(out.result.vmAbsent, true);
    assert.equal(out.result.diskAbsent, true);
    assert.equal(out.receiptCount, 2);
    assert.equal(out.vm, false);
    assert.equal(out.disk, false);
    assert.ok(
      out.calls.indexOf("write-receipt") < out.calls.indexOf("remove-vm"),
    );
    assert.ok(
      out.calls.indexOf("remove-vm") < out.calls.indexOf("remove-disk"),
    );
    assert.ok(
      out.calls.indexOf("remove-disk") < out.calls.indexOf("empty-owned-dirs"),
    );
  },
);

test(
  "running VM, changed name/NIC, attached/changed/differencing disk, snapshots and foreign references preserve resources",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryCleanupPlan $manifest $request).requiredAcknowledgement
$results=@();foreach($kind in @('running','name','nic','attached','signature','parent','snapshots','foreign')){
 $script:vm.State='Off';$script:vm.Name=$name;$script:nic.Id=$manifest.nicId;$script:vhd.Attached=$false;$script:vhd.DiskIdentifier=[guid]$diskId;$script:vhd.ParentPath=$null;$script:otherReference=$false;$script:calls.Clear();$script:receipts=@{}
 function Get-VMSnapshot {param($VM,$ErrorAction);Track 'get-snapshots'}
 if($kind-eq'running'){$script:vm.State='Running'};if($kind-eq'name'){$script:vm.Name='other'};if($kind-eq'nic'){$script:nic.Id='changed'}
 if($kind-eq'attached'){$script:vhd.Attached=$true};if($kind-eq'signature'){$script:vhd.DiskIdentifier=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};if($kind-eq'parent'){$script:vhd.ParentPath='parent'}
 if($kind-eq'snapshots'){function Get-VMSnapshot {param($VM,$ErrorAction);Track 'get-snapshots';return [pscustomobject]@{Id='snapshot'}}};if($kind-eq'foreign'){$script:otherReference=$true}
 $result=Invoke-CityGoCanaryCleanup $manifest $request
 $results+=[ordered]@{stage=$result.stage;removed=(@($script:calls|Where-Object{$_-like'remove-*'}).Count);receipts=$script:receipts.Count}
}
ConvertTo-Json -InputObject $results -Depth 4 -Compress`);
    assert.equal(out.length, 8);
    for (const result of out) {
      assert.equal(result.stage, "failed_preserved_requires_inspection");
      assert.equal(result.removed, 0);
      assert.equal(result.receipts, 0);
    }
  },
);

test(
  "foreign AVHDX direct/deep parents, cycles and unknown metadata block before any removal or intent",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryCleanupPlan $manifest $request).requiredAcknowledgement
$script:otherReference=$true;$script:chain=@{}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'get-disks'
 $path=$manifest.targetVhdx;if($VM.Id.ToString('D')-cne$vmId){$path='D:\Foreign\child.avhdx'}
 return [pscustomobject]@{Path=$path;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}
}
function Get-VHD {param($Path,$ErrorAction);Track 'get-vhd'
 if($Path-ieq$manifest.targetVhdx){return $script:vhd}
 if($script:chain.ContainsKey($Path)){return $script:chain[$Path]}
 throw 'foreign_metadata_unavailable'
}
$results=@();foreach($kind in @('direct-parent','deep-parent','cycle','missing-metadata','missing-parent-property','missing-differencing-parent','invalid-path','bound','metadata-error')){
 $script:calls.Clear();$script:receipts=@{};$script:chain=@{}
 $parent=$manifest.targetVhdx
 if($kind-eq'deep-parent'){$parent='D:\Foreign\middle.avhdx';$script:chain[$parent]=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath=$manifest.targetVhdx}}
 if($kind-eq'cycle'){$parent='D:\Foreign\middle.avhdx';$script:chain[$parent]=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath='d:\foreign\CHILD.avhdx'}}
 if($kind-eq'missing-metadata'){$parent='D:\Foreign\unavailable.vhdx'}
 if($kind-eq'missing-differencing-parent'){$parent=$null}
 if($kind-eq'invalid-path'){$parent='\\server\share\unknown.vhdx'}
 if($kind-eq'bound'){
  $parent='D:\Foreign\parent-1.avhdx'
  foreach($n in 1..16){$script:chain[('D:\Foreign\parent-'+$n+'.avhdx')]=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath=('D:\Foreign\parent-'+($n+1)+'.avhdx')}}
 }
 if($kind-ne'metadata-error'){$script:chain['D:\Foreign\child.avhdx']=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath=$parent}}
 if($kind-eq'missing-parent-property'){$script:chain['D:\Foreign\child.avhdx']=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic'}}
 $result=Invoke-CityGoCanaryCleanup $manifest $request
 $results+=[ordered]@{kind=$kind;stage=$result.stage;removed=(@($script:calls|Where-Object{$_-like'remove-*'}).Count);receipts=$script:receipts.Count;inspected=(@($script:calls|Where-Object{$_-eq'get-vhd'}).Count)}
}
ConvertTo-Json -InputObject $results -Depth 4 -Compress`);
    assert.equal(out.length, 9);
    for (const item of out) {
      assert.equal(
        item.stage,
        "failed_preserved_requires_inspection",
        item.kind,
      );
      assert.equal(item.removed, 0, item.kind);
      assert.equal(item.receipts, 0, item.kind);
      assert.ok(item.inspected <= 16, item.kind);
    }
  },
);

test(
  "unrelated complete foreign chain permits cleanup, while case-insensitive cycles fail exactly",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}${mocks}
$plan=Get-CityGoCanaryCleanupPlan $manifest $request;$script:chain=@{}
$script:chain['D:\Foreign\child.avhdx']=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath='D:\Foreign\parent.vhdx'}
$script:chain['D:\Foreign\parent.vhdx']=[pscustomobject]@{VhdFormat='VHDX';VhdType='Dynamic';ParentPath=$null}
function Get-VHD {param($Path,$ErrorAction);Track 'get-vhd';if($script:chain.ContainsKey($Path)){return $script:chain[$Path]};throw 'unknown_foreign_path'}
Assert-CityGoCanaryCleanupForeignDisk 'D:\Foreign\child.avhdx' $plan
$permitted=$true;$script:chain['D:\Foreign\parent.vhdx']=[pscustomobject]@{VhdFormat='VHDX';VhdType='Differencing';ParentPath='d:\foreign\CHILD.avhdx'}
$code='not-blocked';try{Assert-CityGoCanaryCleanupForeignDisk 'D:\Foreign\child.avhdx' $plan}catch{$code=$_.Exception.Message}
[ordered]@{permitted=$permitted;code=$code}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, {
      permitted: true,
      code: "foreign_disk_chain_cycle",
    });
  },
);

test(
  "crash after unregistering VM resumes from exact intent and unique disk identity; completion is idempotent",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$request.acknowledge=(Get-CityGoCanaryCleanupPlan $manifest $request).requiredAcknowledgement
$script:failAt='remove-disk';$first=Invoke-CityGoCanaryCleanup $manifest $request
$afterFirst=@{vm=$script:ownPresent;disk=$script:diskPresent;receipts=$script:receipts.Count}
$script:failAt='';$script:calls.Clear();$second=Invoke-CityGoCanaryCleanup $manifest $request;$secondCalls=@($script:calls.ToArray())
$script:calls.Clear();$third=Invoke-CityGoCanaryCleanup $manifest $request
[ordered]@{first=$first;afterFirst=$afterFirst;second=$second;secondCalls=$secondCalls;third=$third;thirdCalls=@($script:calls.ToArray());receipts=$script:receipts.Count}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.first.stage, "failed_preserved_requires_inspection");
    assert.equal(out.first.cleanupIntentRecorded, true);
    assert.deepEqual(out.afterFirst, { disk: true, vm: false, receipts: 1 });
    assert.equal(out.second.stage, "cleanup_complete_resources_absent");
    assert.ok(!out.secondCalls.includes("remove-vm"));
    assert.equal(
      out.secondCalls.filter((call) => call === "remove-disk").length,
      1,
    );
    assert.equal(out.third.stage, "cleanup_complete_resources_absent");
    assert.ok(
      !out.thirdCalls.some(
        (call) =>
          call.startsWith("remove-") ||
          call === "empty-owned-dirs" ||
          call === "write-receipt",
      ),
    );
    assert.equal(out.receipts, 2);
  },
);

test(
  "wrong durable receipt ownership and resources reappearing after completion are never adopted",
  { skip: !available },
  () => {
    const out = run(`${fixture}${mocks}
$request.apply=$true;$plan=Get-CityGoCanaryCleanupPlan $manifest $request;$request.acknowledge=$plan.requiredAcknowledgement
$wrong=New-CityGoCanaryCleanupReceipt $plan 'cleanup_intent_recorded';$wrong.diskIdentifier='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';$script:receipts[$plan.intentPath]=$wrong
$first=Invoke-CityGoCanaryCleanup $manifest $request;$firstCalls=@($script:calls.ToArray());$script:receipts=@{};$script:calls.Clear()
$null=Invoke-CityGoCanaryCleanup $manifest $request;$script:dirPresent=$true;$script:calls.Clear()
$second=Invoke-CityGoCanaryCleanup $manifest $request
[ordered]@{first=$first;firstCalls=$firstCalls;second=$second;secondCalls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 4 -Compress`);
    assert.equal(out.first.stage, "failed_preserved_requires_inspection");
    assert.ok(!out.firstCalls.some((call) => call.startsWith("remove-")));
    assert.equal(out.second.stage, "failed_preserved_requires_inspection");
    assert.ok(!out.secondCalls.some((call) => call.startsWith("remove-")));
  },
);

test(
  "actual bounded tree guard refuses foreign file, unknown directory and reparses before cleanup",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}
$plan=Get-CityGoCanaryCleanupPlan $manifest $request
function Test-Path {param($LiteralPath,$ErrorAction);return $true}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory)}
$script:kind='native'
function Get-ChildItem {param($LiteralPath,[switch]$Force,$ErrorAction)
 if($LiteralPath-ne$plan.targetDirectory){return}
 $path=$plan.targetVhdx;$directory=$false;$attributes=[IO.FileAttributes]::Normal
 if($script:kind-eq'foreign'){$path=$plan.targetDirectory+'\do-not-delete.txt'}
 if($script:kind-eq'directory'){$path=$plan.targetDirectory+'\other';$directory=$true}
 if($script:kind-eq'reparse'){$attributes=[IO.FileAttributes]::ReparsePoint}
 [pscustomobject]@{FullName=$path;PSIsContainer=$directory;Attributes=$attributes}
}
Assert-CityGoCanaryCleanupTree $plan
$denied=@();foreach($kind in @('foreign','directory','reparse')){$script:kind=$kind;try{Assert-CityGoCanaryCleanupTree $plan;$denied+=$false}catch{$denied+=$true}}
ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, [true, true, true]);
  },
);

test(
  "empty-folder remover uses only derived canary/native directories and preserves nonempty folders",
  { skip: !available },
  () => {
    const out = run(String.raw`${fixture}
$plan=Get-CityGoCanaryCleanupPlan $manifest $request;$script:removed=@()
function Test-Path {param($LiteralPath,$ErrorAction);return $true}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory)}
function Get-ChildItem {param($LiteralPath,[switch]$Force,$ErrorAction);if($LiteralPath-eq$plan.targetDirectory){return 'foreign-or-native-survivor'}}
function Remove-Item {param($LiteralPath,[switch]$Confirm,$ErrorAction);$script:removed+=$LiteralPath}
Remove-CityGoCanaryEmptyDirectories $plan
[ordered]@{removed=$script:removed;target=$plan.targetDirectory;allowed=@(Get-CityGoCanaryCleanupDirectories $plan)}|ConvertTo-Json -Compress`);
    assert.ok(out.removed.length > 0);
    assert.ok(!out.removed.includes(out.target));
    assert.ok(
      out.removed.every(
        (entry) =>
          out.allowed.includes(entry) && entry.startsWith(out.target + "\\"),
      ),
    );
    assert.ok(
      out.removed.every(
        (entry) =>
          !entry.includes("\\control\\") &&
          !entry.includes("\\base\\") &&
          !entry.includes("\\bootstrap\\"),
      ),
    );
  },
);
