import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const names = ["Watch-CityGoJobClient.ps1", "New-CityGoJobPublicIso.ps1"];
const paths = names.map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const source = paths.map((path) => readFileSync(path, "utf8"));
const legacy = readFileSync(
  new URL("../deploy/ci/Watch-CityGoOwnedCanary.ps1", import.meta.url),
  "utf8",
);
const available =
  process.platform === "win32" &&
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { windowsHide: true, timeout: 10000 },
  ).status === 0;
function run(command) {
  const code = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
foreach($file in @(${paths.map((path) => "'" + path.replaceAll("'", "''") + "'").join(",")})){
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$t,[ref]$e)
 if($e.Count){throw 'parse'}
 foreach($d in $a.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
  if($d.Parameters.Count){throw 'inline-parameters'};Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
 }
}
${command}`;
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
  return JSON.parse(r.stdout.replace(/^\uFEFF/, "").trim());
}
test("job client adapter pins original lifecycle; ISO builder is public-only and neither can boot/connect/register", () => {
  assert.ok(
    source[0].includes(createHash("sha256").update(legacy).digest("hex")),
  );
  for (const raw of source)
    assert.doesNotMatch(
      raw,
      /\b(?:Start-VM|Connect-VMNetworkAdapter|Remove-VM|New-NetNat|Invoke-Expression|credential fill|generate-jitconfig)\b/,
    );
  assert.match(source[1], /files\.Count-ne5/);
  assert.match(source[1], /227660598/);
  assert.match(source[1], /75913191/);
  assert.match(source[1], /FileMode\.CreateNew/);
  assert.match(source[1], /335544320/);
});
test("larger public ISO retains EVERY original ACL/hash guard and requires locked full-job lease before IO", () => {
  const old = legacy.match(
    /function Open-CityGoWatchdogPublicSeed \{[\s\S]*?\n\}\n/,
  )[0];
  const next = source[0].match(
    /function Open-CityGoJobClientPublicSeed \{[\s\S]*?\n\}\n/,
  )[0];
  const extra = String.raw`    Assert-CityGoWatchdog ($Plan.jobPlanSha256-is[string]-and$Plan.jobPlanSha256-cmatch'^[a-f0-9]{64}$'-and
        $Plan.publicSeedPath-ceq('D:\CityGo-CI\seeds\'+$Plan.operationId+'\runner-cidata.iso')) 'full_job_public_seed_required'
    $j=Open-CityGoCanaryCleanupEvidence $Plan.jobPlanPath $Owner $Plan.jobPlanSha256
    try{$null=Get-CityGoWatchdogJobLease $j.value $Plan}finally{$j.stream.Dispose()}
    $path=$Plan.publicSeedPath;`;
  const expected = old
    .replace(
      "function Open-CityGoWatchdogPublicSeed",
      "function Open-CityGoJobClientPublicSeed",
    )
    .replace("    $path=$Plan.publicSeedPath;", () => extra)
    .replace(
      "        $maximum=4MB\n        if([IO.Path]::GetFileName($path)-ceq'runner-cidata.iso'){$maximum=256MB}",
      "        $maximum=320MB",
    );
  assert.equal(next, expected);
});
const fixture = String.raw`
$op='12345678-1234-4234-8234-123456789abc';$vm='98765432-1234-4234-8234-123456789abc'
$q=@{operationId=$op;vmId=$vm;manifestSha256=('a'*64);networkSha256=('b'*64);jobPlanSha256=('c'*64);publicSeedSha256=('d'*64);apply=$false;acknowledge=''}
$iso=@{operationId=$op;inputDirectory=('D:\CityGo-CI\control\'+$op+'\job-seed-input');userDataSha256=('a'*64);metaDataSha256=('b'*64);networkConfigSha256=('c'*64);apply=$false;acknowledge=''}
`;
test(
  "default plans and wrong acknowledgements cannot read files, request admin or dispatch native commands",
  { skip: !available },
  () => {
    const out = run(
      fixture +
        String.raw`
function Assert-CityGoJobIsoPlain {throw 'must-not-read'}
$a=Invoke-CityGoJobClientWatch $q;$b=Invoke-CityGoJobIso $iso
$q.apply=$true;$q.acknowledge='wrong';$iso.apply=$true;$iso.acknowledge='wrong'
$denied=0;try{$null=Invoke-CityGoJobClientWatch $q}catch{if($_.Exception.Message-ceq'ci_job_watch_acknowledgement'){$denied++}}
try{$null=Invoke-CityGoJobIso $iso}catch{if($_.Exception.Message-ceq'ci_job_iso_acknowledgement'){$denied++}}
@{a=$a.stage;b=$b.stage;denied=$denied;output=$b.plan.outputPath}|ConvertTo-Json -Compress`,
    );
    assert.equal(out.a, "plan_only_unverified");
    assert.equal(out.b, "plan_only_unverified");
    assert.equal(out.denied, 2);
    assert.equal(
      out.output,
      "D:\\CityGo-CI\\seeds\\12345678-1234-4234-8234-123456789abc\\runner-cidata.iso".replaceAll(
        "\\\\",
        "\\",
      ),
    );
  },
);
test(
  "unsafe identities, paths or hashes refuse before any artifact or native access",
  { skip: !available },
  () => {
    const out = run(
      fixture +
        String.raw`
$bad=0
foreach($path in @('C:\outside','D:\CityGo-CI\control\..\job-seed-input','\\server\share')){$copy=@{};foreach($k in $iso.Keys){$copy[$k]=$iso[$k]};$copy.inputDirectory=$path;try{$null=Get-CityGoJobIsoPlan $copy}catch{$bad++}}
foreach($op2 in @('..','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA','00000000-0000-0000-0000-000000000000')){$q.operationId=$op2;try{$null=Invoke-CityGoJobClientWatch $q}catch{$bad++}}
@{denied=$bad}|ConvertTo-Json -Compress`,
    );
    assert.equal(out.denied, 6);
  },
);
