import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const path = fileURLToPath(
  new URL("../deploy/ci/Read-CityGoCommittedCiRecord.ps1", import.meta.url),
);
const source = readFileSync(path, "utf8");
const available =
  process.platform === "win32" &&
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { windowsHide: true, timeout: 10000 },
  ).status === 0;
function run(body) {
  const code =
    [
      "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
      "$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('__PATH__',[ref]$t,[ref]$e);if($e.Count){throw 'parse_failed'}",
      "$f=@($a.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true));if($f.Count-ne1){throw 'definition_count'};Set-Item Function:script:Read-CityGoCommittedCiRecord -Value $f[0].Body.GetScriptBlock()",
      "$op='12345678-1234-4234-8234-123456789abc';$owner='S-1-5-21-1-2-3-1001'",
      "$script:calls=[Collections.Generic.List[string]]::new();$script:exists=$true;$script:opened=$null",
      "function Assert-CityGoCanaryStopPlainPath {param($Path,$Directory);$script:calls.Add('plain');if(-not$Directory-or$Path-cne('D:\\CityGo-CI\\control\\'+$op)){throw 'path_guard'}}",
      "function Assert-CityGoCanaryStopAcl {param($Path,$OwnerSid,$ProtectedDirectory);$script:calls.Add('acl');if(-not$ProtectedDirectory-or$OwnerSid-cne$owner){throw 'acl_guard'}}",
      "function Test-Path {param($LiteralPath,$ErrorAction);$script:calls.Add('exists');return $script:exists}",
      "function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid);$script:calls.Add('open');$script:opened=[IO.MemoryStream]::new();return @{value=[pscustomobject]@{stage='armed_off_client'};stream=$script:opened}}",
    ]
      .join("\n")
      .replace("__PATH__", path.replaceAll("'", "''")) +
    "\n" +
    body;
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(code, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout.trim().replace(/^\uFEFF/, ""));
}
test("committed CI record library has no entrypoint, writes, native VM, network, sleep or policy operations", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Start-VM|Stop-VM|Remove-VM|Set-Content|Add-Content|WriteAllText|CreateNew|Start-Sleep|Set-ExecutionPolicy|Invoke-Expression|Invoke-WebRequest)\b/,
  );
  assert.match(source, /Open-CityGoCanaryCleanupEvidence/);
  assert.match(source, /\.Dispose\(\)/);
});
test(
  "invalid operation, record name and owner refuse before any filesystem observation",
  { skip: !available },
  () => {
    const out = run(
      "$r=@();foreach($case in @('op','name','owner')){$script:calls.Clear();$o=$op;$n='watchdog-ready.json';$who=$owner;switch($case){op{$o=$op.ToUpperInvariant()} name{$n='..\\secret.pem'} owner{$who='S-1-5-18'}};$denied=$false;try{$null=Read-CityGoCommittedCiRecord $o $n $who}catch{$denied=$true};$r+=,@{denied=$denied;calls=@($script:calls)}};ConvertTo-Json -InputObject $r -Compress",
    );
    for (const r of out) {
      assert.equal(r.denied, true);
      assert.deepEqual(r.calls, []);
    }
  },
);
test(
  "missing file is not committed, but still requires private plain parent",
  { skip: !available },
  () => {
    const out = run(
      "$script:exists=$false;$r=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner;@{missing=($null-eq$r);calls=@($script:calls)}|ConvertTo-Json -Compress",
    );
    assert.equal(out.missing, true);
    assert.deepEqual(out.calls, ["plain", "acl", "exists"]);
  },
);
test(
  "successful committed record returns data and disposes its locked evidence",
  { skip: !available },
  () => {
    const out = run(
      "$r=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner;@{stage=$r.stage;closed=(-not$script:opened.CanRead);calls=@($script:calls)}|ConvertTo-Json -Compress",
    );
    assert.equal(out.stage, "armed_off_client");
    assert.equal(out.closed, true);
    assert.deepEqual(out.calls, ["plain", "acl", "exists", "open"]);
  },
);
test(
  "only nested sharing/lock violations are an uncommitted observation",
  { skip: !available },
  () => {
    const out = run(
      "$r=@();foreach($code in @(-2147024864,-2147024863)){function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid);throw [InvalidOperationException]::new('synthetic_wrapper',[IO.IOException]::new('synthetic_lock',$code))};$v=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner;$r+=,@{waiting=($null-eq$v)}};ConvertTo-Json -InputObject $r -Compress",
    );
    for (const r of out) assert.equal(r.waiting, true);
  },
);
test(
  "invalid JSON, denied ACL, missing-after-observation and other I/O remain fatal",
  { skip: !available },
  () => {
    const out = run(
      "$r=@();foreach($case in @('json','acl','missing','io')){function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid);switch($case){json{throw [FormatException]::new('synthetic_json')} acl{throw [UnauthorizedAccessException]::new('synthetic_acl')} missing{throw [IO.IOException]::new('synthetic_missing',-2147024894)} io{throw [IO.IOException]::new('synthetic_io',-2147024891)}}};$denied=$false;try{$null=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner}catch{$denied=$true};$r+=,@{case=$case;denied=$denied}};ConvertTo-Json -InputObject $r -Compress",
    );
    for (const r of out) assert.equal(r.denied, true, r.case);
  },
);
test(
  "parent guard failures cannot be mistaken for a writer lock",
  { skip: !available },
  () => {
    const out = run(
      "function Assert-CityGoCanaryStopAcl {param($Path,$OwnerSid,$ProtectedDirectory);throw 'private_parent_refused'};$denied=$false;try{$null=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner}catch{$denied=$_.Exception.Message-ceq'private_parent_refused'};@{denied=$denied;calls=@($script:calls)}|ConvertTo-Json -Compress",
    );
    assert.equal(out.denied, true);
    assert.deepEqual(out.calls, ["plain"]);
  },
);
test(
  "REAL exclusive writer race waits, then reads closed UTF-8 JSON without admitting partial data",
  { skip: !available },
  () => {
    const out = run(
      [
        "$fixture=[IO.Path]::Combine([IO.Path]::GetTempPath(),('citygo-record-lock-'+[guid]::NewGuid().ToString('D')+'.json'));$writer=$null",
        "function Open-CityGoCanaryCleanupEvidence {param($Path,$OwnerSid);$s=[IO.File]::Open($fixture,'Open','Read','Read');try{$r=[IO.StreamReader]::new($s,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);try{$value=$r.ReadToEnd()|ConvertFrom-Json -ErrorAction Stop}finally{$r.Dispose()};return @{value=$value;stream=$s}}catch{$s.Dispose();throw}}",
        "try{$writer=[IO.File]::Open($fixture,'CreateNew','Write','None');$bytes=[Text.Encoding]::UTF8.GetBytes('{\"stage\":\"armed_off_client\"}');$writer.Write($bytes,0,$bytes.Length);$writer.Flush($true);$before=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner;$writer.Dispose();$writer=$null;$after=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner;[IO.File]::WriteAllText($fixture,'{\"stage\":');$denied=$false;try{$null=Read-CityGoCommittedCiRecord $op 'watchdog-ready.json' $owner}catch{$denied=$true};@{lockedNotReady=($null-eq$before);closedStage=$after.stage;closedInvalidDenied=$denied}|ConvertTo-Json -Compress}finally{if($writer){$writer.Dispose()};if([IO.File]::Exists($fixture)){[IO.File]::Delete($fixture)}}",
      ].join("\n"),
    );
    assert.equal(out.lockedNotReady, true);
    assert.equal(out.closedStage, "armed_off_client");
    assert.equal(out.closedInvalidDenied, true);
  },
);
