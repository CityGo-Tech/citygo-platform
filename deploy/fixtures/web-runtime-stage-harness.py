"""Private DinD TEST HOST for the unmodified runtime-stage controller.

Synthetic API/Web and public cached images only. No outer socket, host mount,
provider credentials, public ports or external network is available. This does
not install or activate production ingress and does not exercise real billing.
"""
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
import traceback


HERE = Path(__file__).parent
EVIDENCE = Path("/evidence")
ROOT = Path("/root/citygo-runtime-stage-test")
PROJECT = "citygo-pilot"
ORIGIN = "https://runtime-stage.example.test"
DAEMON = None
NODE, POSTGRES = sys.argv[-2:]
assert sys.argv[1:-2] == ["--wait-for-images"]
TRUSTED_FILES = ("harness.py", "web_switch.py", "backup.py", "web_switch_assets.py",
                 "pilot-web-switch.conf.template", "web_runtime_stage.py", "web_bootstrap.py")
TRACE = []
CHECKPOINT_LOG = []
TRACE_SCOPE = threading.local()
MIB = 1024 * 1024


RUNTIME = r"""import http from 'node:http';import fs from 'node:fs';
const role=process.argv[2];
if(role==='worker'){console.log('synthetic worker done');process.exit(0);}
if(role==='web'){
 const server=http.createServer((q,s)=>{
  if(q.url.startsWith('/api/')){
   const u=http.request({host:'api',port:4000,path:q.url.slice(4),method:q.method,headers:{...q.headers,connection:'close'}},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s)});
   u.on('error',()=>{if(!s.headersSent)s.writeHead(502);s.end('synthetic backend unavailable')});q.pipe(u);return;
  }
  s.setHeader('content-type','text/html');s.end('<html>unchanged synthetic Web</html>');
 });server.listen(3000,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}else if(role==='api'){
 let active=0,signals=0;const admitted={sse:0,post:0},completed={sse:0,post:0};
 const log=(event,extra={})=>console.log(JSON.stringify({event,active,signals,admitted,completed,...extra}));
 const release=()=>new Promise(resolve=>{const tick=()=>fs.existsSync('/tmp/fixture-release')?resolve():setTimeout(tick,25);tick()});
 const server=http.createServer(async(q,s)=>{
  if(q.url==='/ready'){s.setHeader('content-type','application/json');return s.end('{"status":"ok"}');}
  if(q.url==='/v1/dashboard'){s.writeHead(401,{'content-type':'application/json','x-citygo-contract-version':'1'});return s.end('{"code":"UNAUTHENTICATED","contractVersion":"1","retryable":false}');}
  if(q.url==='/fixture/counts'){s.setHeader('content-type','application/json');return s.end(JSON.stringify({active,signals,admitted,completed}));}
  const kind=q.url==='/fixture/hold-sse'&&q.method==='GET'?'sse':q.url==='/fixture/hold-post'&&q.method==='POST'?'post':null;
  if(!kind){s.writeHead(404);return s.end();}
  for await(const chunk of q){};
  active++;admitted[kind]++;log('admitted',{kind});
  if(kind==='sse'){s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: accepted\n\n');}
  else{s.writeHead(200,{'content-type':'application/json'});s.write('{"id":"post",');}
  await release();completed[kind]++;active--;log('completed',{kind});
  s.end(kind==='sse'?'data: completed\n\n':'"completed":true}');
 });
 server.listen(4000,'0.0.0.0');
 process.on('SIGTERM',()=>{signals++;log('sigterm');server.close(()=>{log('exit-clean');process.exit(active===0?0:92)});});
}else{throw new Error('unknown synthetic role');}
"""
HEALTH = r"""const role=process.argv[2];const url=role==='api'?'http://127.0.0.1:4000/ready':'http://127.0.0.1:3000/api/ready';fetch(url).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"""


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def write(path, raw, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    path.chmod(mode)


def command(argv, *, data=None, timeout=120, check=True):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, shell=False, check=False)
    if check and result.returncode:
        raise RuntimeError("fixture command failed " + " ".join(argv[:3]) + ": "
                           + result.stderr.decode(errors="replace")[-2000:])
    return result.stdout


def docker(*argv, **options):
    return command(["/usr/bin/docker", *argv], **options)


def inspect(ident):
    return json.loads(docker("inspect", ident))[0]


def until(predicate, message, seconds=60):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise RuntimeError(message)
        time.sleep(0.1)


def prepare_trusted_code():
    assert HERE == Path("/opt/citygo-controller-fixture") and os.geteuid() == os.getegid() == 0
    assert {path.name for path in HERE.iterdir()} == set(TRUSTED_FILES)
    for parent in HERE.parents:
        meta = parent.lstat()
        assert stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022
    directory = os.open(HERE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    proof = {"version": 1, "received": {}, "adversarial": {}, "normalized": {},
             "normalizedBeforeControllerImport": True, "byteIdentityPreserved": True}
    try:
        os.fchown(directory, 0, 0)
        os.fchmod(directory, 0o755)
        for name in TRUSTED_FILES:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                meta = os.fstat(fd)
                assert stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and 0 < meta.st_size <= 16 * MIB
                raw = os.read(fd, 16 * MIB + 1)
                assert len(raw) == meta.st_size
                sha = digest(raw)
                proof["received"][name] = {"uid": meta.st_uid, "gid": meta.st_gid, "mode": stat.S_IMODE(meta.st_mode)}
                os.fchown(fd, 1001, 1001)
                os.fchmod(fd, 0o666)
                adverse = os.fstat(fd)
                assert (adverse.st_uid, adverse.st_gid, stat.S_IMODE(adverse.st_mode)) == (1001, 1001, 0o666)
                proof["adversarial"][name] = {"uid": 1001, "gid": 1001, "mode": 0o666}
                os.fchown(fd, 0, 0)
                os.fchmod(fd, 0o644)
                os.lseek(fd, 0, os.SEEK_SET)
                after = os.fstat(fd)
                assert digest(os.read(fd, 16 * MIB + 1)) == sha
                assert (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_nlink) == (0, 0, 0o644, 1)
                proof["normalized"][name] = {"uid": 0, "gid": 0, "mode": 0o644, "sha256": sha}
            finally:
                os.close(fd)
    finally:
        os.close(directory)
    write(EVIDENCE / "trusted-code-bootstrap.json", wire(proof))
    return proof


def audit_subprocess(event, args):
    phase = getattr(TRACE_SCOPE, "phase", None)
    if event != "subprocess.Popen" or phase is None:
        return
    executable, argv = args[:2]
    assert type(argv) in (list, tuple) and len(argv) <= 64
    assert all(type(value) is str and len(value) <= 4096 for value in argv)
    assert len(TRACE) < 2048
    # Observe argv only: never environment, stdin, credentials or output.
    TRACE.append({"phase": phase, "argv": list(argv), "executable": str(executable)})
    write(EVIDENCE / "command-trace.json", wire(TRACE))


def mutable(argv):
    assert argv[0] == "/usr/bin/docker", "production controller spawned a foreign executable"
    if argv[1] in {"inspect", "ps", "version", "info"}:
        return False
    if argv[1:3] in (["image", "inspect"], ["network", "inspect"]):
        return False
    if argv[1:] == ["compose", "version", "--short"]:
        return False
    if argv[1] == "compose" and argv[-3:] == ["config", "--format", "json"]:
        return False
    return True


def canonical(node_image, pg_image, secret_paths, release_dir):
    process = {"init": True, "read_only": True, "user": "1000:1000", "restart": "no", "cap_drop": ["ALL"],
               "security_opt": ["no-new-privileges:true"], "pids_limit": 128, "mem_limit": 768 * MIB,
               "memswap_limit": 768 * MIB, "entrypoint": ["node", "scripts/container-runtime.mjs"],
               "working_dir": "/app", "image": node_image,
               "tmpfs": ["/tmp:size=64m,mode=1777"], "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}}
    def health(role):
        return {"test": ["CMD", "node", "scripts/container-health.mjs", role], "interval": "5s", "timeout": "5s",
                "start_period": "15s", "retries": 12}
    api = {**copy.deepcopy(process), "command": ["api"], "stop_grace_period": "330s", "healthcheck": health("api"),
           "environment": {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0", "API_PORT": "4000", "WEB_ORIGIN": ORIGIN,
                           "TRUSTED_PROXY_CIDRS": "172.30.92.10/32", "LLM_PROVIDER": "routerai", "CITYGO_AI_PROFILE": "postpay-native-search-v1"},
           "secrets": [{"source": "api_config", "target": "api.json"}],
           "networks": {"web_api": {"ipv4_address": "172.30.92.11"}, "database": {}}}
    web = {**copy.deepcopy(process), "command": ["web"], "stop_grace_period": "30s", "healthcheck": health("web"),
           "environment": {"PORT": "3000"}, "tmpfs": ["/tmp:size=64m,mode=1777", "/app/apps/web/.next/cache:size=64m,uid=1000,gid=1000"],
           "ports": ["127.0.0.1:3000:3000"], "networks": {"web_api": {"ipv4_address": "172.30.92.10"}},
           "depends_on": {"api": {"condition": "service_healthy"}}}
    ops = {**copy.deepcopy(process), "profiles": ["ops"], "mem_limit": 256 * MIB, "memswap_limit": 256 * MIB,
           "networks": ["database"]}
    worker = {**copy.deepcopy(ops), "command": ["worker"], "stop_grace_period": "90s", "environment": {"CITYGO_MOUNTED_CONFIG": "1"},
              "secrets": [{"source": "worker_config", "target": "worker.json"}]}
    backup = {key: value for key, value in copy.deepcopy(ops).items() if key not in {"working_dir", "entrypoint"}}
    backup.update({"image": pg_image, "user": "postgres", "entrypoint": ["sh", "/opt/citygo/dump.sh"], "stop_grace_period": "30s",
                   "volumes": [{"type": "bind", "source": str(release_dir / "dump.sh"), "target": "/opt/citygo/dump.sh", "read_only": True}],
                   "secrets": ["db_backup_password"]})
    return {"name": PROJECT, "services": {"api": api, "web": web, "worker": worker, "backup": backup},
            "secrets": {name: {"file": str(path)} for name, path in secret_paths.items()},
            "networks": {name: {"external": True, "name": PROJECT + "_" + name} for name in ("web_api", "database")}}


def compose(path, *args):
    return docker("compose", "--env-file", str(path.parent / "empty.env"), "--project-directory", str(path.parent),
                  "--file", str(path), "--profile", "ops", *args)


def snapshot_files(paths):
    result = {}
    for path in paths:
        path = Path(path)
        item = path.lstat()
        value = {"mode": stat.S_IMODE(item.st_mode), "uid": item.st_uid, "gid": item.st_gid,
                 "inode": item.st_ino, "mtime_ns": item.st_mtime_ns}
        value["link" if path.is_symlink() else "sha256"] = os.readlink(path) if path.is_symlink() else digest(path.read_bytes())
        result[str(path)] = value
    return result


def fetch_http(path, port=3000):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def closed_ingress():
    """Real TLS/503 contract on the private host, kept unchanged thereafter."""
    hostname = ORIGIN[8:]
    tls = ROOT / "tls"
    tls.mkdir(mode=0o700)
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Disposable Runtime Stage CA",
             "-keyout", str(tls / "ca.key"), "-out", str(tls / "ca.crt")])
    command(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + hostname,
             "-keyout", str(tls / "leaf.key"), "-out", str(tls / "leaf.csr")])
    write(tls / "extensions", "subjectAltName=DNS:" + hostname + "\nbasicConstraints=CA:FALSE\n")
    command(["openssl", "x509", "-req", "-days", "1", "-in", str(tls / "leaf.csr"), "-CA", str(tls / "ca.crt"),
             "-CAkey", str(tls / "ca.key"), "-CAcreateserial", "-extfile", str(tls / "extensions"), "-out", str(tls / "leaf.crt")])
    write("/usr/local/share/ca-certificates/citygo-runtime-stage-fixture.crt", (tls / "ca.crt").read_bytes(), 0o644)
    command(["update-ca-certificates"])
    key, certificate = tls / "leaf.key", tls / "leaf.crt"
    key.chmod(0o600)
    server = ("server { listen 127.0.0.1:443 ssl; server_name " + hostname + ";\n"
              "ssl_certificate " + str(certificate) + "; ssl_certificate_key " + str(key) + ";\n"
              "location / { default_type application/json; add_header Cache-Control no-store always; "
              "add_header X-CityGo-Contract-Version 1 always; return 503 "
              "'{\"code\":\"SERVICE_UNAVAILABLE\",\"contractVersion\":\"1\",\"retryable\":false}'; } }\n")
    target = Path("/etc/nginx/sites-available/citygo-pilot")
    enabled = Path("/etc/nginx/sites-enabled/citygo-pilot")
    write(target, server, 0o644)
    enabled.parent.mkdir(mode=0o755, parents=True)
    enabled.symlink_to("../sites-available/citygo-pilot")
    config = ("user nginx;\nworker_processes 1;\npid /run/nginx.pid;\nerror_log /evidence/nginx.log notice;\n"
              "events { worker_connections 128; }\nhttp { include " + str(enabled) + "; }\n")
    write("/etc/nginx/nginx.conf", config, 0o644)
    command(["/usr/sbin/nginx", "-t"])
    command(["/usr/sbin/nginx"])
    master = int(Path("/run/nginx.pid").read_text())
    starttime = Path(f"/proc/{master}/stat").read_text().split(")", 1)[1].split()[19]
    until(lambda: bool(Path(f"/proc/{master}/task/{master}/children").read_text().strip()), "Nginx worker not started")
    return [Path("/etc/nginx/nginx.conf"), target, enabled, certificate, key], {
        "pid": master, "starttime": starttime, "children": nginx_children(master)}


def nginx_children(master):
    children = Path(f"/proc/{master}/task/{master}/children").read_text().split()
    return {pid: Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()[19] for pid in children}


def semantic_differences(before, after):
    """Bounded fixture diagnostics; never persist environment values/hashes."""
    differences = []
    missing = object()
    budget = [4096]

    def visit(left, right, path, depth):
        budget[0] -= 1
        assert budget[0] >= 0 and depth <= 24 and len(differences) < 128
        if type(left) is type(right) and left == right:
            return
        if type(left) is dict and type(right) is dict:
            for key in sorted(left.keys() | right.keys()):
                visit(left.get(key, missing), right.get(key, missing),
                      path + "/" + str(key).replace("~", "~0").replace("/", "~1"), depth + 1)
            return
        if type(left) is list and type(right) is list and len(left) == len(right):
            for index, (old, new) in enumerate(zip(left, right)):
                visit(old, new, path + "/" + str(index), depth + 1)
            return
        item = {"path": path, "beforePresent": left is not missing, "afterPresent": right is not missing}
        if path == "/Config/Env" or path.startswith("/Config/Env/"):
            item["environmentValueRedacted"] = True
        else:
            for label, value in (("before", left), ("after", right)):
                if value is missing:
                    continue
                raw = wire(value)
                item[label + "Sha256"] = digest(raw)
                if (path.startswith("/HostConfig/") or path.startswith("/Mounts/")) and len(raw) <= 512:
                    item[label + "SyntheticValue"] = value
        differences.append(item)

    visit(before, after, "", 0)
    return differences


def diagnose_semantics(stage, baseline, operation_id):
    # This is an observer after a failed stage, not a controller operation.
    # Caller clears the trace scope, so these read-only Docker calls cannot be
    # mistaken for an additional controller command or recovery attempt.
    assert getattr(TRACE_SCOPE, "phase", None) is None
    report = {"observerOnly": True, "controllerCommandTraceExcluded": True, "roles": {}}
    for role, project in (("api", PROJECT), ("web", "citygo-web-bootstrap-" + operation_id)):
        found = docker("ps", "--all", "--no-trunc", "--quiet", "--filter", "label=com.docker.compose.project=" + project,
                       "--filter", "label=com.docker.compose.service=" + role, "--filter", "label=" + stage.LABEL + "=" + operation_id,
                       timeout=10).decode().split()
        record = {"candidateCount": len(found)}
        if len(found) == 1:
            item = json.loads(docker("inspect", found[0], timeout=10))[0]
            original = stage._semantic(baseline[role], role)
            actual = stage._semantic(item, role, undo=True)
            record.update({"id": item["Id"], "status": item["State"].get("Status"),
                           "beforeEnvironmentKeys": sorted(original["Config"].get("Env", {})),
                           "afterEnvironmentKeys": sorted(actual["Config"].get("Env", {})),
                           "differences": semantic_differences(original, actual)})
            # Full semantic digests include Env, so keep only non-Env digests
            # here; the controller's owner-pinned full hashes remain private.
            for semantic in (original, actual):
                semantic["Config"].pop("Env", None)
            record.update({"beforeWithoutEnvironmentSha256": digest(wire(original)),
                           "afterWithoutEnvironmentSha256": digest(wire(actual))})
        report["roles"][role] = record
    raw = wire(report)
    assert len(raw) <= 64 * 1024
    write(EVIDENCE / "semantic-diff.json", raw)


class LostReply(BaseException):
    pass


def main():
    global DAEMON
    assert os.geteuid() == os.getegid() == 0 and sys.platform.startswith("linux")
    EVIDENCE.mkdir(mode=0o700)
    ROOT.mkdir(mode=0o700)
    trusted = prepare_trusted_code()
    import web_runtime_stage as stage
    import web_bootstrap as compiler
    import web_switch as switch
    assert not any(key in os.environ for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "LD_LIBRARY_PATH", "PYTHONPATH", "DOCKER_HOST", "DOCKER_CONTEXT"))
    sys.addaudithook(audit_subprocess)
    ingress_paths, nginx_before = closed_ingress()
    daemon_log = (EVIDENCE / "dockerd.log").open("wb")
    DAEMON = subprocess.Popen(["/usr/local/bin/dind", "/usr/local/bin/dockerd", "--host=unix:///var/run/docker.sock",
                               "--data-root=/var/lib/docker", "--storage-driver=vfs", "--iptables=false", "--ip6tables=false",
                               "--ip-forward=false", "--ip-masq=false", "--bridge=none"], stdout=daemon_log, stderr=subprocess.STDOUT)
    until(lambda: bool(command(["/usr/bin/docker", "info"], check=False)), "inner daemon not ready")
    until(lambda: Path("/run/citygo-images-ready").exists(), "cached image transfer timed out", 180)
    docker("image", "inspect", NODE, POSTGRES)
    assert docker("ps", "-aq").strip() == b""
    networks = {"web": {"name": PROJECT + "_web_api"}, "database": {"name": PROJECT + "_database"}}
    networks["web"]["id"] = docker("network", "create", "--subnet", "172.30.92.0/24", networks["web"]["name"]).decode().strip()
    networks["database"]["id"] = docker("network", "create", "--internal", "--subnet", "172.30.93.0/24", networks["database"]["name"]).decode().strip()
    source_sha = hashlib.sha1((RUNTIME + HEALTH).encode()).hexdigest()
    context = ROOT / "build"
    write(context / "scripts/container-runtime.mjs", RUNTIME, 0o644)
    write(context / "scripts/container-health.mjs", HEALTH, 0o644)
    write(context / "Dockerfile", f"FROM {NODE}\nLABEL org.opencontainers.image.revision={source_sha}\nWORKDIR /app\nCOPY scripts /app/scripts\nUSER 1000:1000\n", 0o644)
    docker("build", "--pull=false", "--network=none", "-t", "runtime-stage-node:fixture", str(context), timeout=180)
    node_image = json.loads(docker("image", "inspect", "runtime-stage-node:fixture"))[0]["Id"]
    pg_context = ROOT / "build-pg"
    write(pg_context / "Dockerfile", f"FROM {POSTGRES}\nLABEL org.opencontainers.image.revision={source_sha}\n", 0o644)
    docker("build", "--pull=false", "--network=none", "-t", "runtime-stage-pg:fixture", str(pg_context), timeout=180)
    pg_image = json.loads(docker("image", "inspect", "runtime-stage-pg:fixture"))[0]["Id"]
    pg = docker("run", "-d", "--pull=never", "--name", "citygo-pilot-postgres", "--label", "com.docker.compose.project=" + PROJECT,
                "--label", "com.docker.compose.service=postgres", "--network", networks["database"]["name"], "--restart=unless-stopped",
                "--memory=1024m", "--memory-swap=1024m", "--env", "POSTGRES_PASSWORD=synthetic-runtime-stage-only",
                "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--health-cmd", "pg_isready -h 127.0.0.1 -U postgres",
                "--health-interval=1s", "--health-timeout=3s", "--health-retries=30", pg_image).decode().strip()
    until(lambda: inspect(pg)["State"].get("Health", {}).get("Status") == "healthy", "PG not healthy")
    docker("exec", pg, "psql", "-U", "postgres", "-c", "create table fixture_budget(limit_rub int,spent_rub int,counter int);insert into fixture_budget values(321,123,17)")
    budget_sql = lambda: docker("exec", pg, "psql", "-U", "postgres", "-Atc", "select row_to_json(t) from fixture_budget t")
    database_before = budget_sql()
    release_dir = ROOT / "canonical"
    release_dir.mkdir(mode=0o700)
    secret_paths = {name: ROOT / "secrets" / filename for name, filename in
                    (("api_config", "api.json"), ("worker_config", "worker.json"), ("db_backup_password", "db-backup-password"))}
    for path in secret_paths.values():
        write(path, wire({"synthetic": True, "tariffMultiplier": 10, "minimumRub": 3, "postpay": True,
                          "receipts": True, "phone": True, "giftRub": 500, "limit": 321, "spent": 123, "counter": 17}))
    write(release_dir / "dump.sh", "#!/bin/sh\nexit 0\n", 0o644)
    write(release_dir / "empty.env", b"")
    original = canonical(node_image, pg_image, secret_paths, release_dir)
    canonical_path = release_dir / "compose.json"
    original_raw = wire(original)
    write(canonical_path, original_raw)
    compose(canonical_path, "create", "--no-build", "--pull", "never", "--no-recreate", "api", "worker", "backup")
    ids = {role: compose(canonical_path, "ps", "--all", "--quiet", role).decode().strip()
           for role in ("api", "worker", "backup")}
    for role in ("api", "worker", "backup"):
        docker("start", ids[role])
    for role in ("worker", "backup"):
        assert docker("wait", ids[role]).strip() == b"0"
    until(lambda: inspect(ids["api"])["State"].get("Health", {}).get("Status") == "healthy", "API not healthy")
    compose(canonical_path, "create", "--no-build", "--pull", "never", "--no-recreate", "web")
    ids["web"] = compose(canonical_path, "ps", "--all", "--quiet", "web").decode().strip()
    docker("start", ids["web"])
    until(lambda: inspect(ids["web"])["State"].get("Health", {}).get("Status") == "healthy", "Web not healthy")
    ids["postgres"] = pg
    baseline_details = {role: inspect(ident) for role, ident in ids.items()}
    for item in baseline_details.values():
        assert item["HostConfig"]["Privileged"] is False
        assert all(mount.get("Destination") not in {"/var/run/docker.sock", "/run/docker.sock"} for mount in item["Mounts"])
    def pin(ident, role):
        item = inspect(ident)
        return {"id": ident, "image": item["Image"], "source_sha": source_sha, "started_at": item["State"]["StartedAt"],
                "runtime_sha256": switch.runtime_fingerprint(item), "project": PROJECT, "service": role}
    pin_file = lambda path: {"path": str(path), "sha256": digest(Path(path).read_bytes())}
    guards = ROOT / "guards"
    for filename in ("backup-config.json", "active-release.json", "autodeploy-current.json", "backup-proof.json", "restore-proof.json", "nginx-target.conf"):
        write(guards / filename, wire({"synthetic": True, "unchanged": filename, "adEnabled": False, "autodeployEnabled": False}))
    (guards / "nginx-enabled").symlink_to("nginx-target.conf")
    before_files = snapshot_files([canonical_path, release_dir / "empty.env", release_dir / "dump.sh", *secret_paths.values(),
                                   *guards.iterdir(), *ingress_paths])
    originals = {"compose": pin_file(canonical_path), "env": pin_file(release_dir / "empty.env"),
                 "backup_config": pin_file(guards / "backup-config.json"), "active_release": pin_file(guards / "active-release.json"),
                 "autodeploy_current": pin_file(guards / "autodeploy-current.json")}
    now = int(time.time())
    operation_id = os.urandom(16).hex()
    inventory_hash = digest(wire({role: item["Id"] for role, item in baseline_details.items()}))
    request = {"version": 1, "purpose": compiler.REQUEST_PURPOSE, "operation_id": operation_id,
               "observed_at": now, "expires_at": now + 600, "observation_sha256": digest(b"isolated synthetic observation"),
               "inventory_complete": True, "origin": ORIGIN, "source_sha": source_sha,
               "images": {role: {"id": node_image, "source_sha": source_sha} for role in ("api", "web")},
               "baseline": {"api_id": ids["api"], "web_id": ids["web"], "postgres_id": pg,
                            "inventory_sha256": inventory_hash, "api_restart": {"Name": "no", "MaximumRetryCount": 0},
                            "web_restart": {"Name": "no", "MaximumRetryCount": 0},
                            "postgres_restart": {"Name": "unless-stopped", "MaximumRetryCount": 0}},
               "web_network": networks["web"], "originals": originals,
               "secret_pins": [pin_file(path) for path in secret_paths.values()],
               "gates": {"pending": False, "worker_admission_open": False, "autodeploy_enabled": False}}
    bundle = compiler.compile_draft(original_raw, wire(request), now)
    draft_dir = ROOT / "draft"
    for name, raw in bundle.items():
        write(draft_dir / name, raw)
    plan = {"version": 1, "purpose": "citygo-web-runtime-stage-v1", "operation_id": operation_id, "origin": ORIGIN,
            "observed_at": now, "expires_at": now + 600, "draft_dir": str(draft_dir), "draft_sha256": digest(bundle["draft.json"]),
            "runtime_semantics": {role: stage.digest(stage.wire(stage._semantic(baseline_details[role], role)))
                                  for role in ("api", "web")},
            "baseline": {"api": pin(ids["api"], "api"), "web": pin(ids["web"], "web"), "postgres": pin(pg, "postgres"),
                         "jobs": [pin(ids[role], role) for role in ("worker", "backup")]}, "networks": networks,
            "files": [*originals.values(), *request["secret_pins"], pin_file(release_dir / "dump.sh"),
                      *[pin_file(path) for path in ingress_paths if not path.is_symlink()],
                      pin_file(guards / "backup-proof.json"), pin_file(guards / "restore-proof.json")],
            "attestation": {"drained": True, "backup": pin_file(guards / "backup-proof.json"), "restore": pin_file(guards / "restore-proof.json"), "observed_at": now}}
    plan_path = ROOT / "stage-plan.json"
    write(plan_path, wire(plan))
    capability = {"version": 1, "purpose": "citygo-web-runtime-stage-approval-v1", "operation_id": operation_id,
                  "plan_sha256": digest(wire(plan)), "approved_at": now, "expires_at": now + 600, "allow_stage": True}
    capability_path = ROOT / "stage-cap.json"
    write(capability_path, wire(capability))
    stage.COORDINATION_ROOT.mkdir(mode=0o700, parents=True)
    stage.TRAFFIC_MARKER.parent.mkdir(mode=0o755, parents=True)
    assert not stage.TRAFFIC_MARKER.exists()
    clients, client_errors = {}, []
    accepted = {kind: threading.Event() for kind in ("sse", "post")}
    def client(kind):
        connection = http.client.HTTPConnection("127.0.0.1", 3000, timeout=60)
        try:
            connection.request("GET" if kind == "sse" else "POST", "/api/fixture/hold-" + kind,
                               body=b"{}" if kind == "post" else None, headers={"Connection": "close"})
            response = connection.getresponse()
            first = response.read(1)
            assert response.status == 200 and first
            accepted[kind].set()
            clients[kind] = first + response.read()
        except BaseException as error:
            client_errors.append(type(error).__name__)
        finally:
            connection.close()
    threads = [threading.Thread(target=client, args=(kind,), daemon=True) for kind in ("sse", "post")]
    for thread in threads:
        thread.start()
    assert all(event.wait(20) for event in accepted.values())
    assert json.loads(fetch_http("/api/fixture/counts")[1])["active"] == 2
    log_file = (EVIDENCE / "old-api.log").open("wb")
    log_process = subprocess.Popen(["/usr/bin/docker", "logs", "--follow", ids["api"]], stdout=log_file, stderr=subprocess.STDOUT)
    stage_errors = []
    checkpoints = CHECKPOINT_LOG
    def checkpoint(name):
        checkpoints.append(name)
        write(EVIDENCE / "stage-checkpoints.json", wire(checkpoints))
        if name == "accepted:web-start":
            raise LostReply()
    def execute_stage():
        TRACE_SCOPE.phase = "stage"
        try:
            stage.stage(plan_path, capability_path, allow_stage=True, _checkpoint=checkpoint)
            stage_errors.append("unexpected-successful-stdout")
            write(EVIDENCE / "stage-thread-error.txt", "Unexpected stage return before the deliberate lost-response checkpoint\n")
        except BaseException as error:
            stage_errors.append(error)
            write(EVIDENCE / "stage-thread-error.txt", type(error).__name__ + ": " + str(error) + "\n" + traceback.format_exc())
            if not isinstance(error, LostReply):
                TRACE_SCOPE.phase = None
                try:
                    diagnose_semantics(stage, baseline_details, operation_id)
                except BaseException as diagnostic_error:
                    write(EVIDENCE / "semantic-diff-error.txt", type(diagnostic_error).__name__ + ": "
                          + str(diagnostic_error) + "\n" + traceback.format_exc())
        finally:
            TRACE_SCOPE.phase = None
    runner = threading.Thread(target=execute_stage, daemon=True)
    runner.start()
    def received_sigterm():
        if b'"event":"sigterm"' in (EVIDENCE / "old-api.log").read_bytes():
            return True
        if not runner.is_alive():
            raise RuntimeError("stage stopped before SIGTERM; inspect stage-thread-error.txt and command-trace.json")
        return False
    until(received_sigterm, "old API did not receive graceful SIGTERM")
    assert inspect(ids["api"])["State"]["Running"] is True
    assert all(thread.is_alive() for thread in threads), "accepted requests finished before explicit fixture release"
    docker("exec", ids["api"], "node", "-e", "require('fs').writeFileSync('/tmp/fixture-release','release')")
    for thread in threads:
        thread.join(30)
        assert not thread.is_alive()
    assert client_errors == []
    assert clients["sse"] == b"data: accepted\n\ndata: completed\n\n"
    assert json.loads(clients["post"]) == {"id": "post", "completed": True}
    runner.join(90)
    assert not runner.is_alive() and len(stage_errors) == 1 and isinstance(stage_errors[0], LostReply), stage_errors
    log_process.wait(timeout=15)
    log_file.close()
    lines = [json.loads(line) for line in (EVIDENCE / "old-api.log").read_text().splitlines() if line.startswith("{")]
    assert len([event for event in lines if event["event"] == "admitted"]) == 2
    assert len([event for event in lines if event["event"] == "completed"]) == 2
    sigterm = [event for event in lines if event["event"] == "sigterm"]
    exit_event = [event for event in lines if event["event"] == "exit-clean"]
    assert len(sigterm) == len(exit_event) == 1 and sigterm[0]["active"] == 2
    assert exit_event[0]["active"] == 0 and exit_event[0]["signals"] == 1
    assert exit_event[0]["admitted"] == exit_event[0]["completed"] == {"sse": 1, "post": 1}
    slot_project = "citygo-web-bootstrap-" + operation_id
    def role_id(project, role):
        return docker("ps", "--all", "--no-trunc", "--quiet", "--filter", "label=com.docker.compose.project=" + project,
                      "--filter", "label=com.docker.compose.service=" + role).decode().split()
    assert docker("ps", "--all", "--no-trunc", "--quiet", "--filter", "id=" + ids["api"]).strip() == b""
    assert len(role_id(PROJECT, "api")) == len(role_id(slot_project, "web")) == 1
    new_api, new_web = role_id(PROJECT, "api")[0], role_id(slot_project, "web")[0]
    until(lambda: all(inspect(ident)["State"].get("Health", {}).get("Status") == "healthy" for ident in (new_api, new_web)),
          "prepared topology did not settle")
    pending = stage.inspect_stage(plan_path)
    adopt_cap = {"version": 1, "purpose": "citygo-web-runtime-stage-adopt-v1", "operation_id": operation_id,
                 "plan_sha256": digest(wire(plan)), "approved_at": int(time.time()), "expires_at": int(time.time()) + 600,
                 "pending_sha256": pending["pending_sha256"], "allow_adopt": True}
    adopt_path = ROOT / "adopt-cap.json"
    write(adopt_path, wire(adopt_cap))
    before_adopt = {ident: switch.runtime_fingerprint(inspect(ident)) for ident in (*role_id(PROJECT, "api"), *role_id(slot_project, "web"), ids["web"], pg, ids["worker"], ids["backup"])}
    TRACE_SCOPE.phase = "adopt"
    try:
        receipt = stage.adopt_prepared(plan_path, adopt_path, allow_adopt=True)
    finally:
        TRACE_SCOPE.phase = None
    after_adopt = {ident: switch.runtime_fingerprint(inspect(ident)) for ident in before_adopt}
    assert before_adopt == after_adopt
    assert receipt["status"] == "prepared-closed" and receipt["legacy_barrier_retained"] is True
    assert receipt["traffic_opened"] is False and receipt["nginx_changed"] is False
    for role in ("web", "postgres", "worker", "backup"):
        current = inspect(ids[role])
        old = baseline_details[role]
        assert current["Id"] == old["Id"] and current["Image"] == old["Image"]
        assert current["State"]["StartedAt"] == old["State"]["StartedAt"] and current["RestartCount"] == old["RestartCount"]
        assert switch.runtime_fingerprint(current) == switch.runtime_fingerprint(old)
    assert budget_sql() == database_before and snapshot_files(before_files) == before_files
    assert canonical_path.read_bytes() == original_raw
    assert int(Path("/run/nginx.pid").read_text()) == nginx_before["pid"]
    assert Path(f"/proc/{nginx_before['pid']}/stat").read_text().split(")", 1)[1].split()[19] == nginx_before["starttime"]
    assert nginx_children(nginx_before["pid"]) == nginx_before["children"]
    assert not stage.TRAFFIC_MARKER.exists()
    assert (stage.COORDINATION_ROOT / "operation-pending.json").exists()
    old_env = dict(value.split("=", 1) for value in baseline_details["api"]["Config"]["Env"])
    api_now, web_now = inspect(new_api), inspect(new_web)
    new_env = dict(value.split("=", 1) for value in api_now["Config"]["Env"])
    expected_env = {**old_env, "TRUSTED_PROXY_CIDRS": "172.30.92.10/32,172.30.92.20/32"}
    assert new_env == expected_env and api_now["Image"] == baseline_details["api"]["Image"]
    assert api_now["HostConfig"]["RestartPolicy"] == {"Name": "unless-stopped", "MaximumRetryCount": 0}
    assert web_now["Image"] == baseline_details["web"]["Image"]
    mutating = [entry for entry in TRACE if mutable(entry["argv"])]
    stage_mutations = [entry["argv"] for entry in mutating if entry["phase"] == "stage"]
    assert len(stage_mutations) == 6, stage_mutations
    assert sum(argv[1] == "kill" and "SIGTERM" in argv and argv[-1] == ids["api"] for argv in stage_mutations) == 1
    assert sum(argv[1] == "rm" and argv[-1] == ids["api"] and not any(value in {"--force", "-f"} for value in argv) for argv in stage_mutations) == 1
    assert sum(argv[1] == "compose" and "create" in argv and argv[-1] == "api" for argv in stage_mutations) == 1
    assert sum(argv[1] == "compose" and "create" in argv and argv[-1] == "web" for argv in stage_mutations) == 1
    assert sorted(argv[-1] for argv in stage_mutations if argv[1] == "start") == sorted([new_api, new_web])
    assert [entry for entry in mutating if entry["phase"] == "adopt"] == []
    assert any(entry["phase"] == "adopt" for entry in TRACE)
    write(EVIDENCE / "command-trace.json", wire(TRACE))
    write(EVIDENCE / "stage-checkpoints.json", wire(checkpoints))
    write(EVIDENCE / "stage-receipt.json", wire(receipt))
    summary = {"version": 1, "productionHost": True, "runtimePreparedClosed": True,
               "legacyBarrierRetained": True, "apiOnlyTwoDeltas": True, "canonicalFilesUnchanged": True,
               "baselineUnchanged": True, "secretsAndBudgetUnchanged": True,
               "admittedRequestsCompletedExactlyOnce": True, "adoptNoDockerMutations": True,
               "runtimeChangedOnProductionServer": False, "trustedCodeBootstrap": trusted,
               "realProductApiOrBilling": False, "backupRestoreAttestationSynthetic": True,
               "stageMutationCount": 6, "adoptMutationCount": 0, "api": new_api, "newWeb": new_web,
               "sameApprovedWebImage": node_image, "signalCount": 1, "admitted": {"sse": 1, "post": 1},
               "completed": {"sse": 1, "post": 1}, "sourceSha": source_sha}
    write(EVIDENCE / "receipt.json", wire(summary))
    print("Runtime stage and read-only adoption passed on disposable DinD host", flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        EVIDENCE.mkdir(exist_ok=True)
        write(EVIDENCE / "command-trace.json", wire(TRACE))
        write(EVIDENCE / "stage-checkpoints.json", wire(CHECKPOINT_LOG))
        write(EVIDENCE / "error.txt", type(error).__name__ + ": " + str(error) + "\n" + traceback.format_exc())
        traceback.print_exc()
        sys.exitcode = 1
    finally:
        if DAEMON is not None:
            DAEMON.terminate()
            try:
                DAEMON.wait(timeout=15)
            except subprocess.TimeoutExpired:
                DAEMON.kill()  # owned disposable daemon only, never an API
        if getattr(sys, "exitcode", 0):
            raise SystemExit(1)
