import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const names = [
  "Remove-CityGoCanaryVm.ps1",
  "Stop-CityGoOwnedCanaryVm.ps1",
  "Remove-CityGoJobGateway.ps1",
  "Stop-CityGoJobGatewayVm.ps1",
  "Watch-CityGoOwnedCanary.ps1",
  "Watch-CityGoJobGateway.ps1",
];
const paths = names.map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const source = readFileSync(paths[5], "utf8");
const old = readFileSync(
  new URL("./self-hosted-canary-stop.test.mjs", import.meta.url),
  "utf8",
);
const gateway = readFileSync(
  new URL("./ci-job-gateway-stop.test.mjs", import.meta.url),
  "utf8",
);
const fixture =
  old.match(/const fixture = String.raw`([\s\S]*?)`;/)[1] +
  old.match(/const mocks = String.raw`([\s\S]*?)`;/)[1] +
  gateway.match(/const gatewayMocks = String.raw`([\s\S]*?)`;/)[1];
const fullJob = readFileSync(
  new URL("./self-hosted-watchdog.test.mjs", import.meta.url),
  "utf8",
).match(/const fullJob = String.raw`([\s\S]*?)`;/)[1];
const available =
  process.platform === "win32" &&
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { windowsHide: true, timeout: 10000 },
  ).status === 0;
function run(code, withFixture = true) {
  const ps = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @(${paths.map((p) => "'" + p.replaceAll("'", "''") + "'").join(",")})){
 $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$t,[ref]$e)
 if($e.Count){throw 'parse-failed'}
 foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
  if($d.Parameters.Count){throw 'inline-parameters'};Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
 }
}
${withFixture ? fixture + mocks : ""}
${code}`;
  // The combined SYNTHETIC fixtures exceed Windows' argv limit. Send only
  // trusted test code through anonymous stdin; no script files or host changes.
  const bootstrap =
    "$ciTestSource=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));& ([scriptblock]::Create($ciTestSource))";
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64"),
    ],
    {
      input: Buffer.from(ps, "utf16le").toString("base64"),
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout.replace(/^\uFEFF/, "").trim());
}
const mocks = String.raw`
$private='11112222-3333-4444-8555-666677778888';$wan='bbbbbbbb-1111-4222-8333-444444444444'
$request=@{operationId=$op;vmId=$vmId;manifestSha256=('d'*64);gatewaySha256=('e'*64);networkSha256=('b'*64);privateSwitchId=$private;wanSwitchId=$wan;
 controllerPid=1234;controllerStartedAt='2026-10-19T00:00:00.0000000Z';deadlineUtc='2026-10-19T00:00:15.0000000Z';jobPlanSha256='';publicSeedPath='';publicSeedSha256='';apply=$false;acknowledge=''}
SetOff;$script:nic.SwitchId=[guid]$wan;$script:nic.SwitchName='Default Switch';$script:lan.SwitchId=[guid]$private;$script:lan.SwitchName='Private test'
$script:removed=$false;$script:fault='cancel';$script:badDisconnect=$false;$script:watchJob=$null
$script:realNetwork=(Get-Item Function:Get-CityGoGatewayWatchNetworkHash).ScriptBlock
$script:oldEvidence=(Get-Item Function:Open-CityGoCanaryCleanupEvidence).ScriptBlock
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash)
 if($Path-ceq($control+'\job-plan.json')-and$ExpectedHash-ceq('c'*64)){$s=[IO.MemoryStream]::new();$script:held.Add($s);return @{value=$script:watchJob;stream=$s}}
 return (& $script:oldEvidence $Path $OwnerSid $ExpectedHash)
}
function Get-CityGoGatewayWatchOwner {return 'S-1-5-21-1-2-3-1001'}
function Open-CityGoGatewayWatchLibrary {param($Name,$Hash,$Owner);Track 'pinned-watch-library';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Get-CityGoWatchdogNow {return $script:now}
function Get-CityGoWatchdogTicks {return [long](($script:now-[DateTimeOffset]::Parse('2026-10-19T00:00:00Z')).TotalSeconds*[Diagnostics.Stopwatch]::Frequency)}
function Test-CityGoWatchdogController {param($Plan);return -not($script:fault-ceq'crash'-and$script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z'))}
function Get-CityGoGatewayWatchNetworkHash {param($Plan)
 if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')){
  if($script:fault-ceq'network'){return ('a'*64)};if($script:fault-ceq'read-error'){throw 'PRIVATE_NATIVE_NETWORK_ERROR'}
 };return ('b'*64)
}
function Read-CityGoWatchdogRequest {param($Plan,$Owner)
 if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')-and$script:fault-cin@('cancel','complete')){return $script:fault};return ''
}
function Write-CityGoGatewayWatchRecord {param($Plan,$Name,$Value,$Owner)
 Track $Name;$path=$Plan.controlDirectory+'\'+$Name;if($script:receipts.ContainsKey($path)){throw 'overwrite'};$script:receipts[$path]=$Value
 if($Name-ceq'gateway-watch-ready.json'){$script:vm.State='Running';$script:vhd.Attached=$true}
}
function Start-Sleep {param($Milliseconds);if($Milliseconds-cnotin@(1000,250)){throw 'unbounded-sleep'};$script:now=$script:now.AddMilliseconds($Milliseconds)}
function Get-VM {param($Id,$ErrorAction);if($Id-and$Id-ne[guid]$vmId){throw 'wrong-vm-read'};if(-not$script:removed){return $script:vm}}
function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,$ErrorAction)
 if($VMNetworkAdapter.Id-cnotin@($script:nic.Id,$script:lan.Id)-or$VMNetworkAdapter.VMId.ToString('D')-cne$vmId){throw 'foreign-port'}
 Track $(if($VMNetworkAdapter.Id-ceq$script:nic.Id){'disconnect-wan'}else{'disconnect-lan'})
 if($script:badDisconnect-and$VMNetworkAdapter.Id-ceq$script:nic.Id){throw 'AMBIGUOUS_PRIVATE_DISCONNECT'}
 $VMNetworkAdapter.SwitchId=[guid]::Empty;$VMNetworkAdapter.SwitchName=''
}
function Invoke-CityGoJobGatewayCleanup {param($Request)
 Track 'exact-gateway-cleanup'
 if($script:vm.State-cne'Off'-or$script:vhd.Attached-or$script:nic.SwitchName-or$script:lan.SwitchName-or$Request.gatewaySha256-cne('e'*64)){throw 'unsafe-cleanup'}
 $script:removed=$true;return @{stage='cleanup_complete_resources_absent';vmAbsent=$true;diskAbsent=$true}
}
`;
const invoke = String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoGatewayWatchPlan $request).requiredAcknowledgement
$r=Invoke-CityGoGatewayWatch $request
@{result=$r;calls=@($script:calls.ToArray());closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0);removed=$script:removed;wanClosed=(-not$script:nic.SwitchName);lanClosed=(-not$script:lan.SwitchName)}|ConvertTo-Json -Depth 6 -Compress
`;

test("gateway watchdog pins private libraries and contains no boot/connect/registration/global mutations", () => {
  for (const i of [0, 1, 2, 3, 4])
    assert.ok(
      source.includes(
        createHash("sha256").update(readFileSync(paths[i])).digest("hex"),
      ),
    );
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Connect-VMNetworkAdapter|New-NetNat|Set-NetFirewallRule|Invoke-Expression|credential fill|registration-token)\b/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /Get-CityGoWatchdogJobLease/);
});
test(
  "gateway plan and wrong ack cannot read host, credentials or files",
  { skip: !available },
  () => {
    const out = run(String.raw`
$r=Invoke-CityGoGatewayWatch $request;$request.apply=$true;$denied=$false
try{$null=Invoke-CityGoGatewayWatch $request}catch{$denied=$true}
@{stage=$r.stage;denied=$denied;calls=$script:calls.Count}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, {
      stage: "plan_only_unverified",
      denied: true,
      calls: 0,
    });
  },
);
for (const [fault, reason] of [
  ["cancel", "cancel"],
  ["complete", "complete"],
  ["crash", "controller_exited"],
  ["network", "network_changed"],
  ["read-error", "observation_failed"],
  ["deadline", "deadline"],
])
  test(
    `gateway ${fault}: both exact ports close before stop, Off readback and owned cleanup`,
    { skip: !available },
    () => {
      const out = run(`$script:fault='${fault}'\n` + invoke);
      assert.equal(
        out.result.stage,
        "gateway_watchdog_cleanup_completed",
        JSON.stringify(out),
      );
      assert.equal(out.result.reason, reason);
      assert.equal(out.result.nativeFactoryAccepted, false);
      assert.equal(out.removed, true);
      assert.equal(out.closed, true);
      assert.equal(out.wanClosed, true);
      assert.equal(out.lanClosed, true);
      assert.ok(
        out.calls.indexOf("disconnect-wan") < out.calls.indexOf("graceful"),
      );
      assert.ok(
        out.calls.indexOf("disconnect-lan") < out.calls.indexOf("graceful"),
      );
      assert.ok(
        out.calls.indexOf("gateway-watch-stop.json") <
          out.calls.indexOf("exact-gateway-cleanup"),
      );
    },
  );
test(
  "gateway ambiguous WAN disconnect is not retried, still closes LAN and never stops/deletes unverified state",
  { skip: !available },
  () => {
    const out = run("$script:badDisconnect=$true\n" + invoke);
    assert.equal(out.result.stage, "failed_preserved_requires_inspection");
    assert.equal(out.result.phase, "close_both_owned_ports");
    assert.equal(out.calls.filter((x) => x === "disconnect-wan").length, 1);
    assert.equal(out.lanClosed, true);
    assert.equal(out.wanClosed, false);
    assert.equal(out.removed, false);
    assert.equal(out.closed, true);
    assert.ok(!out.calls.includes("graceful"));
  },
);
test(
  "gateway cannot arm a running/changed VM or wrong existing attempt",
  { skip: !available },
  () => {
    for (const change of [
      "$script:vm.State='Running'",
      "$script:lan.Id='replacement'",
      "$script:receipts[$control+'\\gateway-watch-ready.json']=@{}",
      "$request.networkSha256='a'*64",
    ]) {
      const out = run(change + "\n" + invoke);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        change,
      );
      assert.equal(out.result.armed, false, change);
      assert.equal(out.removed, false, change);
      assert.ok(
        !out.calls.includes("disconnect-wan") &&
          !out.calls.includes("graceful"),
        change,
      );
    }
  },
);
test(
  "gateway honors a locked full-job plan for its gateway ID, not another guest or a renewable lease",
  { skip: !available },
  () => {
    const out = run(
      fullJob +
        String.raw`
$job.operationId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';$job.gatewayOperationId=$op;$script:watchJob=$job
${invoke}`.replace("${invoke}", invoke),
    );
    assert.equal(
      out.result.stage,
      "gateway_watchdog_cleanup_completed",
      JSON.stringify(out),
    );
    assert.equal(out.closed, true);
  },
);
test(
  "gateway rollback closes both ports and ambiguous stop forbids cleanup",
  { skip: !available },
  () => {
    const rollback = run(
      String.raw`function Start-Sleep {param($Milliseconds);$script:now=$script:now.AddMilliseconds(-1)}` +
        invoke,
    );
    assert.equal(rollback.result.reason, "clock_rollback");
    assert.equal(rollback.removed, true);
    const failed = run(
      String.raw`function Invoke-CityGoJobGatewayStop {param($Request);Track 'ambiguous-stop';return @{stage='failed_preserved_requires_inspection';vmOff=$false}}` +
        invoke,
    );
    assert.equal(failed.result.stage, "failed_preserved_requires_inspection");
    assert.equal(failed.removed, false);
    assert.equal(failed.calls.filter((x) => x === "ambiguous-stop").length, 1);
    assert.equal(failed.wanClosed, true);
    assert.equal(failed.lanClosed, true);
  },
);

test(
  "gateway accepts only pinned PUBLIC media, detaches after ports close, and refuses foreign media before stop",
  { skip: !available },
  () => {
    for (const state of ["attached", "already-empty", "foreign"]) {
      const out = run(
        String.raw`
$request.publicSeedPath='D:\CityGo-CI\seeds\'+$op+'\gateway-cidata.iso';$request.publicSeedSha256='a'*64;$script:dvd.Path=$request.publicSeedPath
function Open-CityGoWatchdogPublicSeed {param($Plan,$Owner);Track 'lock-public-media';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Set-VMDvdDrive {param($VMDvdDrive,$Path,$ErrorAction);Track 'detach-public-media';if($VMDvdDrive.Path-cne$request.publicSeedPath-or$null-ne$Path){throw 'foreign-media'};$script:dvd.Path=$null}
` +
          `$script:mediaState='${state}'\n` +
          String.raw`
function Read-CityGoWatchdogRequest {param($Plan,$Owner)
 if($script:now-ge[DateTimeOffset]::Parse('2026-10-19T00:00:02Z')){
  if($script:mediaState-ceq'already-empty'){$script:dvd.Path=$null};if($script:mediaState-ceq'foreign'){$script:dvd.Path='D:\foreign.iso'}
  return 'complete'
 };return ''
}
` +
          invoke,
      );
      assert.equal(
        out.result.stage,
        state === "foreign"
          ? "failed_preserved_requires_inspection"
          : "gateway_watchdog_cleanup_completed",
        JSON.stringify(out),
      );
      assert.equal(out.closed, true);
      assert.equal(out.wanClosed, true);
      assert.equal(out.lanClosed, true);
      assert.equal(
        out.calls.filter((x) => x === "detach-public-media").length,
        state === "attached" ? 1 : 0,
      );
      if (state === "attached")
        assert.ok(
          out.calls.indexOf("disconnect-lan") <
            out.calls.indexOf("detach-public-media"),
        );
      if (state === "foreign")
        assert.ok(
          !out.calls.includes("graceful") &&
            !out.calls.includes("exact-gateway-cleanup"),
        );
    }
  },
);

test(
  "UTF-8 evidence preserves localized native NIC identity under Windows PowerShell",
  { skip: !available },
  () => {
    const out = run(
      String.raw`
$path=[IO.Path]::Combine([IO.Path]::GetTempPath(),('citygo-utf8-'+[guid]::NewGuid().ToString('D')+'.json'))
$opened=$null
try{
 $vmId='12345678-1234-4234-8234-123456789abc'
 $record=[ordered]@{nicId=('Microsoft:'+$vmId+'\11111111-2222-4333-8444-555555555555');nicName='Сетевой адаптер'}
 $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($record|ConvertTo-Json -Compress))
 [IO.File]::WriteAllBytes($path,$bytes)
 $hasher=[Security.Cryptography.SHA256]::Create()
 try{$hash=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
 # Only path/ACL checks are mocked: the reader, raw hash and decoder are real.
 function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory)}
 function Assert-CityGoCanaryCleanupPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory)}
 $opened=Open-CityGoCanaryCleanupEvidence $path 'synthetic-owner' $hash
 $explicit=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
 $p=[ordered]@{vmId=$vmId;vmName='synthetic';vmPath='D:\synthetic';nicId=$opened.value.nicId;nicName=$opened.value.nicName;lanNicId='synthetic-lan';lanNicName='CityGo-Gateway-LAN'}
 function Get-VM {param($Id,$ErrorAction);[pscustomobject]@{Id=[guid]$vmId;Name='synthetic';Path='D:\synthetic';Generation=2}}
 function Get-VMNetworkAdapter {param($VM,$ErrorAction)
  [pscustomobject]@{Id=$record.nicId;Name=$record.nicName;VMId=[guid]$vmId}
  [pscustomobject]@{Id='synthetic-lan';Name='CityGo-Gateway-LAN';VMId=[guid]$vmId}
 }
 $ports=@(Get-CityGoGatewayWatchPorts $p)
 $p.nicName=[Text.Encoding]::ASCII.GetString([Text.Encoding]::UTF8.GetBytes($record.nicName))
 $changedDenied=$false;try{$null=Get-CityGoGatewayWatchPorts $p}catch{$changedDenied=$true}
 @{decoded=($opened.value.nicName-ceq$record.nicName);explicitMatches=($explicit.nicName-ceq$opened.value.nicName);portCount=$ports.Count;changedDenied=$changedDenied}|ConvertTo-Json -Compress
}finally{if($opened){$opened.stream.Dispose()};[IO.File]::Delete($path)}
`,
      false,
    );
    assert.equal(out.decoded, true);
    assert.equal(out.explicitMatches, true);
    assert.equal(out.portCount, 2);
    assert.equal(out.changedDenied, true);
  },
);

test(
  "gateway network fingerprint includes both families, WAN/LAN identities and private topology",
  { skip: !available },
  () => {
    const out = run(String.raw`
$p=Get-CityGoGatewayWatchPlan $request
foreach($key in @('vmName','vmPath','nicId','nicName')){$p[$key]=$manifest.$key};$p.lanNicId=$script:lan.Id;$p.lanNicName=$script:lan.Name
$script:metric=10;$script:v6=$false;$script:reverse=$false;$script:privateType='Private'
function Get-NetIPAddress {param($ErrorAction)
 $a=@([pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=1;IPAddress='192.0.2.10';PrefixLength=24;AddressState='Preferred'},[pscustomobject]@{AddressFamily='IPv6';InterfaceIndex=1;IPAddress='2001:db8::10';PrefixLength=64;AddressState='Preferred'})
 if($script:v6){$a+=[pscustomobject]@{AddressFamily='IPv6';InterfaceIndex=2;IPAddress='2001:db8::20';PrefixLength=64;AddressState='Preferred'}}
 if($script:reverse){[array]::Reverse($a)};return $a
}
function Get-NetRoute {param($PolicyStore,$ErrorAction);return [pscustomobject]@{AddressFamily='IPv4';InterfaceIndex=1;DestinationPrefix='0.0.0.0/0';NextHop='192.0.2.1';RouteMetric=$script:metric;Protocol='NetMgmt';State='Alive'}}
function Get-VMSwitch {param($Id,$ErrorAction);return [pscustomobject]@{Id=$Id;SwitchType=$(if($Id-eq[guid]'11112222-3333-4444-8555-666677778888'){$script:privateType}else{'Internal'})}}
$initial=& $script:realNetwork $p;$script:reverse=$true;$reordered=& $script:realNetwork $p
$script:metric=11;$route=& $script:realNetwork $p;$script:metric=10
$script:v6=$true;$v6=& $script:realNetwork $p;$script:v6=$false
$script:lan.MacAddress='020000000001';$port=& $script:realNetwork $p
$script:privateType='Internal';$denied=$false;try{$null=& $script:realNetwork $p}catch{$denied=$true}
@{initial=$initial;reordered=$reordered;route=$route;v6=$v6;port=$port;denied=$denied}|ConvertTo-Json -Compress`);
    assert.equal(out.initial, out.reordered);
    for (const key of ["route", "v6", "port"])
      assert.notEqual(out.initial, out[key]);
    assert.equal(out.denied, true);
  },
);
