import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/New-CityGoPrivateSwitch.ps1", import.meta.url),
);
const creator = fileURLToPath(
  new URL("../deploy/ci/New-CityGoCanaryVm.ps1", import.meta.url),
);
const source = readFileSync(path, "utf8");
const shell = "powershell.exe";
const available =
  process.platform === "win32" &&
  spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10000,
  }).status === 0;

function run(command) {
  const code = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @('${creator.replaceAll("'", "''")}','${path.replaceAll("'", "''")}')){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'parse-failed'}
 foreach($f in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
}
${command}`;
  const result = spawnSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(code, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const mocks = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$script:calls=[Collections.Generic.List[string]]::new();$script:receipts=@{}
$script:switches=@([pscustomobject]@{Id=[guid]'11111111-2222-4333-8444-555555555555';Name='Default Switch';SwitchType='Internal';Notes=''})
$script:nics=@([pscustomobject]@{Id='host-nic';VMId=[guid]::Empty;IsManagementOs=$true;Name='host';SwitchId=$script:switches[0].Id;MacAddress='001122334455'})
$script:nats=@([pscustomobject]@{Name='existing';InternalIPInterfaceAddressPrefix='192.168.10.0/24';Active=$true})
$script:closed=$null;$script:fail='';$script:alter=''
function Track([string]$Name){$script:calls.Add($Name);if($script:fail-ceq$Name){throw 'PRIVATE_NATIVE_ERROR'}}
function Open-CityGoPrivateSwitchGuards {Track 'import';$script:closed=[IO.MemoryStream]::new();return $script:closed}
function Get-CityGoCanaryIdentity {Track 'admin';return 'S-1-5-21-1-2-3-1001'}
function Assert-CityGoCanaryPlainPath {param($Path,$Directory);Track 'plain'}
function Assert-CityGoCanaryPrivateAcl {param($Path,$OwnerSid,$ProtectedDirectory);Track 'acl'}
function Get-VMSwitch {param($ErrorAction);Track 'switches';return $script:switches}
function Get-VMNetworkAdapter {param([switch]$All,$ErrorAction);if(-not $All){throw 'all-required'};Track 'nics';return $script:nics}
function Get-NetNat {param($ErrorAction);Track 'nats';return $script:nats}
function Test-Path {param($LiteralPath,$ErrorAction);return $script:receipts.ContainsKey($LiteralPath)}
function Write-CityGoPrivateSwitchEvidence {param($Path,$Value,$Plan,$Owner)
 Track 'receipt';if($script:receipts.ContainsKey($Path)){throw 'overwrite'}
 $script:receipts[$Path]=$Value
}
function New-VMSwitch {param($Name,$SwitchType,$Notes,[switch]$Confirm,$ErrorAction)
 Track 'create';if($SwitchType-cne'Private' -or $Confirm){throw 'unsafe-create'}
 $created=[pscustomobject]@{Id=[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';Name=$Name;SwitchType=$SwitchType;Notes=$Notes}
 $script:switches+=@($created)
 if($script:alter-ceq'internal'){$created.SwitchType='Internal'}
 if($script:alter-ceq'host-nic'){$script:nics+=@([pscustomobject]@{Id='new-host';VMId=[guid]::Empty;IsManagementOs=$true;Name='new';SwitchId=$created.Id;MacAddress='001122334466'})}
 if($script:alter-ceq'old-nic'){$script:nics[0].MacAddress='001122334477'}
 if($script:alter-ceq'old-switch'){$script:switches[0].Notes='changed'}
 if($script:alter-ceq'nat'){$script:nats[0].InternalIPInterfaceAddressPrefix='10.0.0.0/8'}
 if($script:alter-ceq'duplicate'){$script:switches+=@($created)}
 return $created
}
`;
const invoke = String.raw`
$p=Get-CityGoPrivateSwitchPlan $op
$r=Invoke-CityGoPrivateSwitch $op $true $p.requiredAcknowledgement
[ordered]@{result=$r;calls=@($script:calls.ToArray());receipts=$script:receipts.Count;closed=(-not $script:closed.CanRead)}|ConvertTo-Json -Depth 6 -Compress
`;

test("private switch has one bounded new-switch mutation and no VM/network/runner configuration writes", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(creator)).digest("hex"),
    "cb625838a1f297dbfc3cd474a24c88f0abdf53d9912e913519b0fdc828f52026",
  );
  assert.match(
    source,
    /New-VMSwitch -Name \$plan.switchName -SwitchType Private -Notes \$plan.notes -Confirm:\$false/,
  );
  assert.doesNotMatch(
    source,
    /(?:Remove|Set|Connect|Disconnect|Start|Stop)-(?:VM|VMSwitch|VMNetworkAdapter|NetNat|NetFirewall|NetAdapter)\b|Invoke-Expression|Exception\.Message|\$env:/,
  );
  assert.match(source, /\[IO.FileMode\]::CreateNew/);
  assert.match(source, /\$stream.Flush\(\$true\)/);
});

test(
  "default plan is offline and canonical IDs cannot inject a switch/path/ack",
  { skip: !available },
  () => {
    const out = run(`${mocks}
$r=Invoke-CityGoPrivateSwitch $op $false ''
$bad=@();foreach($id in @('', '..', ($op.ToUpperInvariant()), ([guid]::Empty.ToString()), ('x'+$op))){try{$null=Get-CityGoPrivateSwitchPlan $id;$bad+=$false}catch{$bad+=$true}}
[ordered]@{result=$r;calls=@($script:calls.ToArray());bad=$bad}|ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(out.result.stage, "plan_only_unverified");
    assert.deepEqual(out.calls, []);
    assert.deepEqual(out.bad, Array(5).fill(true));
  },
);

test(
  "typed acknowledgement precedes all file/native/admin access",
  { skip: !available },
  () => {
    const out = run(`${mocks}
$denied=$false;try{$null=Invoke-CityGoPrivateSwitch $op $true 'wrong'}catch{$denied=$true}
[ordered]@{denied=$denied;calls=@($script:calls.ToArray())}|ConvertTo-Json -Compress`);
    assert.deepEqual(out, { denied: true, calls: [] });
  },
);

test(
  "apply records durable intent before exactly one Private switch creation, with no attachments",
  { skip: !available },
  () => {
    const out = run(`${mocks}${invoke}`);
    assert.equal(out.result.stage, "private_switch_created_no_attached_nics");
    assert.equal(out.result.hostAdapterAbsent, true);
    assert.equal(out.result.existingNetworkUnchanged, true);
    assert.equal(out.result.guestIsolationVerified, false);
    assert.equal(out.result.githubRunnerRegistered, false);
    assert.equal(out.receipts, 2);
    assert.equal(out.calls.filter((x) => x === "create").length, 1);
    assert.ok(out.calls.indexOf("receipt") < out.calls.indexOf("create"));
    assert.equal(out.closed, true);
  },
);

test(
  "native null VMId is accepted only for an explicitly observed management-OS NIC",
  { skip: !available },
  () => {
    const valid = run(`${mocks}$script:nics[0].VMId=$null\n${invoke}`);
    assert.equal(valid.result.stage, "private_switch_created_no_attached_nics");
    for (const change of [
      "$script:nics[0].VMId=$null;$script:nics[0].IsManagementOs=$false",
      "$script:nics[0].IsManagementOs='true'",
      "$script:nics[0].VMId=[guid]'12345678-1234-4234-8234-123456789abc'",
    ]) {
      const out = run(`${mocks}${change}\n${invoke}`);
      assert.equal(out.result.failurePhase, "capture_existing_network");
      assert.ok(!out.calls.includes("create"));
      assert.equal(out.receipts, 0);
    }
  },
);

test(
  "existing namespace/intent/result are never adopted or replaced",
  { skip: !available },
  () => {
    for (const change of [
      "$script:switches[0].Name='CityGo-CI-Private-'+$op",
      "$script:receipts['D:\\CityGo-CI\\control\\'+$op+'\\private-switch-intent.json']=@{}",
      "$script:receipts['D:\\CityGo-CI\\control\\'+$op+'\\private-switch-result.json']=@{}",
    ]) {
      const out = run(`${mocks}${change}\n${invoke}`);
      assert.equal(out.result.stage, "failed_preserved_requires_inspection");
      assert.ok(!out.calls.includes("create"));
      assert.equal(out.closed, true);
    }
  },
);

test(
  "wrong switch type, attached host NIC and drift of old NIC/switch/NAT cannot be success",
  { skip: !available },
  () => {
    for (const kind of [
      "internal",
      "host-nic",
      "old-nic",
      "old-switch",
      "nat",
      "duplicate",
    ]) {
      const out = run(`${mocks}$script:alter='${kind}'\n${invoke}`);
      assert.equal(
        out.result.stage,
        "failed_preserved_requires_inspection",
        kind,
      );
      assert.equal(
        out.result.failurePhase,
        "verify_native_private_switch",
        kind,
      );
      assert.equal(out.receipts, 1, kind);
      assert.equal(out.calls.filter((x) => x === "create").length, 1, kind);
      assert.doesNotMatch(JSON.stringify(out.result), /PRIVATE_NATIVE_ERROR/);
    }
  },
);

test(
  "native errors preserve creation intent with a static failure and never retry/delete",
  { skip: !available },
  () => {
    for (const kind of ["import", "switches", "receipt", "create"]) {
      const out = run(`${mocks}$script:fail='${kind}'\n${invoke}`);
      assert.equal(out.result.stage, "failed_preserved_requires_inspection");
      assert.equal(out.result.failureCode, "private_switch_not_verified");
      assert.ok(out.calls.filter((x) => x === "create").length <= 1);
      assert.doesNotMatch(JSON.stringify(out.result), /PRIVATE_NATIVE_ERROR/);
    }
  },
);

test(
  "concurrent network drift after intent blocks creation",
  { skip: !available },
  () => {
    const out = run(`${mocks}
function Write-CityGoPrivateSwitchEvidence {param($Path,$Value,$Plan,$Owner)
 Track 'receipt';$script:receipts[$Path]=$Value;$script:nics[0].MacAddress='001122334477'
}
${invoke}`);
    assert.equal(out.result.failurePhase, "recheck_before_creation");
    assert.ok(!out.calls.includes("create"));
    assert.equal(out.receipts, 1);
  },
);
