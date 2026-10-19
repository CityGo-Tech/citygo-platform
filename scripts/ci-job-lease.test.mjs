import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureJobPlan as plan } from "./ci-job-fixtures.mjs";
import {
  JOB_GATEWAY_PINS,
  renderJobGatewaySeed,
} from "../deploy/ci/render-job-gateway-seed.mjs";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const read = (name) =>
  readFileSync(new URL("../deploy/ci/" + name, import.meta.url), "utf8");
const files = [
  "job-lease.py",
  "job-gateway.py",
  "private-gateway-init.py",
  "private-network-canary.py",
].map((name) =>
  fileURLToPath(new URL("../deploy/ci/" + name, import.meta.url)),
);
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
function input(kind = "ci") {
  const p = plan(kind);
  return {
    configJson: JSON.stringify({
      schemaVersion: 1,
      operationId: p.gatewayOperationId,
      capturedAt: p.createdAt,
      hostSnapshotSha256: "c".repeat(64),
      wanMac: "02:11:22:33:44:55",
      lanMac: "02:11:22:33:44:66",
      expectedWanPrefix: "172.30.16.0/20",
      expectedWanGatewayIPv4: "172.30.16.1",
      hostIPv4: ["172.30.16.1", "192.0.2.10"],
      productionIPv4: ["198.51.100.1"],
      additionalDeniedPrefixes: [],
    }),
    jobPlanJson: JSON.stringify(p) + "\n",
    initializerSourceLF: read("private-gateway-init.py"),
    gatewaySourceLF: read("job-gateway.py"),
    leaseSourceLF: read("job-lease.py"),
    policySourceLF: read("private-gateway-policy.py"),
    offlineHelperSourceLF: read("offline-clone-canary.py"),
    witnessSourceLF: read("private-network-canary.py"),
  };
}
const harness = String.raw`
import base64,datetime,hashlib,importlib.util,json,sys,types
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
l,g,i,w=[load('test_job_'+str(n),p) for n,p in enumerate(sys.argv[1:5])]
p=json.loads(base64.b64decode(sys.argv[5]));utc=datetime.timezone.utc
extra=json.loads(sys.stdin.read())
now=datetime.datetime(2026,10,19,8,0,0,tzinfo=utc)
class Clock:
 def __init__(self):self.wall=now;self.tick=100.0
 def advance(self,seconds):self.wall+=datetime.timedelta(seconds=seconds);self.tick+=seconds
c=Clock()
def lease():return l.Lease(p,p['gatewayOperationId'],'gateway',lambda:c.wall,lambda:c.tick)
def denied(call):
 try:call();return False
 except Exception:return True
`;
function run(code, kind = "ci", extra = []) {
  const r = spawnSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      harness + "\n" + code,
      ...files,
      Buffer.from(JSON.stringify(plan(kind))).toString("base64"),
    ],
    {
      input: JSON.stringify(extra),
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout);
}

test("new job gateway source pins match, old short canary sources/bounds are unchanged", () => {
  const data = input();
  for (const [name, pin] of Object.entries(JOB_GATEWAY_PINS))
    assert.equal(hash(data[name]), pin);
  assert.match(
    data.gatewaySourceLF,
    new RegExp(JOB_GATEWAY_PINS.leaseSourceLF),
  );
  assert.match(
    read("private-network-canary.py"),
    /window_seconds in \(180, 900\)/,
  );
  assert.doesNotMatch(
    data.leaseSourceLF,
    /\b(?:import os|subprocess|open\(|socket|threading)\b/,
  );
});
for (const kind of ["ci", "container"])
  test(`${kind}: public full-job seed binds exact source and unrenewable plan without credentials`, () => {
    const data = input(kind);
    const seed = renderJobGatewaySeed(data);
    assert.equal(seed.jobPlanSha256, hash(data.jobPlanJson));
    const payload = JSON.parse(seed.userData.slice("#cloud-config\n".length));
    assert.equal(payload.write_files.length, 8);
    assert.equal(payload.runcmd.length, 1);
    assert.equal(
      payload.runcmd[0].at(-1),
      `RUN_JOB_GATEWAY:${plan(kind).gatewayOperationId}:${seed.jobPlanSha256}`,
    );
    assert.ok(seed.userData.length < 230000);
    assert.ok(
      payload.write_files.every((record) => record.owner === "root:root"),
    );
    assert.deepEqual(payload.bootcmd, [
      ["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"],
    ]);
  });
test("renderer rejects executable inputs, foreign binding, changed plan shape and source before provisioning", () => {
  assert.throws(
    () => renderJobGatewaySeed({ ...input(), token: "not-a-key" }),
    /fields/,
  );
  const data = input();
  Object.defineProperty(data, "configJson", {
    get() {
      throw Error("must-not-run");
    },
  });
  assert.throws(() => renderJobGatewaySeed(data), /fields/);
  assert.throws(() => renderJobGatewaySeed(new Proxy(input(), {})), /input/);
  for (const key of Object.keys(JOB_GATEWAY_PINS))
    assert.throws(
      () =>
        renderJobGatewaySeed({
          ...input(),
          [key]: input()[key] + "# changed\n",
        }),
      /source_pin/,
    );
  assert.throws(
    () =>
      renderJobGatewaySeed({
        ...input(),
        jobPlanJson: '{"version":1,"version":1}',
      }),
    /plan_canonical/,
  );
  const foreign = input();
  foreign.configJson = foreign.configJson.replace(
    plan().gatewayOperationId,
    plan().operationId,
  );
  assert.throws(() => renderJobGatewaySeed(foreign), /gateway_operation/);
});
for (const kind of ["ci", "container"])
  test(
    `${kind}: Python and host policy agree on bindings and absolute cleanup deadline`,
    { skip: !available },
    () => {
      const out = run(
        String.raw`
raw=json.dumps(p,separators=(',',':')).encode('ascii');sha=hashlib.sha256(raw).hexdigest()
parsed=l.parse_plan(raw,sha,p['gatewayOperationId'],'gateway');a=lease()
print(json.dumps(dict(identical=(parsed==p),remaining=a.remaining(),deadline=a.deadline.isoformat(),client=l.validate_plan(p,p['operationId'],'client')==l.validate_plan(p,p['gatewayOperationId'],'gateway'))))`,
        kind,
      );
      assert.equal(out.identical, true);
      assert.equal(out.client, true);
      assert.equal(out.remaining, kind === "ci" ? 4200 : 3000);
      assert.ok(
        out.deadline.endsWith(
          kind === "ci" ? "09:10:00+00:00" : "08:50:00+00:00",
        ),
      );
    },
  );
test(
  "guest lease refuses duplicates, wrong hashes, changed resources, identities, workflow and any moved deadline",
  { skip: !available },
  () => {
    const out = run(String.raw`
bad=[]
for key,value in [('version',True),('repositoryId',1.5),('guestVcpu',2),('guestMemoryGiB',7),('cleanupSeconds',179),('operationId',p['gatewayOperationId']),('label','foreign'),('jobKey','1-2-3-4'),('workflowRef','CityGo-Tech/citygo-platform/.github/workflows/ci.yml@refs/heads/evil'),('headSha','A'*40),('hardDeadline','2026-10-19T09:13:01.000Z'),('extra',0)]:
 q=dict(p);q[key]=value;bad.append(denied(lambda:l.validate_plan(q,p['gatewayOperationId'],'gateway')))
raw=json.dumps(p,separators=(',',':')).encode('ascii');sha=hashlib.sha256(raw).hexdigest()
duplicate=raw[:-1]+b',"version":1}'
bad += [denied(lambda:l.parse_plan(duplicate,hashlib.sha256(duplicate).hexdigest(),p['gatewayOperationId'],'gateway')),denied(lambda:l.parse_plan(raw,'0'*64,p['gatewayOperationId'],'gateway')),denied(lambda:l.parse_plan(raw,sha,p['operationId'],'gateway'))]
print(json.dumps(dict(allDenied=all(bad),count=len(bad))))`);
    assert.equal(out.allDenied, true);
    assert.equal(out.count, 15);
  },
);
test(
  "UTC/monotonic rollback and either independent deadline can never extend a lease",
  { skip: !available },
  () => {
    const out = run(String.raw`
a=lease();c.advance(1);a.require_live();c.wall-=datetime.timedelta(seconds=1);wall=denied(a.remaining)
c=Clock();a=lease();c.tick-=1;mono=denied(a.remaining)
c=Clock();a=lease();c.tick+=4200;frozen_wall=a.remaining()==0
c=Clock();a=lease();c.wall+=datetime.timedelta(seconds=4200);frozen_mono=a.remaining()==0
c=Clock();c.wall-=datetime.timedelta(seconds=1);future=denied(lease)
c=Clock();c.wall+=datetime.timedelta(seconds=4200);expired=denied(lease)
print(json.dumps(dict(denied=all([wall,mono,frozen_wall,frozen_mono,future,expired]))))`);
    assert.equal(out.denied, true);
  },
);
test(
  "full physical eight-file job seed is checked before projecting unchanged legacy policy records",
  { skip: !available },
  () => {
    const seed = renderJobGatewaySeed(input());
    const payload = seed.userData.slice("#cloud-config\n".length).trim();
    const out = run(
      String.raw`
seed=json.loads(base64.b64decode(extra[0]));sha=extra[1]
class G:
 def __init__(self):self.files={r['path']:base64.b64decode(r['content']) for r in seed['write_files']}
 def read(self,path,maximum):return self.files[path]
guest=G();projection=g.validate_seed(seed,guest,i,p['gatewayOperationId'],sha)
value=json.loads(guest.files[i.CONFIG]);i.validate_seed(projection,value,guest,True,True)
bad=[]
for change in ('extra','command','content','order'):
 s=json.loads(json.dumps(seed))
 if change=='extra':s['write_files'].append(dict(s['write_files'][0]))
 if change=='command':s['runcmd'].append(['/usr/bin/true'])
 if change=='content':s['write_files'][0]['content']=base64.b64encode(b'changed').decode('ascii')
 if change=='order':s['write_files'].reverse()
 bad.append(denied(lambda:g.validate_seed(s,guest,i,p['gatewayOperationId'],sha)))
print(json.dumps(dict(projectedCount=len(projection['write_files']),denied=all(bad))))`,
      "ci",
      [Buffer.from(payload).toString("base64"), seed.jobPlanSha256],
    );
    assert.equal(out.projectedCount, 5);
    assert.equal(out.denied, true);
  },
);
test(
  "job gateway CLI default/refusal cannot read libraries or mutate host/guest",
  { skip: !available },
  () => {
    for (const [args, expected] of [
      [["--plan"], 0],
      [["--apply"], 2],
    ]) {
      const r = spawnSync(python, ["-I", "-B", files[1], ...args], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(r.status, expected, r.stderr);
      assert.equal(JSON.parse(r.stdout).ciJobsAdmitted, false);
      assert.equal(r.stderr, "");
    }
  },
);

const monitorFixture = String.raw`
generated=dict(ipv4Sha256='a'*64,ipv6Sha256='b'*64,ipv4Restore='rules4',ipv6Restore='rules6')
initial=dict(policyApplied=True,ipv4Sha256='a'*64,ipv6Sha256='b'*64)
value=dict(operationId=p['gatewayOperationId'],hostSnapshotSha256='c'*64)
class Native:
 mutation_permitted=True
 def __init__(self):self.forward=1;self.reports=[];self.fail='';self.after_900=False
 def command(self,args):
  if args==['/usr/sbin/sysctl','-w','net.ipv4.ip_forward=0']:self.forward=0;return b''
  if args==['/usr/sbin/sysctl','-n','net.ipv4.ip_forward']:return str(self.forward).encode('ascii')
  if self.fail=='native':raise RuntimeError('synthetic-native-failure')
  if args==['/usr/sbin/iptables-save','-c']:return b'rules4'
  if args==['/usr/sbin/ip6tables-save']:return b'rules6'
  raise RuntimeError('unmocked-command')
 def publish(self,op,raw):
  assert op==p['gatewayOperationId'] and len(raw)<=1022
  if self.fail=='publish':raise RuntimeError('synthetic-publish-failure')
  self.reports.append(json.loads(raw))
  if c.tick-100>900:self.after_900=True
class Link:
 def __init__(self):self.closed=False
 def snapshot(self):return dict(linkControls=2,spoofMacSeen=1,ipv6LanSeen=1,ipv6WanSeen=0,observedClientMac='02:11:22:33:44:55',lanWanUnbridged=True,ipv6ForwardingOff=True)
 def close(self):self.closed=True
def verify(raw,expected):
 if raw!=expected:raise RuntimeError('rules-changed')
initializer=types.SimpleNamespace(observed_policy=lambda *args:(dict(generated),'192.0.2.1','192.0.2.2'),verify_rules=verify,normalize_tables=lambda x:x)
witness=types.SimpleNamespace(counter_metrics=lambda *args:dict(forwardDenied=999999999,sourceSpoofDenied=2,gatewayInputDenied=2,httpsAllowed=999999999,dnsAllowed=999999999),report_bytes=w.report_bytes)
guest=Native();link=Link();active=lease()
def pause(seconds):
 assert 0<=seconds<=2
 c.advance(60)
`;
test(
  "full-job guest witness outlives 900 seconds, keeps policy/counter/L2 checks and closes at original deadline",
  { skip: !available },
  () => {
    const out = run(
      monitorFixture +
        String.raw`
g.observe(guest,initializer,None,witness,value,initial,active,'d'*64,link,pause)
assert all(r['jobPlanSha256']=='d'*64 and r['ciJobsAdmitted'] is False for r in guest.reports)
print(json.dumps(dict(after900=guest.after_900,reports=len(guest.reports),forward=guest.forward,closed=link.closed,seconds=c.tick-100)))`,
    );
    assert.equal(out.after900, true);
    assert.equal(out.seconds, 4200);
    assert.equal(out.reports, 70);
    assert.equal(out.forward, 0);
    assert.equal(out.closed, true);
  },
);
for (const fault of [
  "native",
  "publish",
  "rules",
  "utc-rollback",
  "monotonic-rollback",
])
  test(
    `job witness ${fault}: forwarding closes and packet sockets release before error escapes`,
    { skip: !available },
    () => {
      const changes = {
        native: "guest.fail='native'",
        publish: "guest.fail='publish'",
        rules:
          "initializer.verify_rules=lambda *args:(_ for _ in ()).throw(RuntimeError('rules-changed'))",
        "utc-rollback":
          "def pause(seconds):c.wall-=datetime.timedelta(seconds=1)",
        "monotonic-rollback": "def pause(seconds):c.tick-=1",
      };
      const out = run(
        monitorFixture +
          "\n" +
          changes[fault] +
          String.raw`
failed=denied(lambda:g.observe(guest,initializer,None,witness,value,initial,active,'d'*64,link,pause))
print(json.dumps(dict(failed=failed,forward=guest.forward,closed=link.closed)))`,
      );
      assert.equal(out.failed, true);
      assert.equal(out.forward, 0);
      assert.equal(out.closed, true);
    },
  );
