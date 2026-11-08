"""Trusted disposable Linux TEST HOST. Executes the unmodified production Host.

This is never installed or called on a server. Its private DinD daemon has no
outer socket, mounts, network or credentials; candidate containers get no socket.
API and Web behavior is explicitly synthetic, PostgreSQL and OS transports real.
"""
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import ssl
import subprocess
import sys
import tarfile
import threading
import time
import traceback

HERE = Path(__file__).parent
EVIDENCE = Path("/evidence")
ROOT = Path("/root/citygo-controller-test")
HOSTNAME = "web-switch.example.test"
ORIGIN = "https://" + HOSTNAME
PROJECT = "citygo-controller-" + os.urandom(6).hex()
DAEMON = None
NODE, POSTGRES = sys.argv[-2:]


def write(path, raw, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    path.chmod(mode)


def command(argv, *, data=None, timeout=120, check=True):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("fixture command failed " + " ".join(argv[:3]) + ": " + result.stderr.decode(errors="replace")[-2000:])
    return result.stdout


def docker(*argv, **options):
    return command(["/usr/bin/docker", *argv], **options)


def inspect(ident):
    return json.loads(docker("inspect", ident))[0]


def until(check, message, seconds=60):
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() >= deadline:
            raise RuntimeError(message)
        time.sleep(0.1)


API = r"""import http from 'node:http';
let release; const gate = new Promise(r => release=r); let streams=0;
http.createServer(async(q,s)=>{
 if(q.url==='/ready'){s.setHeader('content-type','application/json');return s.end('{"status":"ok"}');}
 if(q.url==='/v1/dashboard'){s.writeHead(401,{'content-type':'application/json','x-citygo-contract-version':'1'});return s.end('{"code":"UNAUTHENTICATED","contractVersion":"1"}');}
 if(q.url==='/hold-stream'){streams++;s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: first\n\n');await gate;s.end('data: last\n\n');return;}
 if(q.url==='/fixture-release'){release();s.end('released');return;}
 if(q.url==='/fixture-counts'){s.setHeader('content-type','application/json');s.end(JSON.stringify({streams}));return;}
 s.writeHead(404);s.end();
}).listen(4000,'0.0.0.0');
"""
WEB = r"""import http from 'node:http';import fs from 'node:fs';
const marker=fs.readFileSync('/fixture/release.txt','utf8').trim();
const server=http.createServer((q,s)=>{
 if(q.url==='/api/ready'&&fs.existsSync('/tmp/not-ready')){s.writeHead(503);s.end('fixture not ready');return;}
 if(q.url.startsWith('/api/')){
  const u=http.request({host:'api',port:4000,path:q.url.slice(4),method:q.method,headers:{...q.headers,connection:'close'}},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s)});
  u.on('error',()=>{if(!s.headersSent)s.writeHead(502);s.end()});q.pipe(u);return;
 }
 s.setHeader('content-type','text/html');s.setHeader('x-fixture-release',marker);s.end('<html>'+marker+'</html>');
});server.listen(3000,'0.0.0.0');process.on('SIGTERM',()=>{console.log('fixture-web-sigterm');server.close(()=>process.exit(0))});
"""


def export_manifest(container, directory):
    """Actual read-only container export, normalized to bounded plain USTAR."""
    raw = docker("cp", container + ":" + directory + "/.", "-")
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for item in archive:
            if item.isdir():
                continue
            assert item.isfile() and not item.linkname and item.size < 1024 * 1024
            name = item.name.removeprefix("./")
            parts = PurePosixPath(name).parts
            assert parts and not name.startswith("/") and ".." not in parts and name not in entries
            entries[name] = archive.extractfile(item).read()
    manifest = {name: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} for name, data in entries.items()}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(entries.items()):
            item = tarfile.TarInfo(name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
    return manifest, output.getvalue()


def main():
    global DAEMON
    assert os.geteuid() == 0 and sys.platform.startswith("linux")
    EVIDENCE.mkdir(mode=0o700)
    ROOT.mkdir(mode=0o700)
    HERE.chmod(0o755)
    for file in HERE.iterdir():
        if file.is_file():
            file.chmod(0o644)
    import web_switch as w
    import web_switch_assets as assets
    assert hasattr(os, "pidfd_open") and hasattr(__import__("signal"), "pidfd_send_signal")
    assert not any(key in os.environ for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "LD_LIBRARY_PATH", "PYTHONPATH"))
    daemon_log = (EVIDENCE / "dockerd.log").open("wb")
    DAEMON = subprocess.Popen(["/usr/local/bin/dind", "/usr/local/bin/dockerd", "--host=unix:///var/run/docker.sock", "--data-root=/var/lib/docker",
                               "--storage-driver=vfs", "--iptables=false", "--ip6tables=false", "--ip-forward=false",
                               "--ip-masq=false", "--bridge=none"], stdout=daemon_log, stderr=subprocess.STDOUT)
    until(lambda: command(["/usr/bin/docker", "info"], check=False) != b"", "inner daemon not ready")
    until(lambda: Path("/run/citygo-images-ready").exists(), "cached image transfer timed out", 180)
    docker("image", "inspect", NODE, POSTGRES)
    # The isolated host starts with no networks in these ranges. Candidates
    # cannot reach the outer Desktop engine or any external provider.
    for network in json.loads(docker("network", "inspect", *docker("network", "ls", "-q").decode().split())):
        for config in network.get("IPAM", {}).get("Config") or []:
            assert config.get("Subnet") not in {"172.30.92.0/24", "172.30.93.0/24"}
    # The outer host has network=none. A normal inner bridge is required for
    # real loopback published ports on engines suppressing internal publishes.
    web_network = docker("network", "create", "--subnet", "172.30.92.0/24", PROJECT + "-web").decode().strip()
    db_network = docker("network", "create", "--internal", "--subnet", "172.30.93.0/24", PROJECT + "-db").decode().strip()
    images, sources = {}, {}
    for slot in ("old", "new"):
        context = ROOT / ("build-" + slot)
        context.mkdir(mode=0o700)
        marker = "synthetic-controller-" + slot
        source = hashlib.sha1((API + WEB + marker).encode()).hexdigest()
        sources[slot] = source
        write(context / "api.mjs", API, 0o644)
        write(context / "web.mjs", WEB, 0o644)
        write(context / "release.txt", marker, 0o644)
        write(context / "public/shared.txt", "immutable shared fixture", 0o644)
        if slot == "new":
            write(context / "public/new.txt", "new immutable fixture", 0o644)
        write(context / ("static/chunks/" + source + ".js"), "// " + marker + "\n", 0o644)
        write(context / "Dockerfile", f"FROM {NODE}\nLABEL org.opencontainers.image.revision={source}\nCOPY . /fixture/\nUSER 1000:1000\n", 0o644)
        tag = PROJECT + ":" + slot
        docker("build", "--pull=false", "--network=none", "-t", tag, str(context), timeout=180)
        images[slot] = json.loads(docker("image", "inspect", tag))[0]["Id"]
    assert images["old"] != images["new"] and sources["old"] != sources["new"]
    def labels(service):
        return ["--label", "com.docker.compose.project=" + PROJECT, "--label", "com.docker.compose.service=" + service]
    def app(service, slot, network, ip, port=None):
        argv = ["run", "-d", "--pull=never", "--name", PROJECT + "-" + service + "-" + slot,
                *labels(service), "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                "--memory=768m", "--memory-swap=768m", "--restart=no", "--tmpfs", "/tmp:rw,size=16m,mode=1777",
                "--network", network, "--ip", ip, "--stop-timeout", "30"]
        if service == "api":
            argv += ["--network-alias", "api", "--env", "TRUSTED_PROXY_CIDRS=172.30.92.10/32,172.30.92.20/32"]
        if port:
            argv += ["--publish", f"127.0.0.1:{port}:3000"]
        ready = "http://127.0.0.1:" + ("4000/ready" if service == "api" else "3000/api/ready")
        argv += ["--health-cmd", f"node -e \"fetch('{ready}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
                 "--health-interval=1s", "--health-timeout=3s", "--health-retries=2", images[slot], "node", "/fixture/" + service + ".mjs"]
        return docker(*argv).decode().strip()
    api = app("api", "old", web_network, "172.30.92.11")
    docker("network", "connect", db_network, api)
    pg = docker("run", "-d", "--pull=never", "--name", PROJECT + "-postgres", *labels("postgres"), "--network", db_network,
                "--memory=1024m", "--memory-swap=1024m", "--env", "POSTGRES_PASSWORD=synthetic-controller-only",
                "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--health-cmd", "pg_isready -U postgres",
                "--health-interval=1s", "--health-timeout=3s", "--health-retries=30", POSTGRES).decode().strip()
    job = docker("run", "-d", "--pull=never", "--name", PROJECT + "-job", *labels("worker"), "--memory=256m",
                 "--network=none", images["old"], "node", "-e", "process.exit(0)").decode().strip()
    docker("wait", job)
    old = app("web", "old", web_network, "172.30.92.10", 3000)
    new = app("web", "new", web_network, "172.30.92.20", 3001)
    containers = {"api": api, "postgres": pg, "job": job, "old": old, "new": new}
    for ident in containers.values():
        details = inspect(ident)
        assert details["HostConfig"]["Privileged"] is False
        assert all(mount.get("Destination") not in {"/var/run/docker.sock", "/run/docker.sock"} for mount in details["Mounts"])
    until(lambda: all(inspect(ident)["State"].get("Health", {}).get("Status") == "healthy" for ident in (api, pg, old, new)), "containers not healthy")
    static_root = Path("/var/lib/citygo/web-assets/_next/static")
    static_root.mkdir(parents=True, mode=0o755)
    static, publics = {}, {}
    for slot, ident in (("old", old), ("new", new)):
        manifest, raw = export_manifest(ident, "/fixture/static")
        static = assets.publish_static_archive(static_root, raw, manifest, previous_manifest=static)["manifest"]
        publics[slot], _ = export_manifest(ident, "/fixture/public")
    assets.verify_public_compatibility(publics["old"], publics["new"])
    # Trust is installed inside the disposable system CA store, never through
    # SSL_CERT_FILE, disabled certificate validation or a Host subclass.
    tls = ROOT / "tls"
    tls.mkdir(mode=0o700)
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Disposable Controller CA",
             "-keyout", str(tls / "ca.key"), "-out", str(tls / "ca.crt")])
    command(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + HOSTNAME,
             "-keyout", str(tls / "leaf.key"), "-out", str(tls / "leaf.csr")])
    write(tls / "extensions", "subjectAltName=DNS:" + HOSTNAME + "\nbasicConstraints=CA:FALSE\n")
    command(["openssl", "x509", "-req", "-days", "1", "-in", str(tls / "leaf.csr"), "-CA", str(tls / "ca.crt"),
             "-CAkey", str(tls / "ca.key"), "-CAcreateserial", "-extfile", str(tls / "extensions"), "-out", str(tls / "leaf.crt")])
    write("/usr/local/share/ca-certificates/citygo-controller-fixture.crt", (tls / "ca.crt").read_bytes(), 0o644)
    command(["update-ca-certificates"])
    cert = Path("/etc/letsencrypt/live") / HOSTNAME
    cert.mkdir(parents=True, mode=0o700)
    write(cert / "fullchain.pem", (tls / "leaf.crt").read_bytes(), 0o644)
    write(cert / "privkey.pem", (tls / "leaf.key").read_bytes())
    ingress = Path("/var/lib/citygo/ingress")
    ingress.mkdir(mode=0o755)
    write(ingress / "traffic-open", b"", 0o644)  # the legacy touch-marker shape
    write(ingress / "web-upstream.conf", w.upstream(3000))
    Path("/var/log/nginx").mkdir(parents=True, exist_ok=True)
    write("/etc/nginx/controller-site.conf", (HERE / "pilot-web-switch.conf.template").read_text().replace("__CITYGO_HOST__", HOSTNAME), 0o644)
    write("/etc/nginx/nginx.conf", "worker_processes 2;\npid /run/nginx.pid;\nerror_log /evidence/nginx.log notice;\nevents { worker_connections 256; }\nhttp { include /etc/nginx/mime.types; include /etc/nginx/controller-site.conf; }\n", 0o644)
    command(["/usr/sbin/nginx", "-t"])
    command(["/usr/sbin/nginx"])
    state, coordination = ROOT / "state", ROOT / "coordination"
    state.mkdir(mode=0o700)
    coordination.mkdir(mode=0o700)
    pin_file = lambda path: {"path": str(path), "sha256": w.digest(Path(path).read_bytes())}
    def pin(ident, source):
        item = inspect(ident)
        return {"id": ident, "image": item["Image"], "source_sha": source, "started_at": item["State"]["StartedAt"],
                "runtime_sha256": w.runtime_fingerprint(item), "project": PROJECT, "service": item["Config"]["Labels"]["com.docker.compose.service"]}
    compatibility = {}
    for slot in ("old", "new"):
        path = ROOT / (slot + "-compatibility.json")
        write(path, w.wire({"version": 1, "source_sha": sources[slot], "backend_sha256": w.digest(API.encode()),
                           "schema_sha256": w.digest(b"synthetic schema: no migration"), "api_contract": "1",
                           "api_internal_url": "http://api:4000", "advertising": "disabled"}))
        compatibility[slot] = pin_file(path)
    asset_pins = {"root": str(static_root)}
    for name, manifest in (("archive", static), ("public_old", publics["old"]), ("public_new", publics["new"])):
        path = ROOT / (name + ".json")
        write(path, w.wire(manifest))
        asset_pins[name] = pin_file(path)
    master = int(Path("/run/nginx.pid").read_text())
    probe_host = w.Host.__new__(w.Host)
    master_process = probe_host.process(master)
    now = int(time.time())
    value = {"version": 1, "purpose": "citygo-staged-web-switch-v1", "operation_id": os.urandom(16).hex(),
             "approved_at": now - 1, "expires_at": now + 3600, "origin": ORIGIN,
             "paths": {"state_dir": str(state), "coordination_dir": str(coordination), "nginx_config": "/etc/nginx/nginx.conf",
                       "upstream_include": str(ingress / "web-upstream.conf"), "traffic_marker": str(ingress / "traffic-open")},
             "files": [pin_file(p) for p in ("/etc/nginx/nginx.conf", "/etc/nginx/mime.types", "/etc/nginx/controller-site.conf", cert / "fullchain.pem", cert / "privkey.pem")],
             "baseline": {"api": pin(api, sources["old"]), "postgres": pin(pg, sources["old"]), "jobs": [pin(job, sources["old"])]},
             "slots": {"old": {"container": pin(old, sources["old"]), "port": 3000, "ip": "172.30.92.10"},
                       "new": {"container": pin(new, sources["new"]), "port": 3001, "ip": "172.30.92.20"}},
             "compatibility": compatibility, "assets": asset_pins,
             "nginx": {"master": {"pid": master, "starttime": master_process["starttime"]}, "workers": []},
             "networks": {"web": web_network, "database": db_network}}
    probe_host.value = value
    until(lambda: len(probe_host.processes()) == 2, "nginx workers not ready")
    value["nginx"]["workers"] = probe_host.processes()
    plan_path = ROOT / "plan.json"
    write(plan_path, w.wire(value))
    plan = w.load_plan(plan_path)
    before = {key: inspect(ident) for key, ident in containers.items()}
    rejected = []
    def refuses(operation, expected):
        try:
            operation()
        except (w.WebSwitchError, w.b.BackupError) as error:
            assert expected in str(error), (expected, str(error))
            rejected.append(expected)
            return
        raise AssertionError("expected controller refusal " + expected)
    initial = w.verify(plan)
    assert initial["status"] == "verified-not-switched" and not (state / w.PENDING).exists()
    assert not (state / w.ACTIVE).exists() and (ingress / "web-upstream.conf").read_bytes() == w.upstream(3000)
    assert {p.name for p in state.iterdir()} == {"web-switch.lock"}
    assert {p.name for p in coordination.iterdir()} == {"maintenance.lock", "worker-admission.lock"}
    for key, ident in containers.items():
        current = inspect(ident)
        assert current["Id"] == before[key]["Id"] and current["Image"] == before[key]["Image"]
        assert current["RestartCount"] == before[key]["RestartCount"] and current["State"]["StartedAt"] == before[key]["State"]["StartedAt"]
        assert w.runtime_fingerprint(current) == w.runtime_fingerprint(before[key])
    assert w.Host(plan).probe() == "127.0.0.1:3000"
    with w.b.lock(coordination):
        refuses(lambda: w.verify(plan), "already-running")
    with w.switch_lock(state):
        refuses(lambda: w.verify(plan), "web-switch-already-running")
    compatibility_path = Path(compatibility["new"]["path"])
    compatibility_original = compatibility_path.read_bytes()
    incompatible = json.loads(compatibility_original)
    incompatible["backend_sha256"] = "f" * 64
    write(compatibility_path, w.wire(incompatible))
    incompatible_plan = json.loads(w.wire(value))
    incompatible_plan["compatibility"]["new"] = pin_file(compatibility_path)
    bad_path = ROOT / "incompatible-plan.json"
    write(bad_path, w.wire(incompatible_plan))
    refuses(lambda: w.verify(w.load_plan(bad_path)), "backend-or-schema-changed")
    write(compatibility_path, compatibility_original)
    assert not (state / w.PENDING).exists() and not (state / w.ACTIVE).exists()
    # Real protected-file and real candidate-readiness refusal, without DI.
    plan_path.chmod(0o666)
    refuses(lambda: w.load_plan(plan_path), "protected-path")
    plan_path.chmod(0o600)
    public_path = Path(asset_pins["public_new"]["path"])
    public_original = public_path.read_bytes()
    write(public_path, b"{}\n")
    refuses(lambda: w.verify(plan), "file-pin-changed")
    write(public_path, public_original)
    assert not (state / w.PENDING).exists() and w.Host(plan).probe() == "127.0.0.1:3000"
    docker("exec", new, "node", "-e", "require('fs').writeFileSync('/tmp/not-ready','fixture')")
    until(lambda: inspect(new)["State"]["Health"]["Status"] == "unhealthy", "negative candidate health not observed")
    refuses(lambda: w.verify(plan), "container-not-ready")
    assert not (state / w.PENDING).exists() and w.Host(plan).probe() == "127.0.0.1:3000"
    docker("exec", new, "node", "-e", "require('fs').unlinkSync('/tmp/not-ready')")
    until(lambda: inspect(new)["State"]["Health"]["Status"] == "healthy", "candidate did not recover")
    old_asset = static_root / next(iter(static))
    original = old_asset.read_bytes()
    write(old_asset, b"corrupt actual archive", 0o444)
    refuses(lambda: w.verify(plan), "assets-unverified")
    write(old_asset, original, 0o444)
    assert not (state / w.PENDING).exists()
    availability_stop = threading.Event()
    availability_samples, availability_errors = [], []
    availability_host = w.Host(plan)
    def availability():
        while not availability_stop.is_set():
            try:
                began = time.monotonic()
                slot = availability_host.probe()
                assert slot in {"127.0.0.1:3000", "127.0.0.1:3001"}
                availability_samples.append({"completed": time.monotonic(), "durationMs": (time.monotonic() - began) * 1000, "slot": slot})
            except Exception as error:
                availability_errors.append(type(error).__name__)
            availability_stop.wait(0.1)
    availability_thread = threading.Thread(target=availability, daemon=True)
    availability_thread.start()
    first, stream_done, stream_body = threading.Event(), threading.Event(), []
    def stream():
        connection = w._TLS(HOSTNAME, timeout=60, context=ssl.create_default_context())
        try:
            connection.request("GET", "/api/hold-stream", headers={"Host": HOSTNAME, "Connection": "close"})
            response = connection.getresponse()
            assert response.status == 200
            while chunk := response.readline():
                stream_body.append(chunk)
                if b"data: first" in chunk:
                    first.set()
        finally:
            connection.close()
            stream_done.set()
    thread = threading.Thread(target=stream, daemon=True)
    thread.start()
    assert first.wait(10), "accepted stream not observed"
    switched = w.switch(plan, allow_switch=True)
    assert switched["phase"] == "switched-awaiting-retirement"
    assert w.Host(plan).probe() == "127.0.0.1:3001" and not stream_done.is_set()
    refuses(lambda: w.switch(plan, allow_switch=True), "web-switch-pending")
    refuses(lambda: w.retire(plan, allow_stop=True, _wait_seconds=0), "old-nginx-workers-still-active")
    assert inspect(old)["State"]["Running"] and not stream_done.is_set()
    assert b"fixture-web-sigterm" not in docker("logs", old)
    connection = http.client.HTTPConnection("127.0.0.1", 3001, timeout=5)
    connection.request("GET", "/api/fixture-release")
    assert connection.getresponse().read() == b"released"
    connection.close()
    assert stream_done.wait(10)
    thread.join()
    assert b"".join(stream_body) == b"data: first\n\ndata: last\n\n"
    receipt = w.retire(plan, allow_stop=True)
    assert receipt["phase"] == "retired" and not (state / w.PENDING).exists()
    assert w.retire(plan, allow_stop=True) == receipt
    assert docker("logs", old).count(b"fixture-web-sigterm") == 1
    after = {key: inspect(ident) for key, ident in containers.items()}
    for key in ("api", "postgres", "job", "new"):
        for field in ("Id", "Image", "RestartCount"):
            assert before[key][field] == after[key][field]
        assert before[key]["State"]["StartedAt"] == after[key]["State"]["StartedAt"]
        assert w.runtime_fingerprint(before[key]) == w.runtime_fingerprint(after[key])
    assert after["old"]["State"]["ExitCode"] == 0 and not after["old"]["State"]["Running"]
    assert next(iter(after["old"]["NetworkSettings"]["Networks"].values()))["IPAddress"] == ""
    for name, entry in static.items():
        connection = w._TLS(HOSTNAME, timeout=5, context=ssl.create_default_context())
        connection.request("GET", "/_next/static/" + name, headers={"Host": HOSTNAME, "Connection": "close"})
        response = connection.getresponse()
        assert response.status == 200 and w.digest(response.read()) == entry["sha256"]
        connection.close()
    availability_stop.set()
    availability_thread.join(timeout=6)
    assert not availability_thread.is_alive() and len(availability_samples) >= 3 and not availability_errors
    gaps = [(later["completed"] - earlier["completed"]) * 1000 for earlier, later in zip(availability_samples, availability_samples[1:])]
    availability_proof = {"sampleCount": len(availability_samples), "errorCount": len(availability_errors),
                          "intervalMs": 100, "maxCompletionGapMs": round(max(gaps), 2),
                          "maxRequestMs": round(max(sample["durationMs"] for sample in availability_samples), 2),
                          "limitation": "sampled fixture availability, not a zero-downtime SLA"}
    write(EVIDENCE / "availability.json", w.wire({"samples": availability_samples, "errors": availability_errors, "proof": availability_proof}))
    for key in ("old", "new"):
        write(EVIDENCE / (key + "-final.json"), w.wire({"Id": after[key]["Id"], "Image": after[key]["Image"],
              "State": after[key]["State"], "NetworkSettings": after[key]["NetworkSettings"]}))
    write(EVIDENCE / "controller-state.json", w.wire(w.inspect_pending(plan)))
    write(EVIDENCE / "receipt.json", w.wire({"version": 1, "productionHost": True, "retired": True,
          "apiIsSynthetic": True, "billingTested": False, "webImages": images, "webSources": sources,
          "acceptedStreamCompleted": True, "baselineUnchanged": True, "rejects": rejected,
          "oldWebSigtermCount": 1, "prematureSigtermObserved": False,
          "verifyAdvisoryLocksOnly": True, "hostInjection": False,
          "availability": availability_proof, "candidateSockets": False,
          "resourceProof": "production Host reads VM /proc; outer 6GiB is a fixture budget, not a 4GiB production load test",
          "hostIsolation": "owned DinD network-none; no outer mounts/socket/ports", "actualSystemCA": True,
          "controllerSha256": w.digest((HERE / "web_switch.py").read_bytes()), "assetFileCount": len(static)}))
    print("Whole production Host controller passed with distinct synthetic Web images", flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        EVIDENCE.mkdir(exist_ok=True)
        write(EVIDENCE / "error.txt", type(error).__name__ + ": " + str(error) + "\n" + traceback.format_exc())
        traceback.print_exc()
        sys.exitcode = 1
    finally:
        if DAEMON is not None:
            DAEMON.terminate()
            try:
                DAEMON.wait(timeout=15)
            except subprocess.TimeoutExpired:
                DAEMON.kill()  # owned disposable daemon cleanup, never retirement
        if getattr(sys, "exitcode", 0):
            raise SystemExit(1)
