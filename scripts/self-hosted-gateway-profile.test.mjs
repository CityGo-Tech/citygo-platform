import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/Convert-CityGoCanaryToGateway.ps1", import.meta.url),
);
const cleanup = fileURLToPath(
  new URL("../deploy/ci/Remove-CityGoCanaryVm.ps1", import.meta.url),
);
const source = readFileSync(path, "utf8");
const available =
  process.platform === "win32" &&
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { timeout: 10000 },
  ).status === 0;

function run(command) {
  // Definitions only. EVERY host inventory/mutation and evidence read/write
  // is mocked. No native VM command or elevated entrypoint is invoked.
  const code = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @('${cleanup.replaceAll("'", "''")}','${path.replaceAll("'", "''")}')){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'parse-failed'}
 foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($d.Extent.Text))}
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
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const fixture = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$vmId='98765432-1234-4234-8234-123456789abc';$control='D:\CityGo-CI\control\'+$op
$target='D:\CityGo-CI\canaries\'+$op;$name='citygo-ci-canary-'+$op
$manifest=[pscustomobject][ordered]@{schemaVersion=1;scope='local_canary_creation';operationId=$op;vmName=$name;vmId=$vmId;
 nicId=('Microsoft:'+$vmId+'\22222222-3333-4444-8555-666666666666');nicName='Network Adapter';targetDirectory=$target;targetVhdx=($target+'\canary.vhdx');vmPath=($target+'\'+$name);
 diskIdentifier='11111111-2222-4333-8444-555555555555';diskSizeBytes=[long]103079215104;diskFormat='VHDX';diskType='Dynamic';controllerType='SCSI';controllerNumber=0;controllerLocation=0;
 sourceBaseSha256=('a'*64);sealedBaseEvidenceSha256=('b'*64);preflightSha256=('c'*64);stage='created_off_disconnected';directoryCreated=$true;diskVerified=$true;vmCreated=$true;guestIsolationVerified=$false;githubRunnerRegistered=$false}
$request=[ordered]@{manifestPath=($control+'\canary-creation.json');manifestSha256=('d'*64);wanMac='02:11:22:33:44:55';lanMac='02:11:22:33:44:66';apply=$false;acknowledge=''}
$script:calls=[Collections.Generic.List[string]]::new();$script:evidence=@{};$script:held=[Collections.Generic.List[object]]::new();$script:failAt='';$script:badVlan=$false;$script:reparse=$false;$script:collision=$false
$script:vm=[pscustomobject]@{Id=[guid]$vmId;Name=$name;Path=$manifest.vmPath;State='Off';Generation=2;DynamicMemoryEnabled=$false;AutomaticStartAction='Nothing';AutomaticStopAction='ShutDown';CheckpointType='Disabled';AutomaticCheckpointsEnabled=$false;ProcessorCount=4;MemoryStartup=6GB}
$script:wan=[pscustomobject]@{Id=$manifest.nicId;VMId=[guid]$vmId;Name=$manifest.nicName;SwitchName=$null;SwitchId=[guid]::Empty;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On';IovWeight=0;PortMirroringMode='None';AllowTeaming='Off';MacAddress='';DynamicMacAddressEnabled=$true}
$script:lan=$null
$script:fixtureManifest=$manifest
function Track([string]$Name){$script:calls.Add($Name);if($script:failAt-ceq$Name){throw 'private-native-error'}}
function Open-CityGoGatewayProfileGuards {Track 'guards';$s=[IO.MemoryStream]::new();$script:held.Add($s);return $s}
function Get-CityGoCanaryCleanupIdentity {param($RequireAdministrator);Track 'identity';if(-not $RequireAdministrator){throw 'admin-required'};return 'owner'}
function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid,$ExpectedHash);Track 'evidence';if($Path-cne$request.manifestPath-or$ExpectedHash-cne('d'*64)){throw 'wrong-evidence'};$s=[IO.MemoryStream]::new();$script:held.Add($s);return @{value=$script:fixtureManifest;stream=$s}}
function Assert-CityGoCanaryCleanupPlainPath {param($Path,$Directory);Track 'plain';if($script:reparse){throw 'reparse-refused'}}
function Test-CityGoCanaryCleanupDisk {param($Plan);Track 'disk-identity';return $true}
function Assert-CityGoCanaryCleanupForeignDisk {param($Path,$Plan);Track 'foreign-disk';throw 'foreign-reference'}
function Test-Path {param($LiteralPath,$ErrorAction);return $script:evidence.ContainsKey($LiteralPath)}
function Write-CityGoGatewayProfileEvidence {param($Path,$Value,$Plan,$Owner);Track $(if($Path-ceq$Plan.intentPath){'intent'}else{'result'});if($script:evidence.ContainsKey($Path)){throw 'overwrite'};$script:evidence[$Path]=$Value}
function Get-VM {param($ErrorAction);Track 'inventory';return $script:vm}
function Get-VMHardDiskDrive {param($VM,$ErrorAction);Track 'drives';return [pscustomobject]@{Path=$script:fixtureManifest.targetVhdx;DiskNumber=$null;ControllerType='SCSI';ControllerNumber=0;ControllerLocation=0}}
function Get-VMFirmware {param($VM,$ErrorAction);Track 'firmware';return [pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftUEFICertificateAuthority'}}
function Get-VMSnapshot {param($VM,$ErrorAction);Track 'snapshots'}
function Get-VMAssignableDevice {param($VM,$ErrorAction);Track 'dda'}
function Get-VMDvdDrive {param($VM,$ErrorAction);Track 'dvd';return [pscustomobject]@{Path=$null}}
function Get-VMNetworkAdapter {param($VM,[switch]$All,$ErrorAction);Track 'nics';$script:wan;if($script:lan){$script:lan};if($All-and$script:collision){[pscustomobject]@{VMId=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';MacAddress='021122334455'}}}
function Get-VMNetworkAdapterVlan {param($VMNetworkAdapter,$ErrorAction);return [pscustomobject]@{OperationMode=$(if($script:badVlan){'Access'}else{'Untagged'})}}
function Get-VMNetworkAdapterIsolation {param($VMNetworkAdapter,$ErrorAction);return [pscustomobject]@{IsolationMode='None'}}
function Get-VMNetworkAdapterAcl {param($VMNetworkAdapter,$ErrorAction)}
function Get-VMNetworkAdapterExtendedAcl {param($VMNetworkAdapter,$ErrorAction)}
function Set-VMProcessor {param($VM,$Count,$ErrorAction);Track 'set-cpu';if($VM-ne$script:vm-or$Count-ne2){throw 'wrong-vm'};$VM.ProcessorCount=$Count}
function Set-VMMemory {param($VM,$DynamicMemoryEnabled,$StartupBytes,$ErrorAction);Track 'set-memory';if($VM-ne$script:vm-or$DynamicMemoryEnabled-ne$false-or$StartupBytes-ne2GB){throw 'wrong-vm'};$VM.MemoryStartup=$StartupBytes}
function Set-VM {param($VM,$AutomaticStopAction,$ErrorAction);Track 'set-stop';if($VM-ne$script:vm-or$AutomaticStopAction-cne'TurnOff'){throw 'wrong-vm'};$VM.AutomaticStopAction=$AutomaticStopAction}
function Set-VMNetworkAdapter {param($VMNetworkAdapter,$StaticMacAddress,$MacAddressSpoofing,$DhcpGuard,$RouterGuard,$IovWeight,$AllowTeaming,$PortMirroring,$ErrorAction)
 if($StaticMacAddress){Track 'set-mac';if($VMNetworkAdapter-ne$script:wan-or$StaticMacAddress-cne'021122334455'){throw 'wrong-wan'};$VMNetworkAdapter.MacAddress=$StaticMacAddress;$VMNetworkAdapter.DynamicMacAddressEnabled=$false}
 else{Track 'set-lan-guards';if($VMNetworkAdapter-ne$script:lan-or$MacAddressSpoofing-cne'Off'-or$DhcpGuard-cne'On'-or$RouterGuard-cne'On'-or$IovWeight-ne0-or$AllowTeaming-cne'Off'-or$PortMirroring-cne'None'){throw 'wrong-guards'}}
}
function Add-VMNetworkAdapter {param($VM,$Name,$StaticMacAddress,[switch]$Passthru,$ErrorAction);Track 'add-lan';if($VM-ne$script:vm-or$Name-cne'CityGo-Gateway-LAN'-or$StaticMacAddress-cne'021122334466'-or-not$Passthru){throw 'wrong-lan'};$script:lan=$script:wan.PSObject.Copy();$script:lan.Id='new-lan';$script:lan.Name=$Name;$script:lan.MacAddress=$StaticMacAddress;return $script:lan}
`;

const invoke = String.raw`
$request.apply=$true;$request.acknowledge=(Get-CityGoGatewayProfilePlan $request).requiredAcknowledgement
$r=Invoke-CityGoGatewayProfile $request
[ordered]@{result=$r;calls=@($script:calls.ToArray());evidence=$script:evidence.Count;state=$script:vm.State;closed=(@($script:held|Where-Object{$_.CanRead}).Count-eq0);mockError=[string]$Error[0]}|ConvertTo-Json -Depth 6 -Compress`;

test("gateway conversion pins its guards and cannot connect, boot, delete, configure host firewall, register or run commands", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(cleanup)).digest("hex"),
    "70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098",
  );
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Remove-Item|Connect-VMNetworkAdapter|New-VMSwitch|New-NetNat|Set-NetFirewallRule|Invoke-Command|Invoke-Expression|Start-Process)\b/,
  );
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /\$stream\.Flush\(\$true\)/);
  assert.doesNotMatch(source, /Exception\.Message|\$env:/);
});

test(
  "pure plan and acknowledgement reject before all native and evidence operations",
  { skip: !available },
  () => {
    const out = run(`${fixture}
$r=Invoke-CityGoGatewayProfile $request;$request.apply=$true;$denied=$false
try{$null=Invoke-CityGoGatewayProfile $request}catch{$denied=$true}
[ordered]@{plan=$r.stage;denied=$denied;calls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, {
      plan: "plan_only_unverified",
      denied: true,
      calls: [],
    });
  },
);

test(
  "strict operation path, lowercase hash and distinct static MACs are required",
  { skip: !available },
  () => {
    const out = run(`${fixture}
$denied=@();foreach($kind in @('path','hash','wan','lan','duplicate')){
 $r=[ordered]@{};foreach($k in $request.Keys){$r[$k]=$request[$k]}
 if($kind-eq'path'){$r.manifestPath=$r.manifestPath.Replace('canary-creation','other')}
 if($kind-eq'hash'){$r.manifestSha256=('D'*64)}
 if($kind-eq'wan'){$r.wanMac='00:11:22:33:44:55'}
 if($kind-eq'lan'){$r.lanMac='02:FF:22:33:44:55'}
 if($kind-eq'duplicate'){$r.lanMac=$r.wanMac}
 try{$null=Get-CityGoGatewayProfilePlan $r;$denied+=$false}catch{$denied+=$true}
};ConvertTo-Json -InputObject $denied -Compress`);
    assert.deepEqual(out, Array(5).fill(true));
  },
);

test(
  "one fresh complete OFF gateway conversion records intent before exact owned mutations",
  { skip: !available },
  () => {
    const out = run(`${fixture}${invoke}`);
    assert.equal(
      out.result.stage,
      "gateway_prepared_off_disconnected",
      JSON.stringify(out),
    );
    assert.equal(out.result.ciJobsAdmitted, false);
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.processorCount, 2);
    assert.equal(out.result.memoryStartupBytes, 2 * 1024 ** 3);
    assert.equal(out.evidence, 2);
    assert.equal(out.closed, true);
    assert.equal(out.state, "Off");
    assert.ok(out.calls.indexOf("intent") < out.calls.indexOf("set-cpu"));
    assert.deepEqual(
      out.calls.filter((x) => x.startsWith("set-") || x === "add-lan"),
      [
        "set-cpu",
        "set-memory",
        "set-stop",
        "set-mac",
        "add-lan",
        "set-lan-guards",
      ],
    );
    assert.equal(out.calls.at(-1), "result");
  },
);

test(
  "running VM, reparse paths, unexpected disk/firmware/NIC/VLAN and MAC collisions refuse before mutation",
  { skip: !available },
  () => {
    for (const change of [
      "$script:vm.State='Running'",
      "$script:reparse=$true",
      "$script:vm.ProcessorCount=8",
      "$script:wan.SwitchName='foreign'",
      "$script:wan.DhcpGuard='Off'",
      "$script:badVlan=$true",
      "$script:collision=$true",
      "$manifest.vmCreated=$false",
    ]) {
      const out = run(`${fixture}${change}\n${invoke}`);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        change,
      );
      assert.equal(out.evidence, 0, change);
      assert.ok(
        !out.calls.some((x) => x.startsWith("set-") || x === "add-lan"),
        change,
      );
      assert.equal(out.closed, true);
    }
  },
);

test(
  "partial failures preserve OFF evidence and never retry or admit jobs",
  { skip: !available },
  () => {
    for (const stage of [
      "set-cpu",
      "set-memory",
      "set-stop",
      "set-mac",
      "add-lan",
      "set-lan-guards",
      "result",
    ]) {
      const out = run(`${fixture}$script:failAt='${stage}';\n${invoke}`);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        stage,
      );
      assert.equal(out.result.ciJobsAdmitted, false);
      assert.equal(out.result.guestIsolationVerified, false);
      assert.equal(out.evidence, 1);
      assert.equal(out.state, "Off");
      assert.equal(out.calls.filter((x) => x === stage).length, 1);
      assert.equal(out.closed, true);
    }
  },
);

test(
  "a previous attempt cannot be adopted or overwritten",
  { skip: !available },
  () => {
    const out = run(
      `${fixture}$script:evidence[$control+'\\gateway-profile-intent.json']=@{};\n${invoke}`,
    );
    assert.equal(out.result.stage, "failed_preserved_requires_inspection");
    assert.equal(out.evidence, 1);
    assert.ok(!out.calls.includes("intent"));
    assert.ok(!out.calls.includes("set-cpu"));
  },
);
