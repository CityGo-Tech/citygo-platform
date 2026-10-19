import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const paths = [
  "Remove-CityGoCanaryVm.ps1",
  "Stop-CityGoOwnedCanaryVm.ps1",
  "Watch-CityGoOwnedCanary.ps1",
].map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const source = readFileSync(paths[2], "utf8");
const stopTests = readFileSync(
  new URL("./self-hosted-canary-stop.test.mjs", import.meta.url),
  "utf8",
);
// Reuse public SYNTHETIC fixture definitions, never native inventories or scripts' entrypoints.
const fixture = stopTests.match(/const fixture = String.raw`([\s\S]*?)`;/)[1];
const stopMocks = stopTests.match(/const mocks = String.raw`([\s\S]*?)`;/)[1];
const shell = "powershell.exe";
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10000,
  }).status === 0;
function run(code) {
  const ps = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @(${paths.map((p) => "'" + p.replaceAll("'", "''") + "'").join(",")})){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'parse-failed'}
 foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($d.Extent.Text))}
}
${fixture}${stopMocks}${code}`;
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(ps, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}
const request = String.raw`
$switchId='11112222-3333-4444-8555-666677778888'
$request=[ordered]@{operationId=$op;vmId=$vmId;manifestSha256=('d'*64);networkSha256=('b'*64);privateSwitchId=$switchId;
 controllerPid=1234;controllerStartedAt='2026-10-19T00:00:00.0000000Z';deadlineUtc='2026-10-19T00:00:15.0000000Z';apply=$false;acknowledge=''}
`;
const fullJob = String.raw`
$request.jobPlanSha256='c'*64;$request.deadlineUtc='2026-10-19T01:10:00.0000000Z'
$job=[pscustomobject][ordered]@{version=1;repositoryId=123;runId=500;runAttempt=1;workflowId=400;jobId=600;
 workflowPath='.github/workflows/ci.yml';workflowRef=('CityGo-Tech/citygo-platform/.github/workflows/ci.yml@'+('a'*40));workflowSha256=('b'*64);headSha=('a'*40);
 jobName='verify';label='citygo-ci-500-1-verify';runnerGroupId=9;operationId=$op;gatewayOperationId='98765432-1234-4234-8234-123456789abc';
 jobKey='400-500-1-600';createdAt='2026-10-19T00:00:00.000Z';hardDeadline='2026-10-19T01:13:00.000Z';bootstrapSeconds=600;jobSeconds=3600;cleanupSeconds=180;
 guestVcpu=4;guestMemoryGiB=6;guestDiskGiB=96}
`;
const mocks = String.raw`
$script:removed=$false;$script:fault='cancel';$script:network='b'*64
$script:nic|Add-Member -NotePropertyName SwitchId -NotePropertyValue ([guid]$switchId)
$script:nic|Add-Member -NotePropertyName SwitchName -NotePropertyValue 'Private test switch'
SetOff
function Get-CityGoWatchdogOwner {Track 'watch-owner';return 'S-1-5-21-1-2-3-1001'}
function Open-CityGoWatchdogLibrary {param($Path,$Hash,$Owner);Track 'load-reviewed-library';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Get-CityGoWatchdogNow {return $script:now}
function Get-CityGoWatchdogTicks {return [long](($script:now-[DateTimeOffset]::Parse('2026-10-19T00:00:00Z')).TotalSeconds*[Diagnostics.Stopwatch]::Frequency)}
function Test-CityGoWatchdogController {param($Plan);Track 'parent';return (-not($script:fault-ceq'crash'-and$script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')))}
function Get-CityGoWatchdogNetworkHash {param($Plan)
 Track 'network';if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')){
  if($script:fault-ceq'network'){return ('c'*64)};if($script:fault-ceq'read-error'){throw 'PRIVATE_NETWORK_ERROR'}
 };return $script:network
}
function Read-CityGoWatchdogRequest {param($Plan,$Owner)
 Track 'request';if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')-and$script:fault-cin@('cancel','complete')){return $script:fault};return ''
}
function Write-CityGoWatchdogRecord {param($Plan,$Name,$Value,$Owner)
 Track $Name;$path=$Plan.controlDirectory+'\'+$Name
 if($script:receipts.ContainsKey($path)){throw 'overwrite-forbidden'};$script:receipts[$path]=$Value
 if($Name-ceq'watchdog-ready.json'){$script:vm.State='Running';$script:vhd.Attached=$true}
}
function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,$ErrorAction)
 Track 'disconnect';if($VMNetworkAdapter.Id-cne$manifest.nicId-or$VMNetworkAdapter.VMId.ToString('D')-cne$vmId){throw 'foreign-nic'}
 $script:nic.SwitchId=[guid]::Empty;$script:nic.SwitchName=''
}
function Start-Sleep {param($Milliseconds);Track 'sleep';if($Milliseconds-cnotin@(250,1000)){throw 'unbounded-sleep'};$script:now=$script:now.AddMilliseconds($Milliseconds)}
function Get-VM {param($Id,$ErrorAction);Track 'get-vms';if(-not$script:removed){return $script:vm}}
function Invoke-CityGoCanaryCleanup {param($Manifest,$Request)
 Track 'cleanup';if($script:vm.State-cne'Off'-or$script:vhd.Attached-or$script:nic.SwitchName){throw 'unsafe-cleanup'}
 $script:removed=$true;return @{stage='cleanup_complete_resources_absent';vmAbsent=$true;diskAbsent=$true}
}
`;
const invoke = String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoWatchdogPlan $request).requiredAcknowledgement
$out=Invoke-CityGoOwnedWatchdog $request
[ordered]@{result=$out;calls=@($script:calls.ToArray());removed=$script:removed;closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0)}|ConvertTo-Json -Depth 6 -Compress
`;

test(
  "full-job lease is explicit, hash-bound and fixed to CI/Container absolute cleanup deadlines",
  { skip: !available },
  () => {
    const out = run(`${request}${fullJob}
$p=Get-CityGoWatchdogPlan $request;$ci=Get-CityGoWatchdogJobLease $job $p
$job.workflowPath='.github/workflows/container-smoke.yml';$job.workflowRef='CityGo-Tech/citygo-platform/.github/workflows/container-smoke.yml@'+('a'*40)
$job.jobName='production-images';$job.label='citygo-ci-500-1-production-images';$job.jobSeconds=2400;$job.hardDeadline='2026-10-19T00:53:00.000Z'
$p.deadlineUtc='2026-10-19T00:50:00.0000000Z';$container=Get-CityGoWatchdogJobLease $job $p
@{ciSeconds=$ci.maximumSeconds;containerSeconds=$container.maximumSeconds;ack=$p.requiredAcknowledgement;path=$p.jobPlanPath}|ConvertTo-Json -Compress`);
    assert.equal(out.ciSeconds, 4200);
    assert.equal(out.containerSeconds, 3000);
    assert.ok(out.ack.endsWith(":JOB_PLAN:" + "c".repeat(64)));
    assert.ok(out.path.endsWith("\\job-plan.json"));
  },
);

test(
  "full-job lease rejects changed IDs, shapes, resources, source and any moved deadline",
  { skip: !available },
  () => {
    const out = run(`${request}${fullJob}
$p=Get-CityGoWatchdogPlan $request;$denied=0
foreach($fault in @('operation','gateway','deadline','created','duration','job','source','numeric','resources','extra')){
 $j=$job.PSObject.Copy()
 switch($fault){
  'operation' {$j.operationId=$j.gatewayOperationId};'gateway' {$j.gatewayOperationId=$j.operationId}
  'deadline' {$j.hardDeadline='2026-10-19T01:13:01.000Z'};'created' {$j.createdAt='2026-10-19T00:00:01.000Z'}
  'duration' {$j.jobSeconds=99999};'job' {$j.jobName='deploy'};'source' {$j.workflowRef='foreign'}
  'numeric' {$j.runId='500'};'resources' {$j.guestMemoryGiB=12};'extra' {$j|Add-Member NoteProperty secret 'synthetic'}
 }
 try{$null=Get-CityGoWatchdogJobLease $j $p}catch{$denied++}
}
@{denied=$denied}|ConvertTo-Json -Compress`);
    assert.equal(out.denied, 10);
  },
);

test(
  "full-job plan remains read-locked until cancellation cleanup; no renewed lease or guest heartbeat",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}${fullJob}
$script:oldOpen=(Get-Item Function:Open-CityGoCanaryCleanupEvidence).ScriptBlock
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash)
 if($Path-ceq($control+'\\job-plan.json')){
  Track 'locked-job-plan';if($ExpectedHash-cne('c'*64)){throw 'wrong-job-pin'}
  $s=[IO.MemoryStream]::new();$script:held.Add($s);return @{value=$job;stream=$s}
 }
 return (& $script:oldOpen $Path $OwnerSid $ExpectedHash)
}
${invoke}`);
    assert.equal(out.result.stage, "watchdog_cleanup_completed");
    assert.equal(out.result.reason, "cancel");
    assert.equal(out.closed, true);
    assert.ok(
      out.calls.indexOf("locked-job-plan") <
        out.calls.indexOf("watchdog-ready.json"),
    );
    assert.ok(out.calls.indexOf("disconnect") < out.calls.indexOf("cleanup"));
  },
);

test(
  "UTC rollback stops the independent monitor and closes networking before cleanup",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
function Start-Sleep {param($Milliseconds);Track 'sleep';$script:now=$script:now.AddMilliseconds(-1)}
${invoke}`);
    assert.equal(out.result.stage, "watchdog_cleanup_completed");
    assert.equal(out.result.reason, "clock_rollback");
    assert.equal(out.removed, true);
    assert.ok(out.calls.indexOf("disconnect") < out.calls.indexOf("cleanup"));
  },
);

test(
  "public seed is explicit, paired, operation-bound and included in the acknowledgement",
  { skip: !available },
  () => {
    const out = run(`${request}
$request.publicSeedPath='D:\\CityGo-CI\\seeds\\'+$op+'\\runner-cidata.iso';$request.publicSeedSha256='a'*64
$accepted=Get-CityGoWatchdogPlan $request;$denied=@()
foreach($kind in @('unpaired','other-op','arbitrary-name','upper-hash')){
 $r=[ordered]@{};foreach($key in $request.Keys){$r[$key]=$request[$key]}
 if($kind-ceq'unpaired'){$r.publicSeedSha256=''}
 if($kind-ceq'other-op'){$r.publicSeedPath='D:\\CityGo-CI\\seeds\\00000000-0000-4000-8000-000000000001\\runner-cidata.iso'}
 if($kind-ceq'arbitrary-name'){$r.publicSeedPath='D:\\CityGo-CI\\seeds\\'+$op+'\\private.iso'}
 if($kind-ceq'upper-hash'){$r.publicSeedSha256='A'*64}
 try{$null=Get-CityGoWatchdogPlan $r;$denied+=$false}catch{$denied+=$true}
}
[ordered]@{seed=$accepted.publicSeedPath;ack=$accepted.requiredAcknowledgement;denied=$denied}|ConvertTo-Json -Compress`);
    assert.ok(out.seed.endsWith("runner-cidata.iso"));
    assert.ok(out.ack.endsWith(":PUBLIC_SEED:" + "a".repeat(64)));
    assert.deepEqual(out.denied, [true, true, true, true]);
  },
);

test(
  "known public seed is locked then detached only after network closure; foreign media never authorizes stop or cleanup",
  { skip: !available },
  () => {
    for (const foreign of [false, true]) {
      const out = run(`${request}${mocks}
$request.publicSeedPath='D:\\CityGo-CI\\seeds\\'+$op+'\\runner-cidata.iso';$request.publicSeedSha256='a'*64;$script:dvd.Path=$request.publicSeedPath
function Open-CityGoWatchdogPublicSeed {param($Plan,$Owner);Track 'lock-public-seed';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Read-CityGoWatchdogRequest {param($Plan,$Owner);if(${foreign ? "$true" : "$false"}){$script:dvd.Path='D:\\foreign.iso'};return 'cancel'}
function Set-VMDvdDrive {param($VMDvdDrive,$Path,$ErrorAction);Track 'detach-public-seed';if($VMDvdDrive.Path-cne$request.publicSeedPath-or$null-ne$Path){throw 'foreign-media'};$script:dvd.Path=$null}
${invoke}`);
      assert.equal(
        out.result.stage,
        foreign
          ? "failed_preserved_requires_inspection"
          : "watchdog_cleanup_completed",
      );
      assert.equal(out.closed, true);
      assert.ok(
        out.calls.indexOf("lock-public-seed") <
          out.calls.indexOf("watchdog-ready.json"),
      );
      if (foreign) {
        assert.ok(!out.calls.includes("detach-public-seed"));
        assert.ok(!out.calls.includes("graceful"));
        assert.ok(!out.calls.includes("cleanup"));
      } else {
        assert.ok(
          out.calls.indexOf("disconnect") <
            out.calls.indexOf("detach-public-seed"),
        );
        assert.ok(
          out.calls.indexOf("detach-public-seed") <
            out.calls.indexOf("graceful"),
        );
        assert.equal(out.removed, true);
      }
    }
  },
);

test(
  "detached DVD requires complete native readback; transient or permanent refusal never repeats detach",
  { skip: !available },
  () => {
    for (const permanent of [false, true]) {
      const out = run(`${request}${mocks}
$request.publicSeedPath='D:\\CityGo-CI\\seeds\\'+$op+'\\runner-cidata.iso';$request.publicSeedSha256='a'*64;$script:dvd.Path=$request.publicSeedPath
function Open-CityGoWatchdogPublicSeed {param($Plan,$Owner);return [IO.MemoryStream]::new()}
function Read-CityGoWatchdogRequest {param($Plan,$Owner);return 'complete'}
function Set-VMDvdDrive {param($VMDvdDrive,$Path,$ErrorAction);Track 'detach-once';$script:dvd.Path=$null}
$script:originalNative=(Get-Item Function:Get-CityGoCanaryStopNative).ScriptBlock;$script:failedRead=0
function Get-CityGoCanaryStopNative {param($Plan,[switch]$ObserveStopping)
 if(-not$script:dvd.Path-and$Plan.seedPath-eq$null-and(${permanent ? "$true" : "$false"}-or$script:failedRead-eq0)){$script:failedRead++;Track 'readback-refused';throw 'TRANSIENT_PRIVATE_NATIVE_TEXT'}
 & $script:originalNative $Plan -ObserveStopping:$ObserveStopping
}
${invoke}`);
      assert.equal(out.calls.filter((x) => x === "detach-once").length, 1);
      assert.equal(out.removed, !permanent);
      assert.equal(
        out.result.stage,
        permanent
          ? "failed_preserved_requires_inspection"
          : "watchdog_cleanup_completed",
      );
      if (permanent) {
        assert.equal(
          out.calls.filter((x) => x === "readback-refused").length,
          80,
        );
        assert.ok(!out.calls.includes("graceful"));
        assert.ok(!out.calls.includes("cleanup"));
      }
      assert.ok(
        !JSON.stringify(out.result).includes("TRANSIENT_PRIVATE_NATIVE_TEXT"),
      );
    }
  },
);

test("watchdog has pinned helpers and no boot/registration/global mutations or arbitrary native output", () => {
  for (const path of paths.slice(0, 2))
    assert.ok(
      source.includes(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ),
    );
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Set-VM|New-VM|Connect-VMNetworkAdapter|Set-NetFirewall|Remove-Item|Stop-Process|Invoke-Expression|Register-ScheduledTask|Invoke-WebRequest)\b|\$env:|Exception\.Message/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\.Flush\(\$true\)/);
  assert.match(source, /Get-CityGoWatchdogTicks/);
  assert.match(source, /privateSwitchId/);
});
test(
  "pure plan and invalid acknowledgement touch no files, admin or native state",
  { skip: !available },
  () => {
    const out = run(`${request}
$r=Invoke-CityGoOwnedWatchdog $request;$request.apply=$true;$denied=$false
try{$null=Invoke-CityGoOwnedWatchdog $request}catch{$denied=$true}
[ordered]@{stage=$r.stage;calls=@($script:calls.ToArray());denied=$denied}|ConvertTo-Json -Compress`);
    assert.equal(out.stage, "plan_only_unverified");
    assert.deepEqual(out.calls, []);
    assert.equal(out.denied, true);
  },
);
test(
  "controller crash, cancellation, network drift, observation error, deadline and completion close network before stop and removal",
  { skip: !available },
  () => {
    for (const [fault, reason] of [
      ["crash", "controller_exited"],
      ["cancel", "cancel"],
      ["network", "network_changed"],
      ["read-error", "observation_failed"],
      ["deadline", "deadline"],
      ["complete", "complete"],
    ]) {
      const out = run(`${request}${mocks}$script:fault='${fault}'
${invoke}`);
      assert.equal(
        out.result.stage,
        "watchdog_cleanup_completed",
        JSON.stringify(out),
      );
      assert.equal(out.result.reason, reason);
      assert.equal(out.result.ciJobsAdmitted, false);
      assert.equal(out.removed, true);
      assert.equal(out.closed, true);
      assert.ok(
        out.calls.indexOf("disconnect") < out.calls.indexOf("graceful"),
      );
      assert.ok(out.calls.indexOf("graceful") < out.calls.indexOf("cleanup"));
      assert.equal(out.calls.filter((x) => x === "graceful").length, 1);
      assert.ok(!out.calls.includes("turnoff"));
    }
  },
);
test(
  "failed or ambiguous stop never deletes or sends a second stop; network is already closed",
  { skip: !available },
  () => {
    const out = run(`${request}${mocks}
function Invoke-CityGoOwnedCanaryStop {param($Request);Track 'ambiguous-stop';return @{stage='failed_preserved_requires_inspection';vmOff=$false}}
${invoke}`);
    assert.equal(out.result.stage, "failed_preserved_requires_inspection");
    assert.equal(out.removed, false);
    assert.equal(out.closed, true);
    assert.equal(out.calls.filter((x) => x === "ambiguous-stop").length, 1);
    assert.ok(out.calls.includes("disconnect"));
    assert.ok(!out.calls.includes("cleanup"));
  },
);
test(
  "wrong native NIC, existing attempt, non-Off arm and wrong snapshot do not boot or adopt resources",
  { skip: !available },
  () => {
    for (const changed of [
      "$script:vm.State='Running'",
      "$script:network='c'*64",
      "$script:nic.Id='foreign'",
      "$script:receipts[$control+'\\watchdog-ready.json']=@{}",
    ]) {
      const out = run(`${request}${mocks}${changed}
${invoke}`);
      assert.equal(out.result.stage, "failed_preserved_requires_inspection");
      assert.equal(out.result.armed, false);
      assert.equal(out.removed, false);
      assert.ok(!out.calls.includes("disconnect"));
      assert.ok(!out.calls.includes("graceful"));
      assert.equal(out.closed, true);
    }
  },
);
test(
  "canonical identities, typed process and exact UTC times cannot be injected",
  { skip: !available },
  () => {
    const out = run(`${request}
$bad=@();foreach($change in @('vmId','networkSha256','controllerPid','deadlineUtc')){
 $r=[ordered]@{};foreach($k in $request.Keys){$r[$k]=$request[$k]};$r[$change]='invalid'
 try{$null=Get-CityGoWatchdogPlan $r;$bad+=$false}catch{$bad+=$true}
};$bad|ConvertTo-Json -Compress`);
    assert.deepEqual(out, [true, true, true, true]);
  },
);

test(
  "native network fingerprint includes IPv6/routes/port drift and refuses a host-facing switch",
  { skip: !available },
  () => {
    const out = run(`${request}
$p=Get-CityGoWatchdogPlan $request;$p.nicId=$manifest.nicId
$script:routeMetric=10;$script:reverse=$false;$script:add6=$false;$script:swType='Private'
$script:nic|Add-Member -NotePropertyName SwitchId -NotePropertyValue ([guid]$switchId)
$script:nic|Add-Member -NotePropertyName MacAddress -NotePropertyValue '024347112201'
$script:nic|Add-Member -NotePropertyName DynamicMacAddressEnabled -NotePropertyValue $false
function Get-VM {param($Id,$ErrorAction);return $script:vm}
function Get-NetIPAddress {param($ErrorAction)
 $rows=@([pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=1;IPAddress='192.0.2.10';PrefixLength=24;AddressState='Preferred'},[pscustomobject]@{AddressFamily='IPv6';InterfaceIndex=1;IPAddress='2001:db8::10';PrefixLength=64;AddressState='Preferred'})
 if($script:add6){$rows+=[pscustomobject]@{AddressFamily='IPv6';InterfaceIndex=2;IPAddress='2001:db8::20';PrefixLength=64;AddressState='Preferred'}}
 if($script:reverse){[array]::Reverse($rows)};return $rows
}
function Get-NetRoute {param($PolicyStore,$ErrorAction);return [pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=1;DestinationPrefix='0.0.0.0/0';NextHop='192.0.2.1';RouteMetric=$script:routeMetric;Protocol='NetMgmt';State='Alive'}}
function Get-VMSwitch {param($Id,$ErrorAction);return [pscustomobject]@{Id=[guid]$switchId;SwitchType=$script:swType}}
$initial=Get-CityGoWatchdogNetworkHash $p;$script:reverse=$true;$reordered=Get-CityGoWatchdogNetworkHash $p
$script:routeMetric=11;$route=Get-CityGoWatchdogNetworkHash $p;$script:routeMetric=10
$script:add6=$true;$v6=Get-CityGoWatchdogNetworkHash $p;$script:add6=$false
$script:nic.SwitchId=[guid]::Empty;$port=Get-CityGoWatchdogNetworkHash $p
$script:swType='Internal';$refused=$false;try{$null=Get-CityGoWatchdogNetworkHash $p}catch{$refused=$true}
[ordered]@{initial=$initial;reordered=$reordered;route=$route;v6=$v6;port=$port;refused=$refused}|ConvertTo-Json -Compress`);
    assert.equal(out.initial, out.reordered);
    for (const key of ["route", "v6", "port"])
      assert.notEqual(out.initial, out[key]);
    assert.equal(out.refused, true);
  },
);
