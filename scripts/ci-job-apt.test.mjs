import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const path = fileURLToPath(
  new URL("../deploy/ci/job-apt-https.py", import.meta.url),
);
const source = readFileSync(path, "utf8");
const python = process.platform === "win32" ? "python" : "python3";
const available =
  spawnSync(python, ["-I", "-B", "--version"], { timeout: 10000 }).status === 0;
const fixture = String.raw`
import importlib.util,io,json,stat,sys,types
s=importlib.util.spec_from_file_location('test_job_apt',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
op='12345678-1234-4234-8234-123456789abc'
raw=b'# Ubuntu source\nTypes: deb\nURIs: http://ru.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
def denied(call):
 try:call();return False
 except Exception:return True
class FS:
 def __init__(self):self.files={m.SOURCE:raw};self.next=10;self.fds={};self.events=[];self.root=True;self.identity=True;self.change=False;self.source_reads=0
 def open(self,path,flags,mode=None):
  self.events.append(('open',path,flags))
  if flags&8 and path in self.files:raise FileExistsError('synthetic-existing')
  if flags&2:self.files[path]=b''
  if path not in self.files:raise FileNotFoundError('synthetic-missing')
  self.next+=1;self.fds[self.next]=path;return self.next
 def fstat(self,fd):return types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=0,st_nlink=1,st_dev=1,st_ino=1,st_mtime_ns=1)
 def read(self,fd,size):
  path=self.fds[fd]
  if path==m.SOURCE:
   self.source_reads+=1
   if self.change and self.source_reads==2:self.files[path]+=b'# concurrent\n'
  return self.files[path][:size]
 def close(self,fd):self.fds.pop(fd,None)
 def fdopen(self,fd,mode):
  fs=self
  class B(io.BytesIO):
   def fileno(self):return fd
   def flush(self):fs.files[fs.fds[fd]]=self.getvalue();fs.events.append(('flush',fs.fds[fd]))
   def close(self):
    if not self.closed:self.flush();fs.close(fd)
    super().close()
  return B()
 def replace(self,a,b):self.events.append(('replace',a,b));self.files[b]=self.files.pop(a)
 def command(self,args,**kw):
  self.events.append(('command',args))
  if args==['/usr/bin/cloud-id']:return types.SimpleNamespace(returncode=0,stdout=b'nocloud' if self.identity else b'other')
  if args==['/usr/bin/cloud-init','query','v1.instance_id']:return types.SimpleNamespace(returncode=0,stdout=('citygo-runner-canary-'+op).encode('ascii'))
  raise RuntimeError('unmocked-command')
 def install(self):
  m.os=types.SimpleNamespace(O_RDONLY=1,O_WRONLY=2,O_CREAT=4,O_EXCL=8,O_NOFOLLOW=16,open=self.open,read=self.read,close=self.close,fstat=self.fstat,fdopen=self.fdopen,fsync=lambda fd:self.events.append(('fsync',fd)),replace=self.replace,lstat=lambda path:types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0),path=types.SimpleNamespace(lexists=lambda path:path in self.files),geteuid=lambda:0 if self.root else 1000)
  m.sys=types.SimpleNamespace(platform='linux');m.subprocess.run=self.command
f=FS()
`;
function run(code) {
  const r = spawnSync(python, ["-I", "-B", "-c", fixture + "\n" + code, path], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout);
}
test("guest APT preparer has no package install/download, key addition, TLS bypass or host file namespace", () => {
  assert.doesNotMatch(
    source,
    /curl|wget|apt-key|trusted=yes|Verify-Peer.*false|shell=True|https?:\/\/[^"'\s]*password|D:\\|C:\\/,
  );
  assert.match(source, /O_EXCL \| os.O_NOFOLLOW/);
  assert.match(source, /citygo-runner-canary-/);
});
test(
  "Ubuntu HTTP/region mirrors become official HTTPS; signatures, suites, components and comments stay exact",
  { skip: !available },
  () => {
    const out = run(String.raw`
new=m.rewrite(raw)
expected=raw.replace(b'http://ru.archive.ubuntu.com',b'https://archive.ubuntu.com').replace(b'http://security.ubuntu.com',b'https://security.ubuntu.com')
print(json.dumps(dict(exact=new==expected,idempotent=m.rewrite(new)==new)))`);
    assert.deepEqual(out, { exact: true, idempotent: true });
  },
);
test(
  "unexpected origin, credentials, suites, keys, duplicate fields and insecure options refuse with static errors",
  { skip: !available },
  () => {
    const out = run(String.raw`
checks=[];safe=True
changes=[(b'ru.archive.ubuntu.com',b'foreign.example'),(b'http://ru.',b'http://user:VERY_SECRET@ru.'),(b'ru.archive.ubuntu.com',b'ru.archive.ubuntu.com:VERY_SECRET'),(b'/ubuntu/',b'/other/'),(b'noble-updates',b'future-release'),(b'ubuntu-archive-keyring.gpg',b'foreign-key.gpg'),(b'Types: deb',b'Trusted: yes\nTypes: deb'),(b'Types: deb',b'Types: deb\nTypes: deb'),(b'URIs: ',b' URIs: '),(b'Signed-By: ',b'Unknown: yes\nSigned-By: ')]
for a,b in changes:
 try:m.rewrite(raw.replace(a,b));checks.append(False)
 except Exception as e:checks.append(True);safe=safe and 'VERY_SECRET' not in str(e)
checks.append(denied(lambda:m.rewrite(raw.replace(b'\n',b'\r\n'))))
print(json.dumps(dict(denied=all(checks),safe=safe,count=len(checks))))`);
    assert.equal(out.denied, true);
    assert.equal(out.safe, true);
    assert.equal(out.count, 11);
  },
);
test(
  "mocked apply binds fresh guest, flushes intent before atomic replace, verifies readback and refuses replay",
  { skip: !available },
  () => {
    const out = run(String.raw`
f.install();ok=m.prepare(op)
intent=m.ROOT+'/apt-https-intent.json';result=m.ROOT+'/apt-https-result.json'
before=next(n for n,e in enumerate(f.events) if e==('flush',intent));replace=next(n for n,e in enumerate(f.events) if e[0]=='replace')
replay=denied(lambda:m.prepare(op))
print(json.dumps(dict(ok=ok,exact=f.files[m.SOURCE]==m.rewrite(raw),ordered=before<replace,result=json.loads(f.files[result])['stage'],replay=replay,replaces=sum(e[0]=='replace' for e in f.events))))`);
    assert.deepEqual(out, {
      ok: true,
      exact: true,
      ordered: true,
      result: "https_sources_verified",
      replay: true,
      replaces: 1,
    });
  },
);
test(
  "concurrent source changes and preexisting partial output never overwrite or report successful preparation",
  { skip: !available },
  () => {
    const out = run(String.raw`
f.change=True;f.install();changed=denied(lambda:m.prepare(op));noresult=m.ROOT+'/apt-https-result.json' not in f.files;noreplace=not any(e[0]=='replace' for e in f.events)
f=FS();f.files[m.PART]=b'old-part';f.install();partial=denied(lambda:m.prepare(op));nointent=m.ROOT+'/apt-https-intent.json' not in f.files
print(json.dumps(dict(denied=changed and partial,noresult=noresult,noreplace=noreplace,nointent=nointent)))`);
    assert.deepEqual(out, {
      denied: true,
      noresult: true,
      noreplace: true,
      nointent: true,
    });
  },
);
test(
  "wrong identity or nonroot scope cannot write any source or record",
  { skip: !available },
  () => {
    const out = run(String.raw`
f.identity=False;f.install();identity=denied(lambda:m.prepare(op));identity_unchanged=len(f.files)==1
f=FS();f.root=False;f.install();root=denied(lambda:m.prepare(op));root_unchanged=len(f.files)==1 and not f.events
print(json.dumps(dict(identity=identity and identity_unchanged,root=root and root_unchanged)))`);
    assert.deepEqual(out, { identity: true, root: true });
  },
);
test(
  "APT CLI default and malformed acknowledgement are pure",
  { skip: !available },
  () => {
    for (const [args, status] of [
      [["--plan"], 0],
      [["--apply"], 2],
    ]) {
      const r = spawnSync(python, ["-I", "-B", path, ...args], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(r.status, status, r.stderr);
      assert.equal(r.stderr, "");
      assert.equal(JSON.parse(r.stdout).guestChanged, false);
    }
  },
);
