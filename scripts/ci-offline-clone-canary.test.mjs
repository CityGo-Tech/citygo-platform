import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/offline-clone-canary.py", import.meta.url),
);
const source = readFileSync(path, "utf8");
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { encoding: "utf8" }).status ===
  0;
const fixture = String.raw`
import base64, contextlib, io, json, stat, sys, types
m = types.ModuleType("citygo_canary_test")
with open(sys.argv[1], encoding="utf-8") as source:
    ACTUAL_SOURCE = source.read().encode("utf-8")
    exec(compile(ACTUAL_SOURCE, sys.argv[1], "exec"), m.__dict__)
OP = "12345678-1234-4234-8234-123456789abc"
PUBLIC = b"synthetic-public-canary-only"
KEY = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
PUB = b"ssh-ed25519 " + base64.b64encode(KEY) + b" synthetic-only\n"
def seed():
    return {"write_files": [{"path":m.SCRIPT,"owner":"root:root","permissions":"0700","encoding":"b64","content":base64.b64encode(PUBLIC).decode()}],
            "runcmd":[["/usr/bin/python3","-I","-B",m.SCRIPT,"--apply","--operation-id",OP,"--acknowledge","RUN_OFFLINE_CANARY:"+OP]]}
def refused(callback, code=None):
    try: callback()
    except m.Refused as error:
        assert code is None or error.code == code, (error.code, code)
        return
    raise AssertionError("Expected refusal")
class FakeGuest:
    def __init__(self):
        self.calls=[];self.publications=[];self.iid="citygo-canary-"+OP;self.fail_docker=False
        self.auth=False;self.seed_value=seed();self.node=b"v24.22.0\n";self.route=[];self.addresses=[{"ifname":"lo","addr_info":[{"local":"127.0.0.1"}]},{"ifname":"eth0","addr_info":[]},{"ifname":"docker0","addr_info":[{"local":"172.17.0.1"}]}]
    def facts(self): return (0,"x86_64",{"ID":"ubuntu","VERSION_ID":"24.04"})
    def seed(self): return self.seed_value
    def info(self,path):
        return types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_size=5) if self.auth and path.endswith("authorized_keys") else None
    def read(self,path,limit):
        return {m.SCRIPT:PUBLIC,"/etc/sudoers.d/90-cloud-init-users":b"# User rules for citygo-bootstrap\nroot ALL=(ALL:ALL) ALL\n",
                "/proc/self/mountinfo":b"1 0 0:1 / / rw - ext4 /dev/sda1 rw\n2 1 0:2 / /run rw - tmpfs tmpfs rw\n",
                "/etc/machine-id":b"a"*32+b"\n","/etc/ssh/ssh_host_ed25519_key.pub":PUB}[path]
    def command(self,args,**unused):
        self.calls.append(args)
        if args == ["/usr/bin/cloud-id"]: return b"nocloud\n"
        if args == ["/usr/bin/cloud-init","query","v1.instance_id"]: return self.iid.encode()+b"\n"
        if args[:2] == ["/usr/bin/passwd","--status"]: return args[2].encode()+b" L synthetic-fields\n"
        if args == ["/usr/sbin/ip","-j","address","show"]: return json.dumps(self.addresses).encode()
        if args[:3] == ["/usr/sbin/ip","-j","-4"]: return json.dumps(self.route).encode()
        if args[:3] == ["/usr/sbin/ip","-j","-6"]: return b"[]"
        if args == ["/usr/local/bin/node","--version"]: return self.node
        if args == ["/usr/local/bin/pnpm","--version"]: return b"10.15.0\n"
        if args == ["/usr/bin/systemctl","is-active","hv-kvp-daemon.service"]: return b"active\n"
        if args == m.DOCKER+["info","--format","{{.OSType}}"]: return b"linux\n"
        if args == m.DOCKER+["container","ls","--all","--quiet"]: return b""
        raise AssertionError(args)
    def workspace_absent(self): self.calls.append(["synthetic-workspace-inventory"])
    def docker_canary(self,operation):
        assert operation == OP;self.calls.append(["synthetic-offline-docker"])
        if self.fail_docker: raise m.Refused("synthetic_docker_failure")
    def publish(self,operation,value):
        assert operation == OP;self.publications.append(value)
def container(identifier="b"*64, image="sha256:"+"a"*64, running=False):
    return [{"Id":identifier,"Name":"/citygo-offline-canary-"+OP,"Image":image,
             "Config":{"Labels":{"citygo.offline-canary":OP},"User":"65534:65534","Entrypoint":["/canary"],"Cmd":None},
             "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":True,"Binds":None,"PortBindings":{},"Privileged":False,"CapDrop":["ALL"],"CapAdd":None,"SecurityOpt":["no-new-privileges"],"Memory":67108864,"MemorySwap":67108864,"NanoCpus":250000000,"PidsLimit":32},"Mounts":[],"State":{"Running":running,"ExitCode":0}}]
`;

function pythonTest(name, body) {
  test(name, { skip: !available }, () => {
    const result = spawnSync(
      python,
      ["-I", "-B", "-c", fixture + "\n" + body, path],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test("source is LF-only, no network client, keys, SSH, jobs or host shutdown", () => {
  assert(!source.includes("\r"));
  for (const pattern of [
    /\b(?:requests|urllib|socket|paramiko|shutil)\b/,
    /(?:shutdown|poweroff|reboot|systemctl["', ]+stop)/,
    /(?:docker|DOCKER).*?(?:prune|--force|--privileged|--volume|--mount|pull["',])/,
    /(?:ssh_host_\w+_key["']|\.env["']|\.credentials["'].*read)/,
  ])
    assert.doesNotMatch(source, pattern);
  assert.match(source, /fcntl\.lockf\(fd, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/);
  assert.match(source, /POOL = "\/var\/lib\/hyperv\/\.kvp_pool_1"/);
  assert.match(source, /os\.O_RDWR \| os\.O_NOFOLLOW/);
  assert.doesNotMatch(source, /ftruncate|os\.replace|os\.rename/);
});

pythonTest(
  "CLI is explicit plan or typed-acknowledged apply only",
  String.raw`
assert m.options(["--plan","--operation-id",OP]) == (False,OP)
assert m.options(["--apply","--operation-id",OP,"--acknowledge","RUN_OFFLINE_CANARY:"+OP]) == (True,OP)
for args in ([],["--apply","--operation-id",OP],["--plan","--operation-id","../other"],["--apply","--operation-id",OP,"--acknowledge","yes"]):
    refused(lambda:m.options(args))
`,
);

pythonTest(
  "default plan observes only and never invokes Docker mutation or KVP",
  String.raw`
guest=FakeGuest();report=m.run(guest,OP,False)
assert report["ok"] and report["code"] == "plan_only_no_changes",report
assert report["dockerOfflineCanaryVerified"] is False and not guest.publications
assert ["synthetic-offline-docker"] not in guest.calls
assert report["ciJobsAuthorized"] is False and report["connectedNetworkIsolationVerified"] is False
assert report["machineId"] == "a"*32 and report["ed25519Fingerprint"].startswith("SHA256:")
`,
);

pythonTest(
  "apply publishes bounded public evidence only after exact identity",
  String.raw`
guest=FakeGuest();report=m.run(guest,OP,True)
assert report["ok"] and report["dockerOfflineCanaryVerified"] is True,report
assert len(guest.publications)==1 and len(guest.publications[0]) <= 1022
assert json.loads(guest.publications[0]) == report
assert report["vmPoweredOff"] is False and report["ciJobsAuthorized"] is False
guest=FakeGuest();guest.iid="citygo-bootstrap-"+OP;report=m.run(guest,OP,True)
assert report["code"]=="instance_identity_mismatch" and not guest.publications
assert ["synthetic-offline-docker"] not in guest.calls
`,
);

pythonTest(
  "failed observed gates and Docker errors cannot become success",
  String.raw`
for change,code in ((lambda g:setattr(g,"auth",True),"bootstrap_authorization_present"),
                    (lambda g:setattr(g,"node",b"v20.0.0"),"toolchain_version_mismatch"),
                    (lambda g:setattr(g,"route",[{"dst":"default","gateway":"192.0.2.1"}]),"default_or_gateway_route_present"),
                    (lambda g:setattr(g,"fail_docker",True),"synthetic_docker_failure")):
    guest=FakeGuest();change(guest);report=m.run(guest,OP,True)
    assert report["ok"] is False and report["code"]==code,report
    assert len(guest.publications)==1 and json.loads(guest.publications[0])["ok"] is False
`,
);

pythonTest(
  "first-boot service race is bounded and only exact read-only probes are retried",
  String.raw`
clock=[0.0];m.time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda amount:clock.__setitem__(0,clock[0]+amount))
class BootGuest(FakeGuest):
    def __init__(self,never=False):super().__init__();self.probes=0;self.never=never
    def command(self,args,**kwargs):
        if args==["/usr/bin/systemctl","is-active","hv-kvp-daemon.service"] or args==m.DOCKER+["info","--format","{{.OSType}}"]:
            self.probes+=1
            assert kwargs.get("timeout",2)<=2
            if self.never or self.probes<=4:return None
        return super().command(args,**kwargs)
guest=BootGuest();m.wait_local_services(guest)
assert guest.probes==6 and clock[0]==2.0
clock[0]=0.0;guest=BootGuest(True);refused(lambda:m.wait_local_services(guest),"local_services_not_ready")
assert clock[0]==30.0 and guest.probes<=60 and not guest.publications
assert ["synthetic-offline-docker"] not in guest.calls
`,
);

pythonTest(
  "seed accepts only the exact public script and argv, never authentication",
  String.raw`
m.validate_seed(seed(),OP,PUBLIC)
actual=seed();actual["write_files"][0]["content"]=base64.b64encode(ACTUAL_SOURCE).decode()
m.validate_seed(actual,OP,ACTUAL_SOURCE)
for mutate in (lambda s:s.update(users=[]),lambda s:s.update(ssh_keys={}),lambda s:s["write_files"][0].update(path="/root/.ssh/authorized_keys"),
               lambda s:s["write_files"][0].update(content=base64.b64encode(b"another script").decode()),lambda s:s.update(runcmd=[["sh","-c","arbitrary"]])):
    value=seed();mutate(value);refused(lambda:m.validate_seed(value,OP,PUBLIC))
refused(lambda:m.unique_json('{"same":1,"same":2}'),"json_duplicate_key")
`,
);

pythonTest(
  "network allows only loopback/docker0 addresses and zero default or gateway routes",
  String.raw`
addresses=FakeGuest().addresses
m.validate_network(addresses,[],[])
m.validate_mounts(b"1 0 0:1 / /run rw - tmpfs tmpfs rw\n2 0 0:2 / /sys/fs/fuse/connections rw - fusectl fusectl rw\n")
for invalid in ([{"ifname":"lo","addr_info":[]},{"ifname":"eth0","addr_info":[{"local":"169.254.1.1"}]}],
                [{"ifname":"lo","addr_info":[]},{"ifname":"eth0","addr_info":[{"local":"fe80::1"}]}]):
    refused(lambda:m.validate_network(invalid,[],[]),"nonlocal_interface_address")
for route in ({"dst":"::/0"},{"dst":"10.0.0.0/8","gateway":"10.0.0.1"}):
    refused(lambda:m.validate_network(addresses,[route],[]),"default_or_gateway_route_present")
for kind in ("9p","virtiofs","drvfs","cifs","nfs4","fuse.sshfs"):
    refused(lambda:m.validate_mounts(("1 0 0:1 / /run rw - tmpfs tmpfs rw\n2 0 0:2 / /mnt rw - "+kind+" host rw\n").encode()),"shared_host_filesystem_present")
`,
);

pythonTest(
  "pool transform appends/overwrites only operation-owned record preserving others",
  String.raw`
key=("CityGoOfflineCanary-"+OP).encode();value=m.report_bytes({"ok":True,"ciJobsAuthorized":False})
other=b"OtherGuestKey".ljust(512,b"\x00")+b"foreign-unchanged".ljust(2048,b"\x00")
output,offset,record=m.update_pool(other,key,value)
assert output[:2560]==other and offset==2560 and len(output)==5120
replacement,offset,record=m.update_pool(output,key,b'{"ok":false}')
assert replacement[:2560]==other and len(replacement)==len(output) and offset==2560
assert replacement[2560+512:].split(b"\x00",1)[0]==b'{"ok":false}'
refused(lambda:m.update_pool(record+record,key,value),"kvp_duplicate_owned_key")
refused(lambda:m.update_pool(b"bad",key,value),"kvp_pool_shape")
refused(lambda:m.update_pool(b"",b"OtherGuestKey",value),"kvp_key_invalid")
refused(lambda:m.update_pool(b"",key,b"x"*2048),"kvp_value_invalid")
refused(lambda:m.report_bytes({"tooLarge":"x"*2048}),"report_too_large")
assert len(m.report_bytes({"x":"a"*1014}))==1022
refused(lambda:m.report_bytes({"x":"a"*1015}),"report_too_large")
`,
);

pythonTest(
  "actual KVP writer uses daemon-compatible record lock and no symlink/truncation",
  String.raw`
other=b"AnotherKey".ljust(512,b"\x00")+b"preserve".ljust(2048,b"\x00")
class FakeOS:
    O_RDWR=2;O_NOFOLLOW=0x20000
    def __init__(self):self.raw=bytearray(other);self.events=[]
    def open(self,path,flags):assert path==m.POOL and flags==self.O_RDWR|self.O_NOFOLLOW;self.events.append("open");return 7
    def fstat(self,fd):return types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=0,st_nlink=1,st_ino=5,st_dev=3)
    def pread(self,fd,bound,offset):return bytes(self.raw[offset:offset+bound])
    def pwrite(self,fd,value,offset):self.events.append("write");self.raw[offset:offset+len(value)]=value;return len(value)
    def fsync(self,fd):self.events.append("sync")
    def close(self,fd):self.events.append("close")
fake=FakeOS();m.os=fake
locks=[];sys.modules["fcntl"]=types.SimpleNamespace(LOCK_EX=2,LOCK_NB=4,lockf=lambda fd,flags:locks.append((fd,flags)))
guest=m.Guest();guest.info=lambda path:types.SimpleNamespace(st_mode=(stat.S_IFREG|0o644) if path==m.POOL else (stat.S_IFDIR|0o755),st_uid=0,st_nlink=1,st_ino=5,st_dev=3)
guest.publish(OP,b'{"ok":true}')
assert locks==[(7,6)] and fake.raw[:2560]==other and fake.events==["open","write","sync","close"]
guest.info=lambda path:types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_uid=0,st_nlink=1,st_ino=5,st_dev=3)
refused(lambda:guest.publish(OP,b'{}'),"kvp_directory_untrusted")
`,
);

pythonTest(
  "container readback rejects mounts, capabilities, user drift and running cleanup",
  String.raw`
m.docker_container(container(),"b"*64,"sha256:"+"a"*64,OP,False)
for mutate in (lambda i:i[0]["Mounts"].append({"Source":"host"}),lambda i:i[0]["Config"].update(User="0"),
               lambda i:i[0]["HostConfig"].update(NetworkMode="bridge"),lambda i:i[0]["HostConfig"].update(Privileged=True),
               lambda i:i[0]["HostConfig"].update(CapAdd=["SYS_ADMIN"]),lambda i:i[0]["Config"]["Labels"].update({"citygo.offline-canary":"other"})):
    value=container();mutate(value);refused(lambda:m.docker_container(value,"b"*64,"sha256:"+"a"*64,OP,False))
refused(lambda:m.docker_container(container(running=True),"b"*64,"sha256:"+"a"*64,OP,False),"container_state_unexpected")
`,
);

pythonTest(
  "native Docker canary uses no pulls or mounts and cleans only exact new IDs",
  String.raw`
class NoFile(io.BytesIO):
    def __exit__(self,*unused):return False
class FakeTemp:
    def __enter__(self):return "/synthetic-run/owned"
    def __exit__(self,*unused):return False
m.tempfile=types.SimpleNamespace(TemporaryDirectory=lambda **unused:FakeTemp())
m.os=types.SimpleNamespace(O_WRONLY=1,O_CREAT=2,O_EXCL=4,O_NOFOLLOW=8,open=lambda *unused:7,fdopen=lambda *unused:NoFile())
class DockerGuest(m.Guest):
    def __init__(self):self.calls=[]
    def read(self,path,limit):return b"\x7fELF\x02\x01"+b"\x00"*12+b"\x3e\x00"+b"synthetic-binary"
    def command(self,args,data=None,**unused):
        self.calls.append(args)
        if args==m.DOCKER+["container","inspect","citygo-offline-canary-"+OP]:return None
        if args==m.DOCKER+["image","ls","--all","--quiet","--no-trunc"]:return b""
        if args[0]=="/usr/bin/gcc":assert "-static" in args;return b""
        verb=args[3]
        if verb=="import":
            assert data and data[257:262]==b"ustar";return ("sha256:"+"a"*64+"\n").encode()
        if verb=="create":return ("b"*64+"\n").encode()
        if args==m.DOCKER+["container","inspect","b"*64]:return json.dumps(container()).encode()
        if args==m.DOCKER+["start","--attach","b"*64]:return m.MARKER
        if args==m.DOCKER+["container","rm","b"*64]:return b"b"*64
        if args==m.DOCKER+["image","inspect","sha256:"+"a"*64]:return json.dumps([{"Id":"sha256:"+"a"*64,"Config":{"Labels":{"citygo.offline-canary":OP}},"RepoTags":[]}]).encode()
        if args==m.DOCKER+["image","rm","sha256:"+"a"*64]:return b"Deleted"
        raise AssertionError(args)
guest=DockerGuest();guest.docker_canary(OP)
create=next(args for args in guest.calls if args[3]=="create")
assert "--pull=never" in create and "--network" in create and "none" in create and "--read-only" in create
assert not any("--force" in args or "pull" in args or "prune" in args or "--mount" in args for args in guest.calls)
assert guest.calls[-1]==m.DOCKER+["image","rm","sha256:"+"a"*64]
class RunningGuest(DockerGuest):
    def __init__(self):super().__init__();self.started=False
    def command(self,args,data=None,**kwargs):
        if args==m.DOCKER+["start","--attach","b"*64]:
            self.calls.append(args);self.started=True;raise m.Refused("command_timeout")
        if self.started and args==m.DOCKER+["container","inspect","b"*64]:
            self.calls.append(args);return json.dumps(container(running=True)).encode()
        return super().command(args,data,**kwargs)
running=RunningGuest();refused(lambda:running.docker_canary(OP),"container_state_unexpected")
assert not any(args[3:5] in (["container","rm"],["image","rm"]) for args in running.calls)
class OldImageGuest(DockerGuest):
    def command(self,args,data=None,**kwargs):
        if args==m.DOCKER+["image","ls","--all","--quiet","--no-trunc"]:
            self.calls.append(args);return ("sha256:"+"a"*64+"\n").encode()
        return super().command(args,data,**kwargs)
old=OldImageGuest();refused(lambda:old.docker_canary(OP),"image_not_new")
assert not any(args[3:5] in (["container","rm"],["image","rm"]) for args in old.calls)
`,
);
