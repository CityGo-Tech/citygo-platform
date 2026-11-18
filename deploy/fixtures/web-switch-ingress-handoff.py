"""Exercise CityGo's real Nginx templates on disposable loopback backends."""
import http.client
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass, field
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import monotonic, sleep
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backup"))
from backup import sync_directory
from web_bootstrap_ingress_transaction import Epoch, transition

HOST = "citygo-ingress.example.test"
LOOPBACK = "127.0.0.1"
TEMPLATES = Path(__file__).resolve().parents[1] / "nginx"
ASSET = "/_next/static/chunks/fixture.txt"
SSE_HEAD, SSE_TAIL = b"data: first\n\n", b"data: last\n\n"
POST_BODY = b"one fixture submission"


@dataclass
class FixtureSlot:
    port: int = 0
    release: Event = field(default_factory=Event)
    post_seen: Event = field(default_factory=Event)
    streams: int = 0
    posts: list = field(default_factory=list)


@contextmanager
def slot(label):
    fixture = FixtureSlot()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def send(self, status, body, content_type="text/plain"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/api/stream":
                fixture.streams += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(SSE_HEAD + SSE_TAIL)))
                self.end_headers()
                self.wfile.write(SSE_HEAD)
                self.wfile.flush()
                if fixture.release.wait(12):
                    self.wfile.write(SSE_TAIL)
            elif self.path in ("/", "/api/ready"):
                self.send(200, label)
            else:
                self.send(404, b"fixture route missing")

        def do_POST(self):
            assert self.path == "/api/submit"
            fixture.posts.append(self.rfile.read(int(self.headers["Content-Length"])))
            fixture.post_seen.set()
            ready = fixture.release.wait(12)
            self.send(200 if ready else 504, label)

    with ThreadingHTTPServer((LOOPBACK, 0), Handler) as server:
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        worker.start()
        try:
            fixture.port = server.server_port
            yield fixture
        finally:
            fixture.release.set()
            server.shutdown()
            worker.join(timeout=3)


def replace_file(path, raw):
    staged = path.with_name(path.name + ".next-" + uuid4().hex)
    with staged.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    staged.replace(path)
    sync_directory(path.parent)
    assert path.is_file() and not path.is_symlink() and path.read_bytes() == raw


def replace_link(path, target):
    staged = path.with_name(path.name + ".next-" + uuid4().hex)
    staged.symlink_to(target)
    staged.replace(path)
    sync_directory(path.parent)
    assert path.is_symlink() and os.readlink(path) == target


def wait_for(predicate, message):
    deadline = monotonic() + 6
    while not predicate():
        if monotonic() >= deadline:
            raise AssertionError(message)
        sleep(0.025)


def rehearse_ingress(root, http_port, tls_port, a, b):
    assert re.fullmatch(r"/[a-zA-Z0-9._/-]+", str(root)), "unsafe path for generated Nginx config"
    paths = {"/etc/letsencrypt": root / "certificates",
             "/var/lib/letsencrypt": root / "acme",
             "/var/lib/citygo": root / "citygo",
             "/var/log/nginx": root / "logs"}
    for path in (*paths.values(), root / "sites-available", root / "sites-enabled"):
        path.mkdir()
    cert = paths["/etc/letsencrypt"] / "live" / HOST
    cert.mkdir(parents=True)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=" + HOST, "-addext", "subjectAltName=DNS:" + HOST,
                    "-keyout", str(cert / "privkey.pem"), "-out", str(cert / "fullchain.pem")],
                   check=True, capture_output=True, timeout=15)
    context = ssl.create_default_context(cafile=str(cert / "fullchain.pem"))
    legacy_target = "../sites-available/citygo-pilot"
    enabled = root / "sites-enabled" / "citygo-pilot"

    def render(name, profile):
        raw = (TEMPLATES / name).read_text(encoding="utf-8").replace("__CITYGO_HOST__", HOST)
        # The two production templates have the same 503. A private fixture
        # header supplies distinct positive observations under closed traffic.
        location = "    location @citygo_maintenance {"
        assert raw.count(location) == 1
        raw = raw.replace(location, location + f"\n        add_header X-CityGo-Fixture-Epoch {profile} always;")
        for source, destination in paths.items():
            raw = raw.replace(source, str(destination))
        return (raw.replace("listen 80", f"listen {LOOPBACK}:{http_port}")
                .replace("listen 443", f"listen {LOOPBACK}:{tls_port}")
                .replace(LOOPBACK + ":3000", f"{LOOPBACK}:{a.port}")).encode("utf-8")

    legacy_file = enabled.parent / legacy_target
    legacy_bytes = render("pilot.conf.template", "legacy")
    switch_bytes = render("pilot-web-switch.conf.template", "switch")
    legacy_file.write_bytes(legacy_bytes)
    replace_link(enabled, legacy_target)
    citygo = paths["/var/lib/citygo"]
    asset = citygo / ("web-assets" + ASSET)
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"previous web resource")
    ingress = citygo / "ingress"
    ingress.mkdir()
    include, marker = ingress / "web-upstream.conf", ingress / "traffic-open"

    def select(port):
        replace_file(include, f"proxy_pass http://{LOOPBACK}:{port};\n".encode())

    select(a.port)
    config = root / "nginx.conf"
    temp_paths = "\n".join(f"{name}_temp_path {root}/{name};"
                           for name in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"))
    config.write_text(f"""daemon off;
worker_processes 1;
pid {root}/nginx.pid;
events {{ worker_connections 128; }}
http {{
{temp_paths}
include {enabled};
}}
""", encoding="utf-8")
    initial_include, initial_config = include.read_bytes(), config.read_bytes()
    args = ["nginx", "-p", str(root) + "/", "-c", str(config), "-e", "stderr"]

    def validate():
        result = subprocess.run([*args, "-t"], capture_output=True, timeout=10)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))

    class TLS(http.client.HTTPSConnection):
        def __init__(self):
            super().__init__(HOST, tls_port, timeout=3, context=context)

        def connect(self):
            with ExitStack() as cleanup:
                raw = socket.create_connection((LOOPBACK, tls_port), timeout=self.timeout)
                cleanup.callback(raw.close)
                self.sock = context.wrap_socket(raw, server_hostname=HOST)
                cleanup.pop_all()

    def fetch(path, connection=None, header="X-CityGo-Web-Slot"):
        with ExitStack() as cleanup:
            if connection is None:
                connection = TLS()
                cleanup.callback(connection.close)
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.getheader(header), response.read()

    def closed(path, connection=None):
        status, slot_header, body = fetch(path, connection)
        assert status == 503 and slot_header is None
        assert json.loads(body)["code"] == "SERVICE_UNAVAILABLE"

    timings = {}
    validate()
    with (root / "nginx.log").open("wb") as log, subprocess.Popen(args, stdout=log, stderr=log) as nginx:
        def workers():
            assert nginx.poll() is None, "disposable Nginx exited"
            return set(Path(f"/proc/{nginx.pid}/task/{nginx.pid}/children").read_text().split())

        def reload(name, change, ports):
            previous = workers()
            began = monotonic()
            change()
            validate()
            nginx.send_signal(signal.SIGHUP)
            wait_for(lambda: bool(workers() - previous), "Nginx did not start a new generation")
            def retired_listener(pid):
                try:
                    title = Path(f"/proc/{pid}/cmdline").read_bytes()
                except FileNotFoundError:
                    return True
                return title.startswith(b"nginx: worker process is shutting down")

            wait_for(lambda: all(retired_listener(pid) for pid in previous),
                     "old Nginx workers still accept new connections")
            previous_port, target_port = ports

            def switched():
                status, route, _ = fetch("/__citygo_web_slot")
                assert status == 200 and route in (f"{LOOPBACK}:{previous_port}", f"{LOOPBACK}:{target_port}")
                return route == f"{LOOPBACK}:{target_port}"

            wait_for(switched, "fresh TLS did not converge to the requested slot")
            timings[name] = round((monotonic() - began) * 1000, 2)

        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")

        def process_pin(pid):
            try:
                raw = Path(f"/proc/{pid}/stat").read_text()
            except FileNotFoundError:
                return None
            tail = raw.rsplit(")", 1)[1].split()
            return (int(pid), int(tail[19])) if tail[0] != "Z" else None

        master = process_pin(nginx.pid)

        def worker_pins():
            return frozenset(pin for pid in workers() if (pin := process_pin(pid)) is not None)

        class ClosedHost:
            signals = 0

            def observe_closed(self):
                assert not os.path.lexists(marker) and legacy_file.read_bytes() == legacy_bytes
                assert include.read_bytes() == initial_include and config.read_bytes() == initial_config
                assert process_pin(nginx.pid) == master
                if enabled.is_symlink():
                    assert os.readlink(enabled) == legacy_target
                    link = "legacy"
                else:
                    assert enabled.is_file() and enabled.read_bytes() == switch_bytes
                    link = "switch"
                status, loaded, body = fetch("/", header="X-CityGo-Fixture-Epoch")
                assert status == 503 and json.loads(body)["code"] == "SERVICE_UNAVAILABLE"
                return Epoch(link, loaded, boot_id, master, worker_pins())

            def replace_link(self, origin, destination):
                assert self.observe_closed().link == origin
                if destination == "switch":
                    replace_file(enabled, switch_bytes)
                else:
                    replace_link(enabled, legacy_target)

            def test_config(self):
                validate()

            def hup(self):
                fd = os.pidfd_open(nginx.pid)
                try:
                    assert process_pin(nginx.pid) == master
                    signal.pidfd_send_signal(fd, signal.SIGHUP, None, 0)
                    self.signals += 1
                finally:
                    os.close(fd)

            def wait_for_workers(self, before):
                old = {tuple(pin) for pin in before["workers"]}
                wait_for(lambda: (pins := worker_pins()) and pins.isdisjoint(old),
                         "Nginx did not drain the old closed generation")

        class Interrupted(Exception):
            pass

        host = ClosedHost()
        operation = uuid4().hex
        review = sha256(legacy_bytes + switch_bytes + initial_include + initial_config).hexdigest()

        def closed_transition(direction, interruption):
            path = root / (direction + "-journal.json")

            def interrupt(label):
                if label == interruption:
                    raise Interrupted()

            args = dict(operation=operation, review_sha256=review, direction=direction, host=host)
            signals_before = host.signals
            began = monotonic()
            try:
                transition(path, checkpoint=interrupt, **args)
            except Interrupted:
                pass
            else:
                raise AssertionError("fixture interruption not reached")
            pending = json.loads(path.read_bytes())
            if interruption == "hup-sent":
                assert pending["phase"] == "hup-intent" and host.signals == signals_before + 1
                host.wait_for_workers(pending["before"])
            else:
                assert pending["phase"] == "link-intent" and host.signals == signals_before
            receipt = transition(path, resume=True, **args)
            assert receipt["phase"] == "verified-closed" and host.signals == signals_before + 1
            timings[direction + "ClosedMs"] = round((monotonic() - began) * 1000, 2)
            return receipt

        try:
            wait_for(workers, "initial worker did not start")
            closed("/")
            install_receipt = closed_transition("install", "hup-sent")
            for path in ("/", ASSET, "/__citygo_web_slot"):
                closed(path)
            with closing(TLS()) as probe:
                closed("/", probe)
                socket_before = probe.sock
                assert socket_before is not None
                marker.touch()
                assert fetch("/", probe) == (200, None, b"slot-a") and probe.sock is socket_before
            assert fetch(ASSET) == (200, None, asset.read_bytes())
            assert fetch("/__citygo_web_slot")[:2] == (200, f"{LOOPBACK}:{a.port}")

            with closing(TLS()) as stream:
                stream.request("GET", "/api/stream")
                response = stream.getresponse()
                assert response.status == 200 and response.read(len(SSE_HEAD)) == SSE_HEAD
                reload("forwardMs", lambda: select(b.port), (a.port, b.port))
                assert fetch("/") == (200, None, b"slot-b")
                assert fetch("/__citygo_web_slot")[:2] == (200, f"{LOOPBACK}:{b.port}")
                assert not a.release.is_set()
                a.release.set()
                assert response.read() == SSE_TAIL

            with closing(TLS()) as submit:
                submit.request("POST", "/api/submit", body=POST_BODY)
                assert b.post_seen.wait(3), "slot B did not accept the POST"
                reload("backToAms", lambda: select(a.port), (b.port, a.port))
                assert fetch("/") == (200, None, b"slot-a")
                assert fetch("/__citygo_web_slot")[:2] == (200, f"{LOOPBACK}:{a.port}")
                assert not b.release.is_set()
                b.release.set()
                response = submit.getresponse()
                assert response.status == 200 and response.read() == b"slot-b"
            assert a.streams == 1 and not a.posts and b.streams == 0 and b.posts == [POST_BODY]
            assert fetch(ASSET) == (200, None, asset.read_bytes())

            with closing(TLS()) as probe:
                assert fetch("/", probe) == (200, None, b"slot-a")
                socket_before = probe.sock
                assert socket_before is not None
                marker.unlink()
                closed("/", probe)
                assert probe.sock is socket_before
            wait_for(lambda: len(worker_pins()) == 1, "open switch workers did not drain")
            restore_receipt = closed_transition("restore", "link-replaced")
            assert install_receipt["binding"]["operation"] == restore_receipt["binding"]["operation"]
            assert host.signals == 2
            closed("/")
            assert not marker.exists() and legacy_file.read_bytes() == legacy_bytes
            marker.touch()
            assert fetch("/") == (200, None, b"slot-a")
            assert fetch("/__citygo_web_slot") == (404, None, b"fixture route missing")
        finally:
            if nginx.poll() is None:
                nginx.send_signal(signal.SIGQUIT)
                try:
                    nginx.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    nginx.kill()
                    nginx.wait()
                    raise
    assert nginx.returncode == 0
    return timings


def main():
    if not __debug__ or sys.argv[1:] != ["--disposable"] or sys.platform != "linux" or os.geteuid() == 0:
        raise SystemExit("Run this loopback-only rehearsal on Linux as a non-root user with --disposable")
    with TemporaryDirectory(prefix="citygo-nginx-") as directory, slot(b"slot-a") as a, slot(b"slot-b") as b:
        # Reserve two distinct loopback ports, then hand them to the owned process.
        with socket.socket() as http_address, socket.socket() as tls_address:
            for address in (http_address, tls_address):
                address.bind((LOOPBACK, 0))
            http_port, tls_port = (address.getsockname()[1] for address in (http_address, tls_address))
        timings = rehearse_ingress(Path(directory), http_port, tls_port, a, b)
    version = subprocess.run(["nginx", "-v"], check=True, capture_output=True, text=True, timeout=5).stderr.strip()
    print(json.dumps({"status": "passed", "nginx": version, "scope": "disposable-loopback",
                      "tlsVerified": True, "acceptedSseCount": 1, "acceptedPostCount": 1,
                      "legacyRestoredClosed": True, "workerGenerationTimingsMs": timings,
                      "closedJournalRecovery": {"installAfterHup": True, "restoreAfterLink": True,
                                                "hupSignals": 2}}, sort_keys=True))


if __name__ == "__main__":
    main()
