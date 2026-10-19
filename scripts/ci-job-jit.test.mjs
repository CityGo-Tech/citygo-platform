import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureJobPlan } from "./ci-job-fixtures.mjs";
import { fragmentJobJit } from "../deploy/ci/job-jit-transport.mjs";
import {
  JOB_RUNNER_PINS,
  renderJobRunnerSeed,
} from "../deploy/ci/render-job-runner-seed.mjs";

const plan = fixtureJobPlan();
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const planSha = hash(JSON.stringify(plan) + "\n");
const now = plan.createdAt;
const read = (name) =>
  readFileSync(new URL("../deploy/ci/" + name, import.meta.url), "utf8");
function fakeFiles() {
  return {
    ".runner": JSON.stringify({
      agentId: 99,
      agentName: "citygo-ci-job-" + plan.operationId,
      ephemeral: true,
      disableUpdate: true,
      workFolder: "_work",
      gitHubUrl: "https://github.com/CityGo-Tech",
    }),
    ".credentials": JSON.stringify({
      scheme: "OAuth",
      data: { clientId: "SYNTHETIC-NOT-A-CREDENTIAL" },
    }),
    ".credentials_rsaparams": JSON.stringify({
      D: "SYNTHETIC-NOT-A-PRIVATE-KEY",
    }),
  };
}
function encode(files) {
  return Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(files).map(([key, raw]) => [
          key,
          Buffer.from(raw).toString("base64"),
        ]),
      ),
    ),
  ).toString("base64");
}
function fakeJit() {
  return {
    runnerId: 99,
    runnerName: "citygo-ci-job-" + plan.operationId,
    encodedJitConfig: encode(fakeFiles()),
  };
}
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
const paths = ["job-jit.py", "job-runner.py"].map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const harness = String.raw`
import base64,datetime,importlib.util,json,sys
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
j=load('test_job_jit',sys.argv[1]);r=load('test_job_runner',sys.argv[2])
data=json.loads(sys.stdin.read());p=data['plan'];sha=data['sha'];now=datetime.datetime(2026,10,19,8,0,0,tzinfo=datetime.timezone.utc)
records=data['records'];files=data['files'];encoded=data['encoded']
def pool(records):return b''.join(x['name'].encode('ascii').ljust(512,b'\0')+x['value'].encode('ascii').ljust(2048,b'\0') for x in records)
def denied(call):
 try:call();return False
 except Exception:return True
`;
function run(code, changes = {}) {
  const r = spawnSync(
    python,
    ["-I", "-B", "-c", harness + "\n" + code, ...paths],
    {
      input: JSON.stringify({
        plan,
        sha: planSha,
        records: fragmentJobJit(plan, planSha, fakeJit(), now),
        files: fakeFiles(),
        encoded: fakeJit().encodedJitConfig,
        ...changes,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout);
}
test("JIT host transport fragments only one-agent config; meta commits last and values fit KVP", () => {
  const records = fragmentJobJit(plan, planSha, fakeJit(), now);
  assert.ok(records.at(-1).name.endsWith("-meta"));
  assert.equal(
    records
      .slice(0, -1)
      .map((x) => x.value)
      .join(""),
    fakeJit().encodedJitConfig,
  );
  assert.ok(
    records.every(
      (x) =>
        x.value.length <= 1022 &&
        x.name.startsWith("CityGoJobJit-" + plan.operationId + "-"),
    ),
  );
  const biggest = {
    ...fakeJit(),
    encodedJitConfig: Buffer.alloc(98304, 65).toString("base64"),
  };
  assert.equal(fragmentJobJit(plan, planSha, biggest, now).length, 147);
  for (const change of [
    { runnerName: "foreign" },
    { runnerId: 0 },
    { encodedJitConfig: "bad" },
    { encodedJitConfig: Buffer.alloc(98307).toString("base64") },
  ])
    assert.throws(
      () => fragmentJobJit(plan, planSha, { ...fakeJit(), ...change }, now),
      /jit_transport_binding/,
    );
  assert.throws(
    () => fragmentJobJit(plan, planSha, fakeJit(), "2026-10-19T09:09:00.000Z"),
    /jit_transport_time/,
  );
});
test(
  "guest assembles exact full host transport without running config command or exposing values",
  { skip: !available },
  () => {
    const out = run(String.raw`
actual,runner=j.assemble(pool(records),p,sha,now)
print(json.dumps(dict(count=len(actual),runner=runner,identical=all(actual[k]==v.encode('ascii') for k,v in files.items()))))`);
    assert.deepEqual(out, { count: 3, runner: 99, identical: true });
  },
);
test(
  "partial/changing/duplicate/expired JIT never produces usable configuration",
  { skip: !available },
  () => {
    const out = run(String.raw`
checks=[j.assemble(b'',p,sha,now) is None,j.assemble(pool(records[:-1]),p,sha,now) is None]
checks.append(denied(lambda:j.assemble(pool(records[-1:]),p,sha,now)))
checks.append(denied(lambda:j.assemble(pool(records+[records[0]]),p,sha,now)))
changed=json.loads(json.dumps(records));changed[0]['value']='A'+changed[0]['value'][1:]
checks.append(denied(lambda:j.assemble(pool(changed),p,sha,now)))
checks.append(denied(lambda:j.assemble(pool(records),p,'0'*64,now)))
checks.append(denied(lambda:j.assemble(pool(records),p,sha,now+datetime.timedelta(seconds=121))))
checks.append(denied(lambda:j.assemble(pool(records)+b'x',p,sha,now)))
print(json.dumps(dict(denied=all(checks),count=len(checks))))`);
    assert.equal(out.denied, true);
    assert.equal(out.count, 8);
  },
);
test(
  "JIT file allowlist and actual settings reject traversal, foreign identity, non-ephemeral and update-enabled config",
  { skip: !available },
  () => {
    const out = run(String.raw`
def encode(files):return base64.b64encode(json.dumps({k:base64.b64encode(v.encode('ascii')).decode('ascii') for k,v in files.items()}).encode('ascii')).decode('ascii')
checks=[]
for name in ('../escape','.service','credentials','.runner/child'):
 changed=dict(files);changed[name]='{}';checks.append(denied(lambda:j.decode_config(encode(changed),p,99)))
for key,value in [('ephemeral',False),('disableUpdate',False),('agentName','foreign'),('agentId',True),('gitHubUrl','https://github.com/foreign'),('workFolder','../work')]:
 changed=dict(files);settings=json.loads(files['.runner']);settings[key]=value;changed['.runner']=json.dumps(settings);checks.append(denied(lambda:j.decode_config(encode(changed),p,99)))
print(json.dumps(dict(denied=all(checks),count=len(checks))))`);
    assert.equal(out.denied, true);
    assert.equal(out.count, 10);
  },
);
test(
  "listener GO is operation/plan/expiry-bound and cannot replace removal of JIT records",
  { skip: !available },
  () => {
    const out = run(String.raw`
go=dict(name='CityGoJobGo-'+p['operationId'],value=json.dumps(dict(operationId=p['operationId'],jobPlanSha256=sha,action='listen',expiresAt='2026-10-19T08:01:00.000Z')))
ready=r.read_go(pool([go]),p,sha,j,now)
bad=denied(lambda:r.read_go(pool([go,go]),p,sha,j,now))
expired=denied(lambda:r.read_go(pool([go]),p,sha,j,now+datetime.timedelta(seconds=61)))
still_present=bool(j.pool_records(pool(records+[go]),p['operationId']))
print(json.dumps(dict(ready=ready,bad=bad,expired=expired,stillPresent=still_present)))`);
    assert.deepEqual(out, {
      ready: true,
      bad: true,
      expired: true,
      stillPresent: true,
    });
  },
);
test("public job seed pins every executable and contains no JIT or management credential", () => {
  const data = {
    configJson: JSON.stringify({
      schemaVersion: 1,
      operationId: plan.operationId,
      gatewayOperationId: plan.gatewayOperationId,
      hostSnapshotSha256: "a".repeat(64),
      mac: "02:11:22:33:44:55",
      hostIPv4: ["192.0.2.1"],
      productionIPv4: ["198.51.100.1"],
    }),
    jobPlanJson: JSON.stringify(plan) + "\n",
    clientSourceLF: read("private-network-canary.py"),
    offlineHelperSourceLF: read("offline-clone-canary.py"),
    runnerSourceLF: read("job-runner.py"),
    canarySourceLF: read("ephemeral-runner-canary.py"),
    toolsSourceLF: read("prepare-job-toolchain.py"),
    leaseSourceLF: read("job-lease.py"),
    jitSourceLF: read("job-jit.py"),
  };
  for (const [key, pin] of Object.entries(JOB_RUNNER_PINS))
    assert.equal(hash(data[key]), pin);
  const seed = renderJobRunnerSeed(data);
  const payload = JSON.parse(seed.userData.slice("#cloud-config\n".length));
  assert.equal(payload.write_files.length, 9);
  assert.equal(seed.jobPlanSha256, planSha);
  assert.equal(
    payload.runcmd[0].at(-1),
    `RUN_ONE_CI_JOB:${plan.operationId}:${planSha}`,
  );
  assert.ok(seed.userData.length <= 230000);
  assert.ok(!seed.userData.includes(fakeJit().encodedJitConfig));
  for (const key of Object.keys(JOB_RUNNER_PINS))
    assert.throws(
      () => renderJobRunnerSeed({ ...data, [key]: data[key] + "# changed\n" }),
      /source_pin/,
    );
});
test(
  "runner/offline toolchain defaults cannot install, register or reach a network",
  { skip: !available },
  () => {
    for (const name of ["job-runner.py", "offline-job-tools.py"])
      for (const [args, status] of [
        [["--plan"], 0],
        [["--apply"], 2],
      ]) {
        const r = spawnSync(
          python,
          [
            "-I",
            "-B",
            fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
            ...args,
          ],
          { encoding: "utf8", timeout: 10000 },
        );
        assert.equal(r.status, status, r.stderr);
        assert.equal(r.stderr, "");
        assert.equal(JSON.parse(r.stdout).runnerRegistered, false);
      }
  },
);
