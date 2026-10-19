import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderEphemeralRunnerCanarySeed } from "../deploy/ci/render-ephemeral-runner-seed.mjs";
import { renderPrivateGatewaySeed } from "../deploy/ci/render-private-gateway-seed.mjs";

const root = new URL("../deploy/ci/", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const source = read("ephemeral-runner-canary.py");
const network = read("private-network-canary.py");
const helper = read("offline-clone-canary.py");
const hash = (x) => createHash("sha256").update(x).digest("hex");
const operation = "12345678-1234-4234-8234-123456789abc";
const config = {
  schemaVersion: 1,
  operationId: operation,
  gatewayOperationId: "98765432-1234-4234-8234-123456789abc",
  hostSnapshotSha256: "a".repeat(64),
  mac: "02:11:22:33:44:55",
  hostIPv4: ["172.30.16.1"],
  productionIPv4: ["93.184.216.34"],
};
const input = () => ({
  configJson: JSON.stringify(config),
  clientSourceLF: network,
  offlineHelperSourceLF: helper,
  runnerSourceLF: source,
  expectedRunnerSha256: hash(source),
});
const python = process.platform === "win32" ? "python" : "python3";
function run(code) {
  const result = spawnSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      `import importlib.util,sys,datetime,json\ns=importlib.util.spec_from_file_location('r',sys.argv[1]);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)\n` +
        code,
      fileURLToPath(new URL("ephemeral-runner-canary.py", root)),
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("runner default plan/refusal have no native side effects and public sources agree", () => {
  assert.ok(source.includes(hash(network)));
  assert.ok(source.includes(hash(helper)));
  assert.equal(
    run(
      `assert r.main(['--plan','--operation-id','${operation}'])==0\nassert r.main(['--apply','--operation-id','${operation}'])==2`,
    ).split("\n").length,
    2,
  );
});

test("runner public seed is bounded, exact and contains no registration credential", () => {
  const seed = renderEphemeralRunnerCanarySeed(input());
  const data = JSON.parse(seed.userData.slice("#cloud-config\n".length));
  assert.equal(data.write_files.length, 4);
  assert.equal(
    data.write_files[0].path,
    "/usr/local/sbin/citygo-ephemeral-runner-canary.py",
  );
  assert.equal(
    data.write_files[3].path,
    "/var/lib/citygo-ci-runner/config.json",
  );
  assert.equal(data.runcmd[0].at(-1), "RUN_EPHEMERAL_CANARY:" + operation);
  assert.match(seed.metaData, /citygo-runner-canary-/);
  assert.equal(
    data.write_files.some(
      (x) => x.path.includes("kvp") || x.path.includes("credentials"),
    ),
    false,
  );
  assert.ok(seed.userData.length <= 190000);
  for (const mutation of [
    { ...input(), token: "never" },
    { ...input(), expectedRunnerSha256: "0".repeat(64) },
    { ...input(), runnerSourceLF: source + "\r" },
    {
      ...input(),
      configJson: JSON.stringify({ ...config, repository: "foreign/repo" }),
    },
  ])
    assert.throws(() => renderEphemeralRunnerCanarySeed(mutation));
  assert.throws(() => renderEphemeralRunnerCanarySeed(new Proxy(input(), {})));
  const accessor = input();
  Object.defineProperty(accessor, "runnerSourceLF", {
    get() {
      throw new Error("never invoke");
    },
    enumerable: true,
  });
  assert.throws(
    () => renderEphemeralRunnerCanarySeed(accessor),
    /fields_invalid/,
  );
});

test("scoped host KVP auth rejects duplicates, wrong repo/op, expiry and malformed records", () => {
  assert.equal(
    run(`
op='${operation}';now=datetime.datetime(2026,10,19,12,tzinfo=datetime.timezone.utc)
value=dict(operationId=op,repository=r.REPOSITORY,token='A'*30,expiresAt='2026-10-19T12:50:00Z')
def record(v,key='CityGoRunnerAuth-'+op):return key.encode().ljust(512,b'\\0')+json.dumps(v,separators=(',',':')).encode().ljust(2048,b'\\0')
raw=record(value)
assert r.auth_record(raw,op,now,json.loads)=='A'*30
assert r.auth_record(record(value,'foreign'),op,now,json.loads) is None
cases=[raw+raw,b'x',record(dict(value,repository='foreign/repo')),record(dict(value,operationId='foreign')),record(dict(value,expiresAt='2026-10-19T11:00:00Z')),record(dict(value,expiresAt='2026-10-19T14:00:00Z')),record(dict(value,token='evil\\ncommand')),record(dict(value,extra=True))]
for raw in cases:
 try:r.auth_record(raw,op,now,json.loads);raise AssertionError('accepted')
 except r.Refused:pass
print('auth_ok')`),
    "auth_ok",
  );
});

test("registration fixes repo, unique label, ephemeral/update flags; no root run or shell", () => {
  const args = JSON.parse(
    run(`print(json.dumps(r.registration_args('${operation}','A'*30)))`),
  );
  for (const flag of [
    "--ephemeral",
    "--disableupdate",
    "--no-default-labels",
    "--unattended",
  ])
    assert.ok(args.includes(flag));
  assert.equal(
    args[args.indexOf("--labels") + 1],
    "citygo-ci-canary-" + hash(operation).slice(0, 16),
  );
  assert.equal(
    args[args.indexOf("--url") + 1],
    "https://github.com/CityGo-Tech/citygo-platform",
  );
  assert.doesNotMatch(
    source,
    /shell=True|RUNNER_ALLOW_RUNASROOT|GITHUB_TOKEN|install.*dependencies\.sh|verify=False/,
  );
  assert.doesNotMatch(source, /native\(\["\/usr\/bin\/curl"/);
  assert.match(source, /"ro,nodev,nosuid,noexec", "\/dev\/sr0", BUNDLE/);
  assert.match(source, /native\(\["\/usr\/bin\/umount", "--", BUNDLE\]/);
  assert.match(source, /hashlib\.file_digest\(stream, "sha256"\).*ARCHIVE_SHA/);
  assert.match(source, /extractall\(ROOT, members=members, filter="data"\)/);
  assert.match(
    source,
    /native\(registration_args\(operation, token\), 75, uid, gid, groups, ROOT\)/,
  );
  assert.match(
    source,
    /native\(\[ROOT \+ "\/run.sh"\], 300, uid, gid, groups, ROOT\)/,
  );
  assert.ok(
    source.indexOf("validate_seed(guest, value)") <
      source.indexOf("proof = network.probe_client"),
  );
  assert.ok(
    source.indexOf("proof = network.probe_client") <
      source.indexOf(
        "uid, gid, groups = install_runner(operation, guest, helper)",
      ),
  );
});

test("900-second gateway canary is explicit; ordinary witness stays bounded at 180", () => {
  const initializer = read("private-gateway-init.py");
  const data = {
    configJson: JSON.stringify({
      schemaVersion: 1,
      operationId: operation,
      capturedAt: "2026-10-19T12:00:00Z",
      hostSnapshotSha256: "a".repeat(64),
      wanMac: "02:11:22:33:44:55",
      lanMac: "02:11:22:33:44:56",
      expectedWanPrefix: "172.30.16.0/20",
      expectedWanGatewayIPv4: "172.30.16.1",
      hostIPv4: ["172.30.16.1"],
      productionIPv4: ["93.184.216.34"],
      additionalDeniedPrefixes: [],
    }),
    initializerSourceLF: initializer,
    expectedInitializerSha256: hash(initializer),
    policySourceLF: read("private-gateway-policy.py"),
    offlineHelperSourceLF: helper,
    witnessSourceLF: network,
  };
  assert.match(renderPrivateGatewaySeed(data).userData, /--observe-canary/);
  assert.match(
    renderPrivateGatewaySeed({ ...data, observationMode: "runner-canary" })
      .userData,
    /--observe-runner-canary/,
  );
  assert.throws(() =>
    renderPrivateGatewaySeed({ ...data, observationMode: "unbounded" }),
  );
  assert.match(
    network,
    /type\(window_seconds\) is int and window_seconds in \(180, 900\)/,
  );
  assert.match(
    initializer,
    /window_seconds=900 if runner_observation else 180/,
  );
});

test("unique diagnostic workflow grants no permissions and cannot replace release checks", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/isolated-runner-canary.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /runs-on: \[citygo-ci-canary-47a6f940dc442649\]/);
  assert.match(workflow, /timeout-minutes: 3/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(
    workflow,
    /\buses:|secrets\.|pull_request_target|continue-on-error|checkout|contents: write|packages: write/,
  );
  assert.match(workflow, /test "\$\(id -u\)" -ne 0/);
  assert.match(workflow, /test ! -e \.git/);
  assert.match(workflow, /CITYGO_EPHEMERAL_CANARY_OK/);
});

test("configured ephemeral and update policy come from the actual runner settings before listening", () => {
  assert.equal(
    run(`
op='${operation}'
v=dict(agentId=21,agentName='citygo-ci-canary-'+op,ephemeral=True,disableUpdate=True,workFolder='_work',gitHubUrl='https://github.com/'+r.REPOSITORY)
assert r.configured_settings(json.dumps(v).encode(),op,json.loads)==21
assert r.configured_settings(b'\\xef\\xbb\\xbf'+json.dumps(v).encode(),op,json.loads)==21
for changed in [dict(v,ephemeral=False),dict(v,disableUpdate=False),dict(v,agentId=True),dict(v,agentName='foreign'),dict(v,workFolder='/host'),dict(v,gitHubUrl='https://github.com/foreign/repo')]:
 try:r.configured_settings(json.dumps(changed).encode(),op,json.loads);raise AssertionError('accepted')
 except r.Refused:pass
print('settings_ok')`),
    "settings_ok",
  );
  assert.ok(
    source.indexOf("agent_id = configured_settings") <
      source.indexOf('phase = "run_one_job"'),
  );
  assert.ok(
    source.indexOf("while read_auth(operation") <
      source.indexOf('phase = "run_one_job"'),
  );
  assert.match(source, /host_registration_not_removed/);
});

test("public archive bundle is operation-bound and verified before extraction, with no guest download fallback", () => {
  assert.equal(
    run(`
op='${operation}'
v={'instance-id':'citygo-runner-canary-'+op,'local-hostname':'citygo-ci-canary-'+op}
r.bundle_identity(json.dumps(v).encode(),op,json.loads)
for changed in [dict(v,extra='foreign'),dict(v,**{'instance-id':'foreign'})]:
 try:r.bundle_identity(json.dumps(changed).encode(),op,json.loads);raise AssertionError('accepted')
 except r.Refused:pass
print('bundle_ok')`),
    "bundle_ok",
  );
  assert.ok(
    source.indexOf('hashlib.file_digest(stream, "sha256")') <
      source.indexOf("source.extractall(ROOT"),
  );
  assert.match(source, /stat\.S_ISBLK\(os\.lstat\("\/dev\/sr0"\)/);
  assert.match(source, /set\(os\.listdir\(BUNDLE\)\).*ARCHIVE_NAME/);
  assert.doesNotMatch(source, /curl.*--location|requests\.|urlopen\(/);
  assert.match(
    source,
    /native\(\["\/usr\/local\/bin\/pnpm", "--version"\].*account\.pw_uid/,
  );
});

test("real repository REST shape with os=unknown and omitted ephemeral stays observation, not fabricated readiness", () => {
  const apiSource = read("ephemeral-runner-api-readback.ps1");
  assert.doesNotMatch(
    apiSource,
    /Get-VM|Invoke-Cim|HttpClient|Invoke-WebRequest|credential fill|Set-Item|WriteAll|\$env:/,
  );
  const code = `$ErrorActionPreference='Stop'
. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(apiSource).toString("base64")}'))))
$op='${operation}';$name='citygo-ci-canary-'+$op;$label='citygo-ci-canary-${hash(operation).slice(0, 16)}'
$r=[pscustomobject]@{id=21;name=$name;os='unknown';status='online';busy=$true;labels=@([pscustomobject]@{name=$label;type='custom'})}
$good=Get-CityGoRunnerApiReadback $r $op 21
$denied=@()
foreach($change in @('id','name','os','label','ephemeral-false','ephemeral-string')){
 $item=$r|ConvertTo-Json -Depth 5 -Compress|ConvertFrom-Json
 if($change-ceq'id'){$item.id=22};if($change-ceq'name'){$item.name='foreign'};if($change-ceq'os'){$item.os='windows'};if($change-ceq'label'){$item.labels[0].name='foreign'}
 if($change-ceq'ephemeral-false'){$item|Add-Member -NotePropertyName ephemeral -NotePropertyValue $false};if($change-ceq'ephemeral-string'){$item|Add-Member -NotePropertyName ephemeral -NotePropertyValue 'true'}
 try{$null=Get-CityGoRunnerApiReadback $item $op 21;$denied+=$false}catch{$denied+=$true}
}
[ordered]@{good=$good;denied=$denied}|ConvertTo-Json -Depth 6 -Compress`;
  const ps =
    process.platform === "win32"
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "pwsh";
  const result = spawnSync(
    ps,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(code, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.good.apiOs, "unknown");
  assert.equal(observed.good.ephemeralAttributePresent, false);
  assert.equal(observed.good.linuxOrEphemeralReadinessProven, false);
  assert.deepEqual(observed.denied, [true, true, true, true, true, true]);
});
