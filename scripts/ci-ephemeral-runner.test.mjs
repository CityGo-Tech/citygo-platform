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
  assert.match(source, /--proto-redir.*=https/);
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
      source.indexOf("uid, gid, groups = install_runner()"),
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
  assert.match(workflow, /runs-on: \[citygo-ci-canary-239d735738b81481\]/);
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
