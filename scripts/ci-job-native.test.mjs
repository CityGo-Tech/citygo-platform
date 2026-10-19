import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const names = ["New-CityGoJobVm.ps1", "Remove-CityGoJobGateway.ps1"];
const sources = names.map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const available =
  process.platform === "win32" &&
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { timeout: 10000 },
  ).status === 0;
function run(command) {
  const code = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @(${sources.map((path) => "'" + path.replaceAll("'", "''") + "'").join(",")})){
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$t,[ref]$e)
 if($e.Count){throw 'parse'}
 foreach($d in $a.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()}
}
${command}`;
  const result = spawnSync(
    "powershell.exe",
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
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
}
const fixture = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$baseOp='98765432-1234-4234-8234-123456789abc'
$request=[ordered]@{operationId=$op;role='client';baseOperationId=$baseOp;baseVmId='11111111-2222-4333-8444-555555555555';baseSha256=('a'*64);sealSha256=('b'*64);wanMac='';lanMac='';apply=$false;acknowledge=''}
$script:calls=[Collections.Generic.List[string]]::new()
function Open-CityGoJobVmLibrary {param($Name,$Hash);$script:calls.Add($Name);return [IO.MemoryStream]::new()}
function Get-CityGoCanaryIdentity {return 'owner'}
function Assert-CityGoCanaryPlainPath {param($Path,$Directory)}
function Assert-CityGoCanaryPrivateAcl {param($Path,$Owner,$ProtectedDirectory)}
function Test-Path {param($LiteralPath);return $false}
function New-Item {param($Path,$ItemType);$script:calls.Add('mkdir')}
function Set-CityGoCanaryPrivateDirectory {param($Path,$Owner);$script:calls.Add('private')}
function Get-VM {param($Id,$ErrorAction);return [pscustomobject]@{State='Off'}}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);return [pscustomobject]@{Path=('D:\CityGo-CI\bootstrap\'+$baseOp+'\bootstrap.vhdx')}}
function Get-VMNetworkAdapter {param($VM)}
function Get-VMDvdDrive {param($VM)}
function Write-CityGoJobVmEvidence {param($Plan,$Name,$Value,$Owner);$script:calls.Add($Name)}
function Invoke-CityGoJobPreflight {return [pscustomobject]@{synthetic=$true}}
function Get-FileHash {param($LiteralPath,$Algorithm);return [pscustomobject]@{Hash=('C'*64)}}
function Invoke-CityGoCanaryVm {param($Request);$script:calls.Add('create');if(-not$Request.apply){throw 'bad apply'};return [pscustomobject]@{stage='created_off_disconnected';vmId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}}
function Invoke-CityGoGatewayProfile {param($Request);$script:calls.Add('convert');return [pscustomobject]@{stage='gateway_prepared_off_disconnected'}}
`;

const gatewayFixture = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$vmId='abcdef12-1234-4234-8234-123456789abc'
$control='D:\CityGo-CI\control\'+$op;$target='D:\CityGo-CI\canaries\'+$op
$request=@{operationId=$op;manifestSha256=('a'*64);gatewaySha256=('b'*64);apply=$true;acknowledge=''}
$plan=Get-CityGoJobGatewayCleanupPlan $request;$request.acknowledge=$plan.requiredAcknowledgement
$binding=[ordered]@{operationId=$op;vmId=$vmId;vmName=('citygo-ci-canary-'+$op);vmPath=($target+'\citygo-ci-canary-'+$op);
 targetVhdx=($target+'\canary.vhdx');diskIdentifier='11111111-2222-4333-8444-555555555555';
 nicId=('Microsoft:'+$vmId.ToUpperInvariant()+'\22222222-3333-4444-8555-666666666666');nicName='Network Adapter';
 requiredAcknowledgement='exact-original-cleanup-ack'}
$receipt=[pscustomobject][ordered]@{schemaVersion=1;scope='owned_trusted_gateway_profile';operationId=$op;
 stage='gateway_prepared_off_disconnected';guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false;
 vmId=$vmId;vmName=$binding.vmName;vmPath=$binding.vmPath;targetVhdx=$binding.targetVhdx;diskIdentifier=$binding.diskIdentifier;
 wanMac='02:11:22:33:44:55';lanNicId=('Microsoft:'+$vmId.ToUpperInvariant()+'\AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
 lanNicName='CityGo-Gateway-LAN';lanMac='02:11:22:33:44:66';wanNicId=$binding.nicId;wanNicName=$binding.nicName;
 originalCreationManifestSha256=('a'*64);processorCount=2;memoryStartupBytes=[long]2147483648;automaticStopAction='TurnOff'}
$script:calls=[Collections.Generic.List[string]]::new();$script:held=[Collections.Generic.List[object]]::new()
$script:present=$true;$script:running=$false;$script:foreign=$false;$script:wrongBinding=$false
function Open-CityGoJobGatewayCleanupLibrary {param($Name,$Hash);$script:calls.Add('library:'+$Name);$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Get-CityGoCanaryCleanupIdentity {param($RequireAdministrator);if(-not$RequireAdministrator){throw 'administrator_required'};return 'owner'}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory)}
function Assert-CityGoCanaryCleanupPrivateAcl {param($Path,$Owner,$ProtectedDirectory)}
function Open-CityGoCanaryCleanupEvidence {param($Path,$Owner,$Hash)
 $script:calls.Add('evidence');$s=[IO.MemoryStream]::new();$script:held.Add($s)
 if($Path-ceq$plan.manifestPath-and$Hash-ceq$plan.manifestSha256){return @{stream=$s;value=[pscustomobject]@{fixture='manifest'}}}
 if($Path-ceq$plan.gatewayPath-and$Hash-ceq$plan.gatewaySha256){return @{stream=$s;value=$receipt}}
 throw 'evidence_binding_wrong'
}
function Get-CityGoCanaryCleanupPlan {param($Manifest,$Request);return $binding}
function Get-CityGoCanaryCleanupVm {param($Plan);$script:calls.Add('original-inventory');if($script:foreign){throw 'foreign_reference'};if($script:present){throw 'original-one-nic-guard-must-not-handle-gateway'};return $null}
function Get-VM {param($ErrorAction);if($script:present){[pscustomobject]@{Id=[guid]$vmId}}}
function Get-CityGoGatewayProfileVm {param($Plan,$Converted)
 $script:calls.Add('strict-two-nic-inventory')
 if(-not$Converted-or$Plan.lanNicId-cne$receipt.lanNicId-or$Plan.wanMac-cne$receipt.wanMac){throw 'profile_binding_wrong'}
 if($script:running){throw 'owned_vm_profile_changed'}
 return [pscustomobject]@{Id=[guid]$vmId;State='Off'}
}
function Invoke-CityGoCanaryCleanup {param($Manifest,$Request)
 $script:calls.Add('original-cleanup')
 if($Request.acknowledge-cne$binding.requiredAcknowledgement-or$Request.manifestSha256-cne$plan.manifestSha256-or-not$Request.apply){throw 'cleanup_binding_wrong'}
 $readPlan=[ordered]@{};foreach($key in $binding.Keys){$readPlan[$key]=$binding[$key]}
 if($script:wrongBinding){$readPlan.vmId='ffffffff-1111-4222-8333-444444444444'}
 $null=Get-CityGoCanaryCleanupVm $readPlan
 $script:calls.Add('mock-owned-delete');$script:present=$false
 $null=Get-CityGoCanaryCleanupVm $readPlan
 return @{stage='cleanup_complete_resources_absent';vmAbsent=$true;diskAbsent=$true}
}
`;

test("native creator/helper pins agree and sources contain no boot, connection, shutdown, runner, global network or credential mutation", () => {
  const source = readFileSync(sources[0], "utf8");
  for (const name of [
    "New-CityGoCanaryVm.ps1",
    "Convert-CityGoCanaryToGateway.ps1",
    "Test-CityGoRunnerHost.ps1",
  ])
    assert.ok(
      source.includes(
        createHash("sha256")
          .update(
            readFileSync(new URL("../deploy/ci/" + name, import.meta.url)),
          )
          .digest("hex"),
      ),
    );
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Connect-VMNetworkAdapter|New-NetNat|Set-NetFirewallRule|credential fill)\b/,
  );
  const cleanup = readFileSync(sources[1], "utf8");
  assert.doesNotMatch(
    cleanup,
    /\b(?:Start-VM|Stop-VM|Connect-VMNetworkAdapter|Set-NetFirewallRule|New-NetNat)\b/,
  );
  assert.match(
    cleanup,
    /Get-CityGoGatewayProfileVm \$script:ciJobGatewayBinding \$true/,
  );
  assert.match(cleanup, /Invoke-CityGoCanaryCleanup/);
});

test(
  "real pinned AST loaders preserve sibling imports and parameters without executing library entrypoints",
  { skip: !available },
  () => {
    const value = run(String.raw`
function Get-VM {throw 'native-must-not-run'}
$h=$null;$g=$null;$c=$null
try{
 $h=Open-CityGoJobVmLibrary 'Convert-CityGoCanaryToGateway.ps1' 'cb1745726334e598f9c9e40df0ed0261e9a2901cccaccf01d69a73fd835eecff'
 $g=Open-CityGoGatewayProfileGuards
 $c=Open-CityGoJobGatewayCleanupLibrary 'Convert-CityGoCanaryToGateway.ps1' 'cb1745726334e598f9c9e40df0ed0261e9a2901cccaccf01d69a73fd835eecff'
 $p=Get-CityGoGatewayProfilePlan @{manifestPath='D:\CityGo-CI\control\12345678-1234-4234-8234-123456789abc\canary-creation.json';manifestSha256=('a'*64);wanMac='02:11:22:33:44:55';lanMac='02:11:22:33:44:66'}
 $bad=$false;try{$null=Open-CityGoJobVmLibrary 'Convert-CityGoCanaryToGateway.ps1' ('0'*64)}catch{$bad=$true}
 @{siblingGuardOpened=$g.CanRead;sourceFilePreserved=((Get-Item Function:Open-CityGoGatewayProfileGuards).ScriptBlock.File.EndsWith('Convert-CityGoCanaryToGateway.ps1'));parametersRetained=($p.operationId-ceq'12345678-1234-4234-8234-123456789abc');badPinRefused=$bad}|ConvertTo-Json -Compress
}finally{if($h){$h.Dispose()};if($g){$g.Dispose()};if($c){$c.Dispose()}}
`);
    assert.deepEqual(value, {
      siblingGuardOpened: true,
      sourceFilePreserved: true,
      parametersRetained: true,
      badPinRefused: true,
    });
  },
);

test(
  "default native plan touches neither host nor filesystem; wrong acknowledgement precedes helper access",
  { skip: !available },
  () => {
    const value = run(
      fixture +
        String.raw`
$r=Invoke-CityGoJobVm $request
$request.apply=$true;$failed=$false;try{Invoke-CityGoJobVm $request|Out-Null}catch{$failed=$true}
@{stage=$r.stage;calls=$script:calls.Count;refused=$failed}|ConvertTo-Json -Compress`,
    );
    assert.deepEqual(value, {
      stage: "plan_only_unverified",
      calls: 0,
      refused: true,
    });
  },
);

for (const role of ["client", "gateway"])
  test(
    `new OFF ${role} uses fresh operation, durable intent and pinned creator; never auto-boots`,
    { skip: !available },
    () => {
      const value = run(
        fixture +
          `$request.role='${role}';` +
          (role === "gateway"
            ? "$request.wanMac='02:11:22:33:44:55';$request.lanMac='02:11:22:33:44:66';"
            : "") +
          String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoJobVmPlan $request).requiredAcknowledgement
$r=Invoke-CityGoJobVm $request
@{result=$r;calls=@($script:calls.ToArray())}|ConvertTo-Json -Depth 6 -Compress`,
      );
      assert.equal(value.result.stage, "job_vm_prepared_off_disconnected");
      assert.equal(value.result.guestBooted, false);
      assert.equal(value.result.runnerRegistered, false);
      assert.ok(
        value.calls.indexOf("job-vm-intent.json") <
          value.calls.indexOf("create"),
      );
      assert.equal(value.calls.includes("convert"), role === "gateway");
    },
  );

test(
  "unknown/base-reused identity and unsafe MAC reject the native plan",
  { skip: !available },
  () => {
    const value = run(
      fixture +
        String.raw`
$n=0
foreach($fault in @('base','role','mac')){
 $r=[ordered]@{};foreach($k in $request.Keys){$r[$k]=$request[$k]}
 if($fault-ceq'base'){$r.operationId=$baseOp};if($fault-ceq'role'){$r.role='production'};if($fault-ceq'mac'){$r.wanMac='00:11:22:33:44:55'}
 try{Get-CityGoJobVmPlan $r|Out-Null}catch{$n++}
}
@{refusals=$n;calls=$script:calls.Count}|ConvertTo-Json -Compress`,
    );
    assert.deepEqual(value, { refusals: 3, calls: 0 });
  },
);

test(
  "gateway cleanup default/bad ack cannot touch native state or load helpers",
  { skip: !available },
  () => {
    const value = run(String.raw`
$request=@{operationId='12345678-1234-4234-8234-123456789abc';manifestSha256=('a'*64);gatewaySha256=('b'*64);apply=$false;acknowledge=''}
function Open-CityGoJobGatewayCleanupLibrary {throw 'must-not-load'}
$r=Invoke-CityGoJobGatewayCleanup $request;$request.apply=$true;$denied=$false
try{Invoke-CityGoJobGatewayCleanup $request|Out-Null}catch{$denied=$true}
@{stage=$r.stage;removed=$r.resourcesRemoved;denied=$denied}|ConvertTo-Json -Compress`);
    assert.deepEqual(value, {
      stage: "plan_only_unverified",
      removed: false,
      denied: true,
    });
  },
);

test(
  "gateway receipt accepts native GUID casing and rejects wrong identities, types, extra keys and admission flags",
  { skip: !available },
  () => {
    const value = run(
      gatewayFixture +
        String.raw`
Assert-CityGoJobGatewayReceipt $receipt $binding $plan
$denied=0
foreach($fault in @('scope','stage','operation','vm','manifest','wan','lan','lan-guid','mac','duplicate-mac','cpu','memory','flag','flag-type','extra')){
 $r=$receipt.PSObject.Copy()
 switch($fault){
  'scope' {$r.scope='other'}; 'stage' {$r.stage='partial'}; 'operation' {$r.operationId='other'}
  'vm' {$r.vmId='other'}; 'manifest' {$r.originalCreationManifestSha256=('c'*64)}; 'wan' {$r.wanNicId='other'}
  'lan' {$r.lanNicId=$r.wanNicId}; 'lan-guid' {$r.lanNicId='Microsoft:'+$vmId+'\'+'-'*36}
  'mac' {$r.wanMac='00:11:22:33:44:55'}; 'duplicate-mac' {$r.lanMac=$r.wanMac}
  'cpu' {$r.processorCount='2'}; 'memory' {$r.memoryStartupBytes='2147483648'}
  'flag' {$r.ciJobsAdmitted=$true}; 'flag-type' {$r.guestIsolationVerified='false'}
  'extra' {$r|Add-Member NoteProperty extra $true}
 }
 try{Assert-CityGoJobGatewayReceipt $r $binding $plan}catch{$denied++}
}
@{valid=$true;denied=$denied}|ConvertTo-Json -Compress`,
    );
    assert.deepEqual(value, { valid: true, denied: 15 });
  },
);

test(
  "gateway adapter keeps original cleanup, strict OFF inventory and absent readback, then restores its function",
  { skip: !available },
  () => {
    const value = run(
      gatewayFixture +
        String.raw`
$r=Invoke-CityGoJobGatewayCleanup $request
$null=Get-CityGoCanaryCleanupVm $binding
@{result=$r;calls=@($script:calls.ToArray());closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0);cleared=($null-eq$script:ciJobGatewayBinding-and$null-eq$script:ciJobGatewayOriginalVm)}|ConvertTo-Json -Depth 6 -Compress`,
    );
    assert.equal(value.result.stage, "cleanup_complete_resources_absent");
    assert.equal(value.closed, true);
    assert.equal(value.cleared, true);
    assert.ok(
      value.calls.indexOf("strict-two-nic-inventory") <
        value.calls.indexOf("mock-owned-delete"),
    );
    assert.equal(
      value.calls.filter((x) => x === "original-inventory").length,
      2,
    );
    assert.equal(value.calls.at(-1), "original-inventory");
  },
);

for (const [name, fault] of [
  ["running gateway", "$script:running=$true"],
  ["changed adapter binding", "$script:wrongBinding=$true"],
  ["changed receipt", "$receipt.originalCreationManifestSha256=('c'*64)"],
  [
    "foreign reference after removal",
    "$script:present=$false;$script:foreign=$true",
  ],
])
  test(
    `gateway cleanup preserves resources and restores inventory after ${name}`,
    { skip: !available },
    () => {
      const value = run(
        gatewayFixture +
          fault +
          String.raw`
$r=Invoke-CityGoJobGatewayCleanup $request
@{stage=$r.stage;calls=@($script:calls.ToArray());closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0);cleared=($null-eq$script:ciJobGatewayBinding-and$null-eq$script:ciJobGatewayOriginalVm);restored=((Get-Item Function:Get-CityGoCanaryCleanupVm).ScriptBlock.ToString().Contains('original-inventory'))}|ConvertTo-Json -Depth 6 -Compress`,
      );
      assert.equal(value.stage, "failed_preserved");
      assert.equal(value.calls.includes("mock-owned-delete"), false);
      assert.equal(value.closed, true);
      assert.equal(value.cleared, true);
      assert.equal(value.restored, true);
    },
  );
