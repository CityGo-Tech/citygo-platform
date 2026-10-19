import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const initializer = fileURLToPath(
  new URL("../deploy/ci/private-gateway-init.py", import.meta.url),
);
const policy = fileURLToPath(
  new URL("../deploy/ci/private-gateway-policy.py", import.meta.url),
);
const helper = fileURLToPath(
  new URL("../deploy/ci/offline-clone-canary.py", import.meta.url),
);
const source = readFileSync(initializer, "utf8");
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
const harness = String.raw`
import base64, datetime, importlib.util, json, sys
def load(name, path):
 spec=importlib.util.spec_from_file_location(name,path); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
init=load('test_gateway_init',sys.argv[1]); policy=load('test_gateway_policy',sys.argv[2])
now=datetime.datetime(2026,10,19,8,0,0,tzinfo=datetime.timezone.utc)
value=dict(schemaVersion=1,operationId='12345678-1234-4234-8234-123456789abc',capturedAt='2026-10-19T08:00:00Z',hostSnapshotSha256='a'*64,
wanMac='02:11:22:33:44:55',lanMac='02:11:22:33:44:66',expectedWanPrefix='172.30.16.0/20',expectedWanGatewayIPv4='172.30.16.1',
hostIPv4=['172.30.16.1','10.240.10.20'],productionIPv4=['93.184.216.34'],additionalDeniedPrefixes=[])
class Guest:
 def __init__(self):
  self.calls=[];self.forward=0;self.fail='';self.identity=True;self.masked=True;self.active=False;self.bad_rules=False;self.drift=False;self.existing=False;self.mutation_permitted=False
  self.files={init.SCRIPT:b'public initializer',init.POLICY:b'public policy',init.HELPER:b'public helper',init.CONFIG:json.dumps(value).encode('ascii')}
 def facts(self):return (0 if self.identity else 1000),'x86_64',dict(ID='ubuntu',VERSION_ID='24.04')
 def now(self):return now
 def info(self,path):return object() if self.existing and path==init.INTENT else None
 def is_masked(self,unit):return self.masked
 def record(self,path,report):self.calls.append(['record',path])
 def read(self,path,limit):
  if path.startswith('/run/systemd/netif/leases/'):return b'SERVER_ADDRESS=172.30.16.1\n'
  return self.files[path]
 def seed(self):return dict(write_files=[dict(path=p,owner='root:root',permissions=m,encoding='b64',content=base64.b64encode(self.files[p]).decode('ascii')) for p,m in
 [(init.SCRIPT,'0700'),(init.POLICY,'0600'),(init.HELPER,'0600'),(init.CONFIG,'0600')]],bootcmd=[['/usr/sbin/sysctl','-w','net.ipv4.ip_forward=0']],
 runcmd=[['/usr/bin/python3','-I','-B',init.SCRIPT,'--apply','--operation-id',value['operationId'],'--acknowledge','INITIALIZE_PRIVATE_GATEWAY:'+value['operationId']]])
 def generated(self):return policy.render(dict(schemaVersion=1,operationId=value['operationId'],hostSnapshotSha256=value['hostSnapshotSha256'],wanAddressIPv4='172.30.16.10',wanPrefix=value['expectedWanPrefix'],wanGatewayIPv4=value['expectedWanGatewayIPv4'],dhcpServerIPv4='172.30.16.1',hostIPv4=value['hostIPv4'],productionIPv4=value['productionIPv4'],additionalDeniedPrefixes=[]))
 def command(self,args,data=None,timeout=15,missing_ok=False):
  self.calls.append(args)
  if self.fail and self.fail in args:raise init.Refused('synthetic_command_failure')
  if args[0]=='/usr/bin/cloud-id':return b'nocloud'
  if args[0]=='/usr/bin/cloud-init':return ('citygo-gateway-'+value['operationId']).encode('ascii')
  if args[0]=='/usr/sbin/sysctl':
   if args[1]=='-w' and args[2].startswith('net.ipv4.ip_forward='):self.forward=int(args[2][-1])
   return str(self.forward).encode('ascii') if args[1]=='-n' else b''
  if args[0]=='/usr/bin/systemctl':return (b'active' if self.active else None) if args[1]=='is-active' else b''
  if args[0]=='/usr/sbin/ip':
   if args[2]=='address':
    v=[dict(ifname='wan0',ifindex=2,address=value['wanMac'],addr_info=[dict(family='inet',local='172.30.16.10',prefixlen=20)]),dict(ifname='lan0',ifindex=3,address=value['lanMac'],addr_info=[dict(family='inet',local='10.203.0.1',prefixlen=30)])]
    if self.drift and sum(x==args for x in self.calls)>1:v[0]['address']='02:00:00:00:00:01'
    return json.dumps(v).encode('ascii')
   return json.dumps([dict(dev='wan0',gateway=value['expectedWanGatewayIPv4'])]).encode('ascii')
  if args[0].endswith('iptables-save'):
   result=self.generated()['ipv4Restore']
   if self.bad_rules:result=result.replace(':FORWARD DROP',':FORWARD ACCEPT')
   return result.encode('ascii')
  if args[0].endswith('ip6tables-save'):return self.generated()['ipv6Restore'].encode('ascii')
  if args[0].endswith('tables-restore'):
   if data not in (self.generated()['ipv4Restore'].encode('ascii'),self.generated()['ipv6Restore'].encode('ascii')):raise RuntimeError('unexpected_rules')
   return b''
  if args[0] in ['/usr/sbin/iptables','/usr/sbin/ip6tables'] and args[1:4]==['--wait','5','-t']:
   if (len(args)==8 and args[4]=='filter' and args[5]=='-P' and args[6] in ['INPUT','FORWARD','OUTPUT'] and args[7]=='DROP') or (len(args)==6 and args[4] in ['filter','nat'] and args[5] in ['-F','-X']):return b''
  raise RuntimeError('unmocked_command')
g=Guest()
`;
function run(code) {
  const result = spawnSync(
    python,
    ["-I", "-B", "-c", `${harness}\n${code}`, initializer, policy],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("initializer pins exact public libraries, has no downloads/runner/host shell and explicit one-operation entry", () => {
  for (const [path, pin] of [
    [
      policy,
      "980c8195e5cb8a01fc86997758d380daa919a2d2ca0bed9df28e05a0766083f3",
    ],
    [
      helper,
      "c10465066ce2908fa72d6416811a6bc426c96aef90584b8c0639e9a45a97e0b4",
    ],
  ]) {
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      pin,
    );
    assert.ok(source.includes(pin));
  }
  assert.doesNotMatch(
    source,
    /shell=True|curl|wget|ssh-keygen|config\.sh|run\.sh|docker\.sock(?:["'/]|$)|subprocess\.run|os\.system/,
  );
  assert.match(source, /INITIALIZE_PRIVATE_GATEWAY:/);
  assert.match(source, /O_EXCL \| os.O_NOFOLLOW/);
});

test(
  "default CLI plan and invalid acknowledgement perform no machine or library reads",
  { skip: !available },
  () => {
    const op = "12345678-1234-4234-8234-123456789abc";
    for (const [args, status] of [
      [["--plan", "--operation-id", op], 0],
      [["--apply", "--operation-id", op, "--acknowledge", "wrong"], 2],
    ]) {
      const result = spawnSync(python, ["-I", "-B", initializer, ...args], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, status);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout).ciJobsAdmitted, false);
    }
  },
);

test(
  "pure initialize plan touches no guest and stale/invalid schema refuses before mutation",
  { skip: !available },
  () => {
    const result = run(String.raw`
r=init.initialize(g,policy,value,now,False)
bad=[]
for patch in [dict(capturedAt='2026-10-18T08:00:00Z'),dict(capturedAt='2026-10-19T08:02:00Z'),dict(wanMac=value['lanMac']),dict(expectedWanPrefix='0.0.0.0/0'),dict(schemaVersion=True)]:
 try:init.initialize(g,policy,dict(value,**patch),now,True);bad.append(False)
 except init.Refused:bad.append(True)
print(json.dumps(dict(result=r,calls=g.calls,bad=bad)))`);
    assert.equal(result.result.stage, "plan_only_unverified");
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.bad, Array(5).fill(true));
  },
);

test(
  "identity/seed/existing intent mismatch never mutates or enables rollback on a foreign guest",
  { skip: !available },
  () => {
    const result = run(String.raw`
out=[]
for kind in ['identity','seed','intent']:
 g=Guest()
 if kind=='identity':g.identity=False
 if kind=='seed':g.seed=lambda:dict(write_files=[])
 if kind=='intent':g.existing=True
 try:init.initialize(g,policy,value,now,True);ok=False
 except init.Refused:ok=True
 out.append(dict(denied=ok,permitted=g.mutation_permitted,mutations=[x for x in g.calls if x[0] in ('record','/usr/sbin/sysctl','/usr/bin/systemctl')]))
print(json.dumps(out))`);
    assert.deepEqual(
      result,
      Array(3).fill({ denied: true, permitted: false, mutations: [] }),
    );
  },
);

test(
  "durable intent, Docker/SSH stop, native --test and independent readbacks all precede forwarding",
  { skip: !available },
  () => {
    const result = run(
      "r=init.initialize(g,policy,value,now,True)\nprint(json.dumps(dict(result=r,calls=g.calls,forward=g.forward)))",
    );
    assert.equal(result.result.policyApplied, true);
    assert.equal(result.result.guestIsolationVerified, false);
    assert.equal(result.result.ciJobsAdmitted, false);
    assert.equal(result.forward, 1);
    const calls = result.calls;
    const enabled = calls.findIndex((x) => x.includes("net.ipv4.ip_forward=1"));
    assert.ok(
      calls.findIndex((x) => x[0] === "record") <
        calls.findIndex((x) => x[0] === "/usr/sbin/sysctl"),
    );
    assert.equal(
      calls.filter(
        (x) => x[0].endsWith("tables-restore") && x.includes("--test"),
      ).length,
      2,
    );
    assert.equal(
      calls.filter(
        (x) => x[0].endsWith("tables-restore") && !x.includes("--test"),
      ).length,
      2,
    );
    assert.equal(calls.filter((x) => x[1] === "mask").length, 5);
    assert.ok(
      calls.findIndex((x) => x[0] === "/usr/sbin/iptables-save") < enabled,
    );
    assert.ok(
      calls.findIndex((x) => x[0] === "/usr/sbin/ip6tables-save") < enabled,
    );
    // Two discovery reads before clearing, two installed readbacks before
    // forwarding, and two final readbacks after forwarding is enabled.
    assert.equal(calls.filter((x) => x[0].endsWith("tables-save")).length, 6);
  },
);

test(
  "mask/active-service/rule/readback/network-drift failures close forwarding and never claim success",
  { skip: !available },
  () => {
    const result = run(String.raw`
out=[]
for kind in ['mask','active','rules','drift','restore','readback']:
 g=Guest()
 if kind=='mask':g.masked=False
 if kind=='active':g.active=True
 if kind=='rules':g.bad_rules=True
 if kind=='drift':g.drift=True
 if kind=='restore':g.fail='/usr/sbin/ip6tables-restore'
 if kind=='readback':g.fail='/usr/sbin/ip6tables-save'
 try:init.initialize(g,policy,value,now,True);denied=False
 except Exception:denied=True
 out.append(dict(denied=denied,forward=g.forward,last=g.calls[-1]))
print(json.dumps(out))`);
    for (const resultCase of result) {
      assert.equal(resultCase.denied, true);
      assert.equal(resultCase.forward, 0);
      assert.deepEqual(resultCase.last, [
        "/usr/sbin/sysctl",
        "-w",
        "net.ipv4.ip_forward=0",
      ]);
    }
  },
);

test(
  "native save normalization tolerates counters/options/state order and automatic protocol match, not changed rule order",
  { skip: !available },
  () => {
    const result = run(String.raw`
expected=g.generated()['ipv4Restore']
native=expected.replace('[0:0]','[123:456]').replace('-p tcp --','-p tcp -m tcp --').replace('NEW,ESTABLISHED','ESTABLISHED,NEW').replace('-i lan0 -d 10.0.0.0/8','-d 10.0.0.0/8 -i lan0')
init.verify_rules('# generated\n'+native,expected)
denied=[]
for changed in [expected.replace(':FORWARD DROP',':FORWARD ACCEPT'),expected.replace('-s 10.203.0.2/32','-s 10.203.0.0/24'),expected.replace('-A INPUT -i lan0 -j DROP','-A INPUT -i lan0 -j ACCEPT'),expected.replace('COMMIT','-A OUTPUT -p tcp --dport 22 -j ACCEPT\nCOMMIT',1),expected.replace('-A OUTPUT -o lo -j ACCEPT','-A OUTPUT -o lo -j ACCEPT\n-A OUTPUT -j ACCEPT')]:
 try:init.verify_rules(changed,expected);denied.append(False)
 except init.Refused:denied.append(True)
print(json.dumps(dict(accepted=True,denied=denied)))`);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.denied, Array(5).fill(true));
  },
);

test(
  "extra active tables or malformed rule syntax cannot be hidden by normalization",
  { skip: !available },
  () => {
    const result = run(String.raw`
expected=g.generated()['ipv4Restore'];denied=[]
for extra in ['*raw\n:OUTPUT ACCEPT [0:0]\n-A OUTPUT -j ACCEPT\nCOMMIT\n','*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n','*raw\n:INVENTED-CHAIN ACCEPT [0:0]\nCOMMIT\n','*raw\n:OUTPUT DROP [0:0]\nCOMMIT\n']:
 try:init.verify_rules(expected+extra,expected);denied.append(False)
 except init.Refused:denied.append(True)
init.verify_rules(expected+'*raw\n:OUTPUT ACCEPT [0:0]\nCOMMIT\n',expected)
print(json.dumps(denied))`);
    assert.deepEqual(result, Array(4).fill(true));
  },
);

test(
  "failure evidence preserves only bounded static phase/code, never native messages or commands",
  { skip: !available },
  () => {
    const result = run(String.raw`
g.fail='/usr/sbin/ip6tables-restore'
try:init.initialize(g,policy,value,now,True)
except Exception as error:observed=init.failure_report(value['operationId'],g.phase,error.code)
sanitized=init.failure_report(value['operationId'],'/private/path\nSECRET','Authorization: SECRET')
print(json.dumps(dict(observed=observed,sanitized=sanitized,forward=g.forward)))`);
    assert.equal(result.observed.failurePhase, "test_rules");
    assert.equal(result.observed.failureCode, "synthetic_command_failure");
    assert.equal(result.observed.ciJobsAdmitted, false);
    assert.equal(result.forward, 0);
    assert.equal(result.sanitized.failurePhase, "unknown");
    assert.equal(result.sanitized.failureCode, "native_operation_failed");
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET|Authorization|private\/path/,
    );
  },
);

test(
  "dedicated gateway clears leftover chains only after DROP in both families; final readback stays strict",
  { skip: !available },
  () => {
    const result = run(String.raw`
init.initialize(g,policy,value,now,True)
commands=[x for x in g.calls if x and x[0] in ['/usr/sbin/iptables','/usr/sbin/ip6tables']]
denied=[]
for raw in ['*shell;rm\nCOMMIT\n','*filter\nCOMMIT\n*filter\nCOMMIT\n','x'*262145]:
 try:init.table_names(raw);denied.append(False)
 except init.Refused:denied.append(True)
print(json.dumps(dict(commands=commands,denied=denied,tables=init.table_names('*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n*nat\nCOMMIT\n'))))`);
    const policies = result.commands.slice(0, 6);
    assert.equal(policies.length, 6);
    for (const [index, binary] of ["iptables", "ip6tables"].entries()) {
      for (const [offset, chain] of ["INPUT", "FORWARD", "OUTPUT"].entries()) {
        assert.deepEqual(policies[index * 3 + offset], [
          `/usr/sbin/${binary}`,
          "--wait",
          "5",
          "-t",
          "filter",
          "-P",
          chain,
          "DROP",
        ]);
      }
    }
    assert.ok(
      result.commands
        .slice(6)
        .every(
          (command) =>
            command.length === 6 &&
            ["filter", "nat"].includes(command[4]) &&
            ["-F", "-X"].includes(command[5]),
        ),
    );
    assert.deepEqual(result.denied, [true, true, true]);
    assert.deepEqual(result.tables, ["filter", "nat"]);
  },
);

test(
  "table reset refuses foreign/open guests and cleanup-command failure keeps forwarding closed",
  { skip: !available },
  () => {
    const result = run(String.raw`
denied=[]
for permission,forward in [(False,0),(True,1)]:
 other=Guest();other.mutation_permitted=permission;other.forward=forward
 try:init.clear_owned_gateway_tables(other);refused=False
 except init.Refused:refused=True
 denied.append(dict(refused=refused,writes=[x for x in other.calls if x[0] in ['/usr/sbin/iptables','/usr/sbin/ip6tables']]))
g.fail='-F'
try:init.initialize(g,policy,value,now,True);failed=False
except init.Refused:failed=True
print(json.dumps(dict(denied=denied,failed=failed,forward=g.forward,phase=g.phase,last=g.calls[-1])))`);
    assert.deepEqual(result.denied, [
      { refused: true, writes: [] },
      { refused: true, writes: [] },
    ]);
    assert.equal(result.failed, true);
    assert.equal(result.forward, 0);
    assert.equal(result.phase, "clear_owned_gateway_tables");
    assert.deepEqual(result.last, [
      "/usr/sbin/sysctl",
      "-w",
      "net.ipv4.ip_forward=0",
    ]);
  },
);

test(
  "five-file witness seed is opt-in only and retains exact mode/argv checks",
  { skip: !available },
  () => {
    const result = run(String.raw`
g.files[init.WITNESS]=b'public witness'
seed=g.seed();seed['write_files'].append(dict(path=init.WITNESS,owner='root:root',permissions='0700',encoding='b64',content=base64.b64encode(g.files[init.WITNESS]).decode('ascii')))
seed['runcmd'][0].append('--observe-canary')
init.validate_seed(seed,value,g,True);denied=[]
try:init.validate_seed(seed,value,g,False);denied.append(False)
except init.Refused:denied.append(True)
seed['write_files'][-1]['permissions']='0600'
try:init.validate_seed(seed,value,g,True);denied.append(False)
except init.Refused:denied.append(True)
seed['write_files'][-1]['permissions']='0700';seed['runcmd'][0][-1]='--other-mode'
try:init.validate_seed(seed,value,g,True);denied.append(False)
except init.Refused:denied.append(True)
print(json.dumps(dict(denied=denied,calls=g.calls)))`);
    assert.deepEqual(result.denied, [true, true, true]);
    assert.deepEqual(result.calls, []);
  },
);
