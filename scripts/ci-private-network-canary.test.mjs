import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  renderPrivateClientSeed,
  renderPrivateGatewaySeed,
} from "../deploy/ci/render-private-gateway-seed.mjs";

const files = [
  "private-network-canary.py",
  "private-gateway-init.py",
  "private-gateway-policy.py",
  "offline-clone-canary.py",
].map((x) => fileURLToPath(new URL("../deploy/ci/" + x, import.meta.url)));
const [clientSource, initializer, policySource, helper] = files.map((x) =>
  readFileSync(x, "utf8"),
);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
const config = () => ({
  schemaVersion: 1,
  operationId: "12345678-1234-4234-8234-123456789abc",
  gatewayOperationId: "98765432-1234-4234-8234-123456789abc",
  hostSnapshotSha256: "a".repeat(64),
  mac: "02:11:22:33:44:55",
  hostIPv4: ["172.30.16.1", "10.240.10.20"],
  productionIPv4: ["93.184.216.34"],
});
const fixture = String.raw`
import base64,importlib.util,json,sys
def load(n,p):
 s=importlib.util.spec_from_file_location(n,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=load('test_connected',sys.argv[1]);i=load('test_init',sys.argv[2]);p=load('test_policy',sys.argv[3])
v=dict(schemaVersion=1,operationId='12345678-1234-4234-8234-123456789abc',gatewayOperationId='98765432-1234-4234-8234-123456789abc',hostSnapshotSha256='a'*64,mac='02:11:22:33:44:55',hostIPv4=['172.30.16.1','10.240.10.20'],productionIPv4=['93.184.216.34'])
generated=p.render(dict(schemaVersion=1,operationId=v['gatewayOperationId'],hostSnapshotSha256=v['hostSnapshotSha256'],wanAddressIPv4='172.30.16.10',wanPrefix='172.30.16.0/20',wanGatewayIPv4='172.30.16.1',dhcpServerIPv4='172.30.16.1',hostIPv4=v['hostIPv4'],productionIPv4=v['productionIPv4'],additionalDeniedPrefixes=[]))
initial=dict(policyApplied=True,ipv4Sha256=generated['ipv4Sha256'],ipv6Sha256=generated['ipv6Sha256'])
counter='\n'.join('[2:120] '+x if x.startswith('-A') else x for x in generated['ipv4Restore'].splitlines())+'\n'
class G:
 def __init__(self):self.forward=1;self.mutation_permitted=True;self.reports=[];self.seconds=0;self.bad=False;self.publish_fail=False
 def command(self,args):
  if args==['/usr/sbin/iptables-save','-c']:return (counter.replace(':FORWARD DROP',':FORWARD ACCEPT') if self.bad else counter).encode('ascii')
  if args==['/usr/sbin/ip6tables-save']:return generated['ipv6Restore'].encode('ascii')
  if args==['/usr/sbin/sysctl','-n','net.ipv4.ip_forward']:return str(self.forward).encode('ascii')
  if args==['/usr/sbin/sysctl','-w','net.ipv4.ip_forward=0']:self.forward=0;return b''
  raise RuntimeError('unmocked-command')
 def publish(self,op,raw):
  if self.publish_fail:raise RuntimeError('publish-failed')
  assert op==v['gatewayOperationId'] and len(raw)<=1022;self.reports.append(json.loads(raw))
 def clock(self):return self.seconds
 def pause(self,seconds):assert seconds==2;self.seconds+=60
g=G()
class Client:
 def __init__(self):
  self.calls=[];self.bad=False;self.spoof_fail=False
  self.files={c.SCRIPT:b'public canary',c.HELPER:b'public helper',c.CONFIG:json.dumps(v).encode('ascii')}
 def facts(self):return 0,'x86_64',dict(ID='ubuntu',VERSION_ID='24.04')
 def read(self,path,maximum):return self.files[path]
 def seed(self):return dict(write_files=[dict(path=path,owner='root:root',permissions=mode,encoding='b64',content=base64.b64encode(self.files[path]).decode('ascii')) for path,mode in [(c.SCRIPT,'0700'),(c.HELPER,'0600'),(c.CONFIG,'0600')]],runcmd=[['/usr/bin/python3','-I','-B',c.SCRIPT,'--client','--operation-id',v['operationId'],'--acknowledge','RUN_CONNECTED_CLIENT:'+v['operationId']]])
 def validate_bounds(self):self.calls.append('bounds')
 def resolve_public(self):self.calls.append('dns');return ['93.184.216.34']
 def public_https(self,address):assert address=='93.184.216.34';self.calls.append('https')
 def tcp_connect(self,address,port):self.calls.append(['connect',address,port]);return self.bad
 def send_spoof(self):
  self.calls.append('spoof')
  if self.spoof_fail:raise RuntimeError('synthetic-spoof-failure')
 def command(self,args):
  self.calls.append(args)
  if args==['/usr/bin/cloud-id']:return b'nocloud'
  if args==['/usr/bin/cloud-init','query','v1.instance_id']:return ('citygo-network-client-'+v['operationId']).encode('ascii')
  if args==['/usr/sbin/ip','-j','address','show','dev','ci0']:return json.dumps([dict(address=v['mac'],addr_info=[dict(family='inet',local=c.CLIENT,prefixlen=30)])]).encode('ascii')
  if args==['/usr/sbin/ip','-j','-4','route','show','default']:return json.dumps([dict(dev='ci0',gateway=c.GATEWAY)]).encode('ascii')
  if args==['/usr/sbin/ip','-j','-6','route','show','default']:return b'[]'
  if args in [['/usr/sbin/ip','address',action,c.SPOOF+'/32','dev','ci0'] for action in ['add','del']]:return b''
  raise RuntimeError('unmocked-client-command')
client=Client()
`;
function run(code) {
  const result = spawnSync(
    python,
    ["-I", "-B", "-c", fixture + "\n" + code, ...files.slice(0, 3)],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test(
  "canary source pins agree and default CLI plans perform no machine/network reads",
  { skip: !available },
  () => {
    assert.ok(initializer.includes(hash(clientSource)));
    const planned = spawnSync(
      python,
      ["-I", "-B", files[0], "--plan", "--operation-id", config().operationId],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).ciJobsAdmitted, false);
    const denied = spawnSync(
      python,
      [
        "-I",
        "-B",
        files[0],
        "--client",
        "--operation-id",
        config().operationId,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(denied.status, 2);
    assert.doesNotMatch(
      clientSource,
      /subprocess|shell=True|os\.environ|^\s*(?:import|from)\s+(?:requests|urllib)|http:\/\/|Bearer|ssh_authorized_keys/m,
    );
  },
);

test(
  "native rule counters remain bound to the strict full policy, no hidden rules",
  { skip: !available },
  () => {
    const out = run(String.raw`
m=c.counter_metrics(counter,generated['ipv4Restore'],i.verify_rules,i.normalize_tables);denied=[]
for raw in [counter.replace(':FORWARD DROP',':FORWARD ACCEPT'),counter.replace('[2:120] -A','-A',1),counter.replace('COMMIT','[5:200] -A OUTPUT -j ACCEPT\nCOMMIT',1)]:
 try:c.counter_metrics(raw,generated['ipv4Restore'],i.verify_rules,i.normalize_tables);denied.append(False)
 except Exception:denied.append(True)
print(json.dumps(dict(metrics=m,denied=denied)))`);
    assert.ok(out.metrics.forwardDenied > 0);
    assert.equal(out.metrics.sourceSpoofDenied, 2);
    assert.equal(out.metrics.gatewayInputDenied, 2);
    assert.equal(out.metrics.httpsAllowed, 2);
    assert.ok(out.metrics.dnsAllowed > 0);
    assert.deepEqual(out.denied, [true, true, true]);
  },
);

test(
  "bounded gateway witness publishes flat evidence and closes forwarding at deadline",
  { skip: !available },
  () => {
    const out = run(String.raw`
w=dict(v,operationId=v['gatewayOperationId'])
c.observe_gateway(g,p,w,initial,lambda *a:(generated,'wan','dhcp'),i.verify_rules,i.normalize_tables,g.clock,g.pause)
print(json.dumps(dict(reports=g.reports,forward=g.forward)))`);
    assert.equal(out.forward, 0);
    assert.equal(out.reports.length, 4);
    assert.equal(out.reports.at(-1).stage, "observation_window_closed");
    for (const report of out.reports) {
      assert.equal(report.ciJobsAdmitted, false);
      assert.equal(report.guestIsolationVerified, false);
      assert.ok(Object.values(report).every((x) => typeof x !== "object"));
    }
  },
);

test(
  "rule/readback/publish failures close the witness, never silently continue",
  { skip: !available },
  () => {
    const out = run(String.raw`
out=[]
for failure in ['rules','publish']:
 g=G();g.bad=failure=='rules';g.publish_fail=failure=='publish';failed=False
 try:c.observe_gateway(g,p,dict(v,operationId=v['gatewayOperationId']),initial,lambda *a:(generated,'wan','dhcp'),i.verify_rules,i.normalize_tables,g.clock,g.pause)
 except Exception:failed=True
 out.append(dict(failed=failed,forward=g.forward))
print(json.dumps(out))`);
    assert.deepEqual(out, [
      { failed: true, forward: 0 },
      { failed: true, forward: 0 },
    ]);
  },
);

test(
  "client seed/route/bounds are checked before real probes; spoof address is always removed",
  { skip: !available },
  () => {
    const out = run(String.raw`
r=c.run_client(client,v)
other=Client();other.spoof_fail=True
try:c.run_client(other,v)
except RuntimeError:pass
print(json.dumps(dict(report=r,calls=client.calls,failedLast=other.calls[-1])))`);
    assert.equal(out.report.negativeProbeCount, 4);
    assert.equal(out.report.gatewayProbeCount, 2);
    assert.equal(out.report.ciJobsAdmitted, false);
    assert.ok(out.calls.indexOf("bounds") < out.calls.indexOf("dns"));
    assert.ok(out.calls.indexOf("dns") < out.calls.indexOf("https"));
    assert.deepEqual(out.failedLast, [
      "/usr/sbin/ip",
      "address",
      "del",
      "10.203.0.6/32",
      "dev",
      "ci0",
    ]);
  },
);

test(
  "invalid binding or reachable forbidden endpoint cannot become success",
  { skip: !available },
  () => {
    const out = run(String.raw`
denied=[]
for field,val in [('gatewayOperationId',v['operationId']),('mac','aa:00:00:00:00:01'),('hostIPv4',['10.203.0.2']),('productionIPv4',['1.2.3.4; bad'])]:
 changed=dict(v);changed[field]=val
 try:c.client_config(changed);denied.append(False)
 except c.Refused:denied.append(True)
client.bad=True
try:c.run_client(client,v);denied.append(False)
except c.Refused:denied.append(True)
print(json.dumps(dict(denied=denied,spoof='spoof' in client.calls)))`);
    assert.deepEqual(out.denied, Array(5).fill(true));
    assert.equal(out.spoof, false);
  },
);

test("pure client and opt-in gateway seeds contain only exact pinned public artifacts", () => {
  const data = {
    configJson: JSON.stringify(config()),
    clientSourceLF: clientSource,
    offlineHelperSourceLF: helper,
  };
  const result = renderPrivateClientSeed(data);
  assert.deepEqual(result, renderPrivateClientSeed(data));
  const seed = JSON.parse(result.userData.slice("#cloud-config\n".length));
  assert.equal(seed.write_files.length, 3);
  assert.equal(
    Buffer.from(seed.write_files[0].content, "base64").toString("ascii"),
    clientSource,
  );
  const network = JSON.parse(result.networkConfig).ethernets.client;
  assert.deepEqual(network.addresses, ["10.203.0.2/30"]);
  assert.deepEqual(network.routes, [{ to: "default", via: "10.203.0.1" }]);
  assert.equal(network.dhcp4, false);
  assert.deepEqual(network["link-local"], []);
  const gw = {
    schemaVersion: 1,
    operationId: config().gatewayOperationId,
    capturedAt: "2026-10-19T08:00:00Z",
    hostSnapshotSha256: config().hostSnapshotSha256,
    wanMac: "02:aa:11:22:33:01",
    lanMac: "02:aa:11:22:33:02",
    expectedWanPrefix: "172.30.16.0/20",
    expectedWanGatewayIPv4: "172.30.16.1",
    hostIPv4: config().hostIPv4,
    productionIPv4: config().productionIPv4,
    additionalDeniedPrefixes: [],
  };
  const withWitness = renderPrivateGatewaySeed({
    configJson: JSON.stringify(gw),
    initializerSourceLF: initializer,
    expectedInitializerSha256: hash(initializer),
    policySourceLF: policySource,
    offlineHelperSourceLF: helper,
    witnessSourceLF: clientSource,
  });
  const parsed = JSON.parse(
    withWitness.userData.slice("#cloud-config\n".length),
  );
  assert.equal(parsed.write_files.length, 5);
  assert.equal(parsed.runcmd[0].at(-1), "--observe-canary");
  assert.throws(() =>
    renderPrivateClientSeed({ ...data, clientSourceLF: clientSource + "\n" }),
  );
  assert.throws(() =>
    renderPrivateClientSeed({
      ...data,
      configJson: JSON.stringify({ ...config(), extra: "unsafe" }),
    }),
  );
});

test(
  "private-link frames bracket spoof and valid IPv6 with two controls, no real IPv6 destination",
  { skip: !available },
  () => {
    const out = run(String.raw`
frames=c.link_frames(v['gatewayOperationId'],v['mac'],'02:11:22:33:44:66')
packet=frames[2][14:];udp=packet[40:];pseudo=packet[8:40]+c.struct.pack('!I3xB',len(udp),17)
print(json.dumps(dict(count=len(frames),markers=[x[-2:].decode('ascii') for x in frames],source=frames[1][6:12].hex(),checksum=c.internet_checksum(pseudo+udp),target=str(c.ipaddress.IPv6Address(packet[24:40])),maximum=max(map(len,frames)))))`);
    assert.equal(out.count, 4);
    assert.deepEqual(out.markers, ["C0", "S1", "V6", "C1"]);
    assert.equal(out.source, "024347dead01");
    assert.equal(out.checksum, 0);
    assert.equal(out.target, "2001:db8::1");
    assert.ok(out.maximum < 256);
  },
);

test(
  "trusted link witness distinguishes controls, source-MAC spoof and LAN/WAN IPv6 without dumping payloads",
  { skip: !available },
  () => {
    const out = run(String.raw`
w=c.PacketWitness.__new__(c.PacketWitness);w.prefix=c.link_prefix(v['gatewayOperationId']);w.counts=dict(linkControls=0,spoofMacSeen=0,ipv6LanSeen=0,ipv6WanSeen=0);w.controls=set();w.client_mac=None;w.channels=[]
frames=c.link_frames(v['gatewayOperationId'],v['mac'],'02:11:22:33:44:66')
for x in [frames[0],frames[2],frames[3]]:w.accept('lan0',x)
safe=w.snapshot();w.accept('lan0',frames[1]);w.accept('wan0',frames[2]);unsafe=w.snapshot()
print(json.dumps(dict(safe=safe,unsafe=unsafe)))`);
    assert.equal(out.safe.linkControls, 2);
    assert.equal(out.safe.spoofMacSeen, 0);
    assert.equal(out.safe.ipv6LanSeen, 1);
    assert.equal(out.safe.ipv6WanSeen, 0);
    assert.equal(out.safe.observedClientMac, config().mac);
    assert.equal(out.unsafe.spoofMacSeen, 1);
    assert.equal(out.unsafe.ipv6WanSeen, 1);
  },
);

test(
  "link capture reports fit native KVP bound and close even on initial network refusal",
  { skip: !available },
  () => {
    const out = run(String.raw`
class Link:
 def __init__(self):self.closed=False
 def snapshot(self):return dict(linkControls=2,spoofMacSeen=0,ipv6LanSeen=1,ipv6WanSeen=0,observedClientMac=v['mac'],lanWanUnbridged=True,ipv6ForwardingOff=True)
 def close(self):self.closed=True
l=Link();c.observe_gateway(g,p,dict(v,operationId=v['gatewayOperationId']),initial,lambda *a:(generated,'wan','dhcp'),i.verify_rules,i.normalize_tables,g.clock,g.pause,link=l)
maximum=max(len(c.report_bytes(r)) for r in g.reports)
other=G();second=Link();failed=False
def refuse(*a):raise RuntimeError('fixed synthetic refusal')
try:c.observe_gateway(other,p,v,initial,refuse,i.verify_rules,i.normalize_tables,other.clock,other.pause,link=second)
except RuntimeError:failed=True
print(json.dumps(dict(maximum=maximum,closed=l.closed,failed=failed,refusedClosed=second.closed,forward=other.forward)))`);
    assert.ok(out.maximum <= 1022);
    assert.equal(out.closed, true);
    assert.equal(out.failed, true);
    assert.equal(out.refusedClosed, true);
    assert.equal(out.forward, 0);
  },
);
