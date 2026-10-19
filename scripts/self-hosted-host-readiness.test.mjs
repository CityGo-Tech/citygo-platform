import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../deploy/ci/Test-CityGoRunnerHost.ps1", import.meta.url),
);
const source = readFileSync(script, "utf8");
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const probe = spawnSync(
  shell,
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ],
  { encoding: "utf8" },
);
const available = probe.status === 0;

function runPowerShell(command) {
  command = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop';\n${command}`;
  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

const parse = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'parse_failed' }
`;

test("host readiness diagnostic contains no configuration writes or sensitive inventory", () => {
  assert.doesNotMatch(
    source,
    /^\s*(?:Enable|Disable|Install|Uninstall|Restart|Start|Stop|Set|New|Remove|Add|Register|Invoke|Import)-[A-Za-z]/m,
  );
  assert.doesNotMatch(
    source,
    /\b(?:Start-Process|dism(?:\.exe)?|bcdedit|wsl(?:\.exe)?|docker|curl|wget|ssh|sc\.exe)\b/i,
  );
  assert.doesNotMatch(
    source,
    /\$env:|Exception\.Message|ComputerName|UserName|IPAddress|Write-Host|Write-Error|Out-File|Set-Content|Add-Content|Export-/i,
  );
  assert.match(source, /readyForVmProvisioning = \$blockers\.Count -eq 0/);
  assert.match(source, /guestIsolationVerified = \$false/);
  assert.doesNotMatch(source, /readyForChecks/);
});

test(
  "PowerShell parser accepts diagnostic and permits only read-only commands",
  { skip: !available },
  () => {
    const commands = runPowerShell(`${parse}
$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
ConvertTo-Json -InputObject $commands -Compress
`);
    const allowed = new Set([
      "Get-CimInstance",
      "Get-WindowsOptionalFeature",
      "Get-Service",
      "Get-Module",
      "Get-Command",
      "Get-CityGoHostInventory",
      "Get-CityGoHostReadiness",
      "ConvertTo-Json",
    ]);
    for (const command of commands) assert.ok(allowed.has(command), command);
  },
);

test(
  "synthetic readiness fails closed for every unknown and never proves guest isolation",
  { skip: !available },
  () => {
    const output = runPowerShell(`${parse}
$definition = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-CityGoHostReadiness' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$profile = [ordered]@{ guestVcpu=4; guestMemoryGiB=8; guestDiskGiB=96; hostMemoryReserveGiB=8; diskHeadroomGiB=32; dataVolume='D' }
$base = [ordered]@{ windows=$true; osVersion='10.0.26100'; osBuild=26100; editionCode=48; os64Bit=$true; totalMemoryBytes=32GB; freeMemoryBytes=24GB; logicalProcessors=12; dataVolumeFreeBytes=400GB; systemVolumeFreeBytes=16GB; administrator=$true; hypervisorPresent=$true; hypervFeature='Enabled'; vmmsState='Running'; hypervModuleAvailable=$true; hypervCmdletsAvailable=$true }
$results = [ordered]@{ ready=(Get-CityGoHostReadiness $base $profile); unknowns=@() }
foreach ($key in @($base.Keys)) {
  $copy=[ordered]@{}; foreach ($original in $base.Keys) { $copy[$original]=$base[$original] }
  $copy[$key]=$null
  $results.unknowns += [ordered]@{ field=$key; report=(Get-CityGoHostReadiness $copy $profile) }
}
$copy=[ordered]@{}; foreach ($key in $base.Keys) { $copy[$key]=$base[$key] }; $copy.administrator=$false; $copy.hypervFeature='Unknown'; $copy.vmmsState='Unknown'; $copy.hypervModuleAvailable=$false; $copy.hypervCmdletsAvailable=$false
$results.unelevated = Get-CityGoHostReadiness $copy $profile
$copy=[ordered]@{}; foreach ($key in $base.Keys) { $copy[$key]=$base[$key] }; $copy.hypervFeature='EnablePending'
$results.reboot = Get-CityGoHostReadiness $copy $profile
$copy=[ordered]@{}; foreach ($key in $base.Keys) { $copy[$key]=$base[$key] }; $copy.freeMemoryBytes=12GB; $copy.dataVolumeFreeBytes=100GB; $copy.logicalProcessors=2
$results.resources = Get-CityGoHostReadiness $copy $profile
$profile.guestVcpu=0
$results.invalidProfile = Get-CityGoHostReadiness $base $profile
$results | ConvertTo-Json -Depth 10 -Compress
`);
    assert.equal(output.ready.readyForVmProvisioning, true);
    assert.deepEqual(output.ready.blockers, []);
    for (const item of output.unknowns) {
      assert.equal(item.report.readyForVmProvisioning, false, item.field);
      assert.ok(item.report.blockers.length, item.field);
    }
    assert.ok(output.unelevated.blockers.includes("admin_inventory_required"));
    assert.ok(
      output.unelevated.blockers.includes("hyperv_not_enabled_or_unverified"),
    );
    assert.ok(output.reboot.blockers.includes("reboot_or_service_unready"));
    for (const blocker of [
      "insufficient_logical_processors",
      "insufficient_free_memory_with_host_reserve",
      "insufficient_data_volume_space",
    ])
      assert.ok(output.resources.blockers.includes(blocker));
    assert.ok(
      output.invalidProfile.blockers.includes("resource_profile_invalid"),
    );
    for (const report of [
      output.ready,
      output.unelevated,
      output.reboot,
      output.resources,
      output.invalidProfile,
    ]) {
      assert.equal(report.guestIsolationVerified, false);
      assert.equal(report.githubRunnerRegistered, false);
      assert.equal(report.githubJobsAuthorized, false);
      assert.equal(report.changedHostConfiguration, false);
    }
  },
);
