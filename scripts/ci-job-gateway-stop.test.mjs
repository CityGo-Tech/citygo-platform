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
];
const paths = names.map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const source = readFileSync(paths[3], "utf8");
const oldTests = readFileSync(
  new URL("./self-hosted-canary-stop.test.mjs", import.meta.url),
  "utf8",
);
const fixture = oldTests.match(/const fixture = String.raw`([\s\S]*?)`;/)[1];
const stopMocks = oldTests.match(/const mocks = String.raw`([\s\S]*?)`;/)[1];
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
  if($d.Parameters.Count){throw 'inline-parameters-not-admitted'}
  Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
 }
}
${withFixture ? fixture + stopMocks + gatewayMocks : ""}
${code}`;
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(ps, "utf16le").toString("base64"),
    ],
    { windowsHide: true, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout.replace(/^\uFEFF/, "").trim());
}
const gatewayMocks = String.raw`
$script:vm.ProcessorCount=2;$script:vm.MemoryStartup=2GB
$script:vm|Add-Member NoteProperty AutomaticStopAction 'TurnOff'
foreach($entry in @(@('SwitchName',''),@('SwitchId',[guid]::Empty),@('MacAddress','021122334455'),@('DynamicMacAddressEnabled',$false))){$script:nic|Add-Member NoteProperty $entry[0] $entry[1]}
$script:lan=$script:nic.PSObject.Copy();$script:lan.Id='Microsoft:'+$vmId.ToUpperInvariant()+'\AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
$script:lan.Name='CityGo-Gateway-LAN';$script:lan.MacAddress='021122334466'
$script:vlan='Untagged';$script:extraNic=$false
$gateway=[pscustomobject][ordered]@{schemaVersion=1;scope='owned_trusted_gateway_profile';operationId=$op;stage='gateway_prepared_off_disconnected';
 guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false;vmId=$vmId;vmName=$name;vmPath=$manifest.vmPath;targetVhdx=$manifest.targetVhdx;
 diskIdentifier=$diskId;wanMac='02:11:22:33:44:55';lanNicId=$script:lan.Id;lanNicName=$script:lan.Name;lanMac='02:11:22:33:44:66';
 wanNicId=$manifest.nicId;wanNicName=$manifest.nicName;originalCreationManifestSha256=('d'*64);processorCount=2;memoryStartupBytes=[long]2147483648;automaticStopAction='TurnOff'}
$request=@{operationId=$op;vmId=$vmId;manifestSha256=('d'*64);gatewaySha256=('e'*64);graceSeconds=1;turnOffSeconds=1;apply=$false;acknowledge=''}
$script:rawOpen=(Get-Item Function:Open-CityGoCanaryCleanupEvidence).ScriptBlock
$script:rawBinding=(Get-Item Function:Set-CityGoJobGatewayStopBinding).ScriptBlock
$script:rawNative=(Get-Item Function:Get-CityGoCanaryStopNative).ScriptBlock
function Open-CityGoJobGatewayStopLibrary {param($Name,$Hash);Track 'pinned-library';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash)
 if($Path-ceq($control+'\gateway-creation.json')-and$ExpectedHash-ceq('e'*64)){$s=[IO.MemoryStream]::new();$script:held.Add($s);return @{value=$gateway;stream=$s}}
 return (& $script:rawOpen $Path $OwnerSid $ExpectedHash)
}
function Assert-CityGoCanaryStopPlainPath {param($Path,$Directory);Track 'private-path'}
function Assert-CityGoCanaryStopAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'private-acl'}
function Set-CityGoJobGatewayStopBinding {param($Plan,$Owner);Track 'gateway-binding';if($Plan.gatewaySha256-cne('e'*64)){throw 'wrong-gateway-binding'}}
function Get-VMNetworkAdapter {param($VM,[switch]$All,$ErrorAction);Track 'get-nics';$script:nic;$script:lan;if($script:extraNic){$script:lan}}
function Get-VMNetworkAdapterVlan {param($VMNetworkAdapter,$ErrorAction);[pscustomobject]@{OperationMode=$script:vlan}}
function Get-VMNetworkAdapterIsolation {param($VMNetworkAdapter,$ErrorAction);[pscustomobject]@{IsolationMode='None'}}
`;
const invoke = String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoJobGatewayStopPlan $request).requiredAcknowledgement
$r=Invoke-CityGoJobGatewayStop $request
@{result=$r;calls=@($script:calls.ToArray());closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0);restored=((Get-Item Function:Get-CityGoCanaryStopNative).ScriptBlock.ToString()-ceq$script:rawNative.ToString());cleared=($null-eq$script:ciJobGatewayStopProfile)}|ConvertTo-Json -Depth 6 -Compress
`;

test("gateway shutdown pins exact source libraries and cannot boot, delete, change network or use credentials", () => {
  for (const i of [0, 1, 2])
    assert.ok(
      source.includes(
        createHash("sha256").update(readFileSync(paths[i])).digest("hex"),
      ),
    );
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Remove-VM|Remove-Item|Disconnect-VMNetworkAdapter|Connect-VMNetworkAdapter|New-NetNat|Invoke-Expression)\b/,
  );
  assert.match(source, /Invoke-CityGoOwnedCanaryStop \$stop/);
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\$stream\.Flush\(\$true\)/);
  assert.doesNotMatch(source, /Exception\.Message|\$env:/);
});

test(
  "default and wrong acknowledgement cannot access host, files or imported helpers",
  { skip: !available },
  () => {
    const out = run(String.raw`
$r=Invoke-CityGoJobGatewayStop $request;$request.apply=$true;$denied=$false
try{$null=Invoke-CityGoJobGatewayStop $request}catch{$denied=$true}
@{stage=$r.stage;denied=$denied;calls=$script:calls.Count}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, {
      stage: "plan_only_unverified",
      denied: true,
      calls: 0,
    });
  },
);

test(
  "real pinned AST library loader keeps its source filename without executing native entrypoints",
  { skip: !available },
  () => {
    const out = run(
      String.raw`
function Get-VM {throw 'native-must-not-run'}
$h=Open-CityGoJobGatewayStopLibrary 'Remove-CityGoJobGateway.ps1' '26cd73f88b65582a1efadfbbe22904233644bc9277863fb90a2dd5d69d552203'
try{@{opened=$h.CanRead;file=(Get-Item Function:Open-CityGoJobGatewayCleanupLibrary).ScriptBlock.File.EndsWith('Remove-CityGoJobGateway.ps1')}|ConvertTo-Json -Compress}finally{$h.Dispose()}
`,
      false,
    );
    assert.deepEqual(out, { opened: true, file: true });
  },
);

for (const [name, mutation] of [
  ["graceful", ""],
  ["already Off", "SetOff"],
  ["bounded fallback", "$script:gracefulWorks=$false"],
])
  test(
    `gateway ${name}: native two-NIC guard and durable binding preserve existing stop protocol`,
    { skip: !available },
    () => {
      const out = run(mutation + invoke);
      assert.equal(
        out.result.stage,
        "stopped_off_verified",
        JSON.stringify(out),
      );
      assert.equal(out.result.vmOff, true);
      assert.equal(out.closed, true);
      assert.equal(out.restored, true);
      assert.equal(out.cleared, true);
      if (name === "already Off")
        assert.ok(
          !out.calls.includes("graceful") && !out.calls.includes("turnoff"),
        );
      else
        assert.ok(
          out.calls.indexOf("gateway-binding") < out.calls.indexOf("graceful"),
        );
      assert.equal(
        out.calls.filter((x) => x === "turnoff").length,
        name === "bounded fallback" ? 1 : 0,
      );
    },
  );

test(
  "connected ports, mounted media, wrong gateway identity/profile, extra NICs, VLAN or foreign references refuse before shutdown",
  { skip: !available },
  () => {
    for (const change of [
      "$script:nic.SwitchId=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';$script:nic.SwitchName='connected'",
      "$script:dvd.Path='D:\\foreign.iso'",
      "$gateway.vmId='other'",
      "$gateway.ciJobsAdmitted=$true",
      "$script:vm.State='Paused'",
      "$script:vm.MemoryStartup=6GB",
      "$script:lan.MacAddress='020000000000'",
      "$script:lan.Id='foreign'",
      "$script:extraNic=$true",
      "$script:vlan='Access'",
      "$script:foreign=$true",
    ]) {
      const out = run(change + invoke);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        change,
      );
      assert.ok(
        !out.calls.includes("graceful") && !out.calls.includes("turnoff"),
        change,
      );
      assert.equal(out.closed, true, change);
      assert.equal(out.restored, true, change);
    }
  },
);

test(
  "read-only connected inventory permits only exact bound WAN/LAN switches; stopping still requires disconnection",
  { skip: !available },
  () => {
    const out = run(String.raw`
$b=Get-CityGoCanaryCleanupPlan $manifest @{manifestPath=($control+'\canary-creation.json');manifestSha256=('d'*64)}
foreach($key in @('wanMac','lanMac','lanNicId','lanNicName')){$b[$key]=$gateway.$key};$b.seedPath=$null
$b.wanSwitchId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';$b.privateSwitchId='bbbbbbbb-1111-4222-8333-444444444444'
$script:nic.SwitchId=[guid]$b.wanSwitchId;$script:nic.SwitchName='WAN';$script:lan.SwitchId=[guid]$b.privateSwitchId;$script:lan.SwitchName='Private'
$v=Get-CityGoJobGatewayStopNative $b -AllowConnected;$denied=0
try{$null=Get-CityGoJobGatewayStopNative $b}catch{$denied++}
$b.wanSwitchId='cccccccc-1111-4222-8333-444444444444';try{$null=Get-CityGoJobGatewayStopNative $b -AllowConnected}catch{$denied++}
@{readOnly=$v.Id.ToString('D');denied=$denied;stopped=$script:calls.Contains('graceful')}|ConvertTo-Json -Compress`);
    assert.equal(out.denied, 2);
    assert.equal(out.stopped, false);
  },
);

test(
  "gateway binding resume checks every flat scalar and never adopts a different profile hash",
  { skip: !available },
  () => {
    const out = run(String.raw`
$p=Get-CityGoJobGatewayStopPlan $request
$script:receipts[$p.bindingPath]=[ordered]@{version=1;scope='owned_gateway_stop_binding';operationId=$op;vmId=$vmId;manifestSha256=('d'*64);gatewaySha256=('e'*64);graceSeconds=1;turnOffSeconds=1}
& $script:rawBinding $p 'owner';$script:receipts[$p.bindingPath].gatewaySha256='f'*64
$denied=$false;try{& $script:rawBinding $p 'owner'}catch{$denied=$true}
@{denied=$denied;closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0)}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, { denied: true, closed: true });
  },
);

test(
  "gateway ambiguous poweroff is observed on resume, never dispatched twice",
  { skip: !available },
  () => {
    const out = run(String.raw`
$script:gracefulWorks=$false;$script:failAt='turnoff';$request.apply=$true;$request.acknowledge=(Get-CityGoJobGatewayStopPlan $request).requiredAcknowledgement
$first=Invoke-CityGoJobGatewayStop $request;$script:failAt='';$second=Invoke-CityGoJobGatewayStop $request
@{first=$first.stage;second=$second.stage;turnoffs=@($script:calls|Where-Object{$_-ceq'turnoff'}).Count;closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0)}|ConvertTo-Json -Compress`);
    assert.equal(out.first, "failed_preserved_requires_inspection");
    assert.equal(out.second, "failed_preserved_requires_inspection");
    assert.equal(out.turnoffs, 1);
    assert.equal(out.closed, true);
  },
);
