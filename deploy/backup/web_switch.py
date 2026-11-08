#!/usr/bin/env python3
"""Explicit, manual switch of TWO ALREADY STAGED Web containers only.

No runtime creation, migrations, grants, API/DB/jobs stop, automatic rollback,
autodeploy integration, forced shutdown, or recovery inferred from elapsed time.
Plan/pins are an operator trust root, not an attestation of source correctness.
"""
import argparse
import copy
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time

import backup as b
import web_switch_assets as assets

MIB = 1024 ** 2
PENDING = "web-switch-pending.json"
ACTIVE = "web-active.json"
SLOTS = {3000: "172.30.92.10", 3001: "172.30.92.20"}
HEX = r"[0-9a-f]{64}"
SHA = r"[0-9a-f]{40}"
MAX_PLAN = 262144
PLAN_PURPOSES = {1: "citygo-staged-web-switch-v1", 2: "citygo-staged-web-switch-v2"}


class WebSwitchError(Exception):
    """Only fixed redacted failure codes leave this module."""


def require(condition, code):
    if not condition:
        raise WebSwitchError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate-json-key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(WebSwitchError("invalid-json")))
    except (ValueError, UnicodeError, TypeError, RecursionError, OverflowError):
        raise WebSwitchError("invalid-json") from None


def keys(value, expected, code="plan-schema"):
    require(type(value) is dict and set(value) == set(expected), code)


def matches(value, pattern):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def absolute(value):
    require(type(value) is str and value.startswith("/") and not re.search(r"[\x00-\x20$]", value)
            and ".." not in PurePosixPath(value).parts and str(PurePosixPath(value)) == value, "plan-path")
    return value


def file_pin(value):
    keys(value, ("path", "sha256"))
    absolute(value["path"])
    require(matches(value["sha256"], HEX), "plan-file-pin")


def process_pin(value):
    keys(value, ("pid", "starttime"))
    require(all(type(value[k]) is int and value[k] > 0 for k in value), "plan-process")


def container_pin(value):
    keys(value, ("id", "image", "source_sha", "started_at", "runtime_sha256", "project", "service"))
    require(matches(value["id"], HEX) and matches(value["image"], "sha256:" + HEX)
            and matches(value["runtime_sha256"], HEX) and matches(value["source_sha"], SHA), "plan-container")
    require(matches(value["started_at"], r"20[0-9]{2}-[0-9TZ:.+-]{12,40}Z")
            and matches(value["project"], r"citygo-[a-z0-9][a-z0-9-]{0,62}")
            and value["service"] in {"api", "web", "postgres", "worker", "backup", "migrator"}, "plan-container")


def validate(value, now):
    keys(value, ("version", "purpose", "operation_id", "approved_at", "expires_at", "origin", "paths",
                 "files", "baseline", "slots", "compatibility", "assets", "nginx", "networks"))
    require(type(value["version"]) is int and value["version"] in PLAN_PURPOSES
            and value["purpose"] == PLAN_PURPOSES[value["version"]], "plan-purpose")
    require(matches(value["operation_id"], r"[0-9a-f]{32}"), "plan-operation")
    require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
            and value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400, "plan-expired")
    require(matches(value["origin"], r"https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}"), "plan-origin")
    keys(value["paths"], ("state_dir", "coordination_dir", "nginx_config", "upstream_include", "traffic_marker"))
    for path in value["paths"].values():
        absolute(path)
    require(len(set(value["paths"].values())) == 5, "plan-path-alias")
    require(type(value["files"]) is list and 2 <= len(value["files"]) <= 64, "plan-files")
    for pin in value["files"]:
        file_pin(pin)
    require(len({pin["path"] for pin in value["files"]}) == len(value["files"])
            and value["paths"]["nginx_config"] in {p["path"] for p in value["files"]}
            and value["paths"]["upstream_include"] not in {p["path"] for p in value["files"]}, "plan-files")
    keys(value["baseline"], ("api", "postgres", "jobs"))
    for role in ("api", "postgres"):
        container_pin(value["baseline"][role])
        require(value["baseline"][role]["service"] == role, "plan-baseline")
    require(type(value["baseline"]["jobs"]) is list and len(value["baseline"]["jobs"]) <= 60, "plan-jobs")
    for pin in value["baseline"]["jobs"]:
        container_pin(pin)
        require(pin["service"] in {"worker", "backup", "migrator"}, "plan-jobs")
    keys(value["slots"], ("old", "new"))
    for slot in value["slots"].values():
        keys(slot, ("container", "port", "ip"))
        container_pin(slot["container"])
        require(slot["container"]["service"] == "web" and type(slot["port"]) is int
                and slot["port"] in SLOTS and slot["ip"] == SLOTS[slot["port"]], "plan-slot")
    require(value["slots"]["old"]["port"] != value["slots"]["new"]["port"], "plan-slot-alias")
    pins = [value["baseline"][k] for k in ("api", "postgres")] + value["baseline"]["jobs"]
    pins += [slot["container"] for slot in value["slots"].values()]
    require(len({p["id"] for p in pins}) == len(pins), "plan-container-alias")
    keys(value["compatibility"], ("old", "new"))
    for pin in value["compatibility"].values():
        file_pin(pin)
    keys(value["assets"], ("root", "archive", "public_old", "public_new"))
    absolute(value["assets"]["root"])
    for name in ("archive", "public_old", "public_new"):
        file_pin(value["assets"][name])
    keys(value["nginx"], ("master", "workers"))
    process_pin(value["nginx"]["master"])
    require(type(value["nginx"]["workers"]) is list and 1 <= len(value["nginx"]["workers"]) <= 128, "plan-workers")
    for pin in value["nginx"]["workers"]:
        process_pin(pin)
    require(len({p["pid"] for p in value["nginx"]["workers"]}) == len(value["nginx"]["workers"]), "plan-workers")
    keys(value["networks"], ("web", "database"))
    require(all(matches(x, HEX) for x in value["networks"].values())
            and value["networks"]["web"] != value["networks"]["database"], "plan-networks")
    return value


@dataclass(frozen=True)
class WebSwitchPlan:
    raw: bytes
    path: Path

    @property
    def values(self):
        value = validate(strict_json(self.raw), int(time.time()))
        inputs = {pin["path"] for pin in value["files"] + list(value["compatibility"].values())}
        inputs.update(value["assets"][name]["path"] for name in ("archive", "public_old", "public_new"))
        inputs.update((self.path.as_posix(), value["paths"]["traffic_marker"]))
        outputs = {value["paths"]["upstream_include"]}
        outputs.update(str(PurePosixPath(value["paths"]["state_dir"]) / name) for name in (PENDING, ACTIVE))
        require(not inputs & outputs and len(outputs) == 3, "plan-input-output-alias")
        return value

    @property
    def sha256(self):
        return digest(self.raw)


def protected(path, *, directory=False, private=False):
    path = Path(path)
    require(path.is_absolute(), "protected-path")
    try:
        info = path.lstat()
        require(info.st_uid == 0 and not info.st_mode & (0o077 if private else 0o022)
                and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
                and (directory or info.st_nlink == 1), "protected-path")
        for parent in path.parents:
            meta = parent.lstat()
            require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022, "protected-parent")
    except OSError:
        raise WebSwitchError("protected-path") from None
    return path


def read_protected(path, *, private=False, limit=MAX_PLAN, allow_empty=False):
    path = protected(path, private=private)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                    and not before.st_mode & (0o077 if private else 0o022), "protected-file")
            raw = stream.read(limit + 1)
            after = protected(path, private=private).stat()
            require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino)
                    and (allow_empty or len(raw) > 0) and len(raw) <= limit, "protected-file-changed")
        return raw
    except OSError:
        raise WebSwitchError("protected-file") from None


def load_plan(path):
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "root-linux-required")
    result = WebSwitchPlan(read_protected(path, private=True), Path(path))
    result.values
    return result


@contextmanager
def switch_lock(state):
    """Own fixed lock; legacy backup.lock deliberately rejects new lock names."""
    import fcntl
    state = protected(state, directory=True, private=True)
    fd = os.open(state / "web-switch.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077
                and info.st_nlink == 1, "web-switch-lock-permissions")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise WebSwitchError("web-switch-already-running") from None
        yield
    finally:
        os.close(fd)


def runtime_fingerprint(detail):
    """Hash immutable inspect fields in memory. Never emit Env or driver errors."""
    return digest(wire({k: detail.get(k) for k in ("Config", "HostConfig", "Mounts")}
                       | {"Networks": {name: {k: data.get(k) for k in ("NetworkID", "IPAddress", "Aliases")}
                                       for name, data in detail.get("NetworkSettings", {}).get("Networks", {}).items()}}))


def upstream(port):
    require(type(port) is int and port in SLOTS, "upstream-port")
    return f"proxy_pass http://127.0.0.1:{port};\n".encode()


class _TLS(http.client.HTTPSConnection):
    def connect(self):
        import socket
        raw = socket.create_connection(("127.0.0.1", 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class Host:
    """Production adapter. All commands/requests below have fixed operations."""
    def __init__(self, plan):
        require(sys.platform.startswith("linux") and os.geteuid() == 0, "root-linux-required")
        # The installed entrypoint and its two local imports are operator code,
        # never loaded from a candidate image, bundle or writable working tree.
        for module_path in (__file__, b.__file__, assets.__file__):
            protected(Path(module_path).absolute())
        self.plan = plan
        self.value = plan.values
        self.state = protected(self.value["paths"]["state_dir"], directory=True, private=True)
        self.coordination = protected(self.value["paths"]["coordination_dir"], directory=True, private=True)
        self.env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": str(self.state), "LANG": "C.UTF-8",
                    "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": str(self.state / "docker")}

    def assert_plan(self):
        require(read_protected(self.plan.path, private=True) == self.plan.raw, "plan-revoked")
        self.plan.values

    @contextmanager
    def locked(self):
        # These are the existing cooperative locks. No admission marker changes.
        with b.lock(self.coordination), b.lock(self.coordination, "worker-admission.lock"), switch_lock(self.state):
            for name in ("operation-pending.json", "worker-pending.json", "pending.json"):
                require(not os.path.lexists(self.coordination / name), "legacy-operation-pending")
            yield

    def read(self, path):
        return read_protected(path, limit=16 * 1024 ** 2, allow_empty=True)

    def quiet(self):
        # The operator must have closed admission BEFORE staging. We never
        # revoke/restore an existing grant or stop an active Worker ourselves.
        require(not os.path.lexists(self.coordination / "worker-admission.json"), "worker-admission-must-be-closed")

    def pinned(self, pin):
        raw = self.read(pin["path"])
        require(digest(raw) == pin["sha256"], "file-pin-changed")
        return raw

    def write(self, path, raw):
        path = Path(path)
        protected(path.parent, directory=True)
        if os.path.lexists(path):
            protected(path)
        fd, temp = tempfile.mkstemp(prefix=".web-switch-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            b.sync_directory(path.parent)
            require(self.read(path) == raw, "write-readback")
        finally:
            if os.path.lexists(temp):
                os.unlink(temp)

    def record(self, name):
        path = self.state / name
        return strict_json(self.read(path)) if os.path.lexists(path) else None

    def save(self, name, value):
        self.write(self.state / name, wire(value))

    def clear_pending(self):
        protected(self.state / PENDING, private=True).unlink()
        b.sync_directory(self.state)

    def capture(self, argv, limit=2 * 1024 ** 2):
        try:
            result = subprocess.run(argv, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=20, check=False)
            require(result.returncode == 0 and len(result.stdout) <= limit, "host-command-failed")
            return result.stdout
        except (OSError, subprocess.SubprocessError):
            raise WebSwitchError("host-command-failed") from None

    def inspect(self, ident):
        result = strict_json(self.capture(["/usr/bin/docker", "inspect", ident]))
        require(type(result) is list and len(result) == 1 and type(result[0]) is dict, "invalid-container-inspect")
        return result[0]

    def inventory(self, projects):
        result = set()
        for project in sorted(projects):
            raw = self.capture(["/usr/bin/docker", "ps", "--all", "--no-trunc", "--format", "{{.ID}}",
                                "--filter", "label=com.docker.compose.project=" + project]).decode()
            result.update(raw.splitlines())
        return result

    def network_peers(self, ident):
        result = strict_json(self.capture(["/usr/bin/docker", "network", "inspect", ident]))
        require(type(result) is list and len(result) == 1 and type(result[0]) is dict, "invalid-network-inspect")
        value = result[0]
        require(value.get("Id") == ident, "network-changed")
        return set(value.get("Containers", {}))

    def resources(self):
        values = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, amount = line.split(":", 1)
            values[name] = int(amount.split()[0]) * 1024
        require(values["MemTotal"] >= (3328 + 512) * MIB and values["MemAvailable"] >= 512 * MIB
                and values["SwapTotal"] == values["SwapFree"], "insufficient-memory")
        pressure = Path("/proc/pressure/memory").read_text()
        match = re.search(r"^full avg10=([0-9.]+)", pressure, re.M)
        require(match is not None and float(match[1]) <= 1.0, "memory-pressure")
        disk = os.statvfs(self.state)
        require(disk.f_bavail * disk.f_frsize >= 256 * MIB, "insufficient-state-disk")

    def nginx_test(self):
        self.capture(["/usr/sbin/nginx", "-t"])

    def nginx_policy(self):
        raw = self.capture(["/usr/sbin/nginx", "-T"])
        reported = {path.decode("utf-8") for path in re.findall(rb"(?m)^# configuration file ([^:\n]+):\s*$", raw)}
        expected = {pin["path"] for pin in self.value["files"]}
        include = self.value["paths"]["upstream_include"]
        require(self.value["paths"]["nginx_config"] in reported and include in reported
                and reported <= expected | {include}, "nginx-unpinned-configuration")
        raw = re.sub(rb"#[^\n]*", b"", raw)
        values = re.findall(rb"\bworker_shutdown_timeout\s+([^;{}]+);", raw)
        require(all(v.strip() in (b"0", b"0ms", b"0s") for v in values), "nginx-forced-worker-timeout")

    def process(self, pid):
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
            tail = raw[raw.rfind(")") + 2:].split()
            if tail[0] == "Z":
                return None
            return {"pid": pid, "starttime": int(tail[19]), "parent": int(tail[1]),
                    "command": Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0"),
                    "executable": os.readlink(f"/proc/{pid}/exe"), "uid": Path(f"/proc/{pid}").stat().st_uid}
        except FileNotFoundError:
            return None

    def processes(self):
        master = self.value["nginx"]["master"]
        current = self.process(master["pid"])
        require(current is not None and current["starttime"] == master["starttime"]
                and current["uid"] == 0
                and current["executable"] == "/usr/sbin/nginx"
                and current["command"].startswith(b"nginx: master process "), "nginx-master-changed")
        workers = []
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                item = self.process(int(entry.name))
                if item and item["parent"] == master["pid"] and item["command"].startswith(b"nginx: worker process"):
                    require(item["executable"] == "/usr/sbin/nginx", "nginx-worker-changed")
                    workers.append({k: item[k] for k in ("pid", "starttime")})
        return workers

    def hup(self):
        require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "linux-pidfd-required")
        fd = None
        try:
            fd = os.pidfd_open(self.value["nginx"]["master"]["pid"], 0)
            # Verify AFTER acquiring the stable handle. A death/PID reuse after
            # this check cannot redirect SIGHUP to an unrelated process.
            self.processes()
            signal.pidfd_send_signal(fd, signal.SIGHUP, None, 0)
        except OSError:
            raise WebSwitchError("nginx-master-signal-failed") from None
        finally:
            if fd is not None:
                os.close(fd)

    def probe(self, port=None):
        host = self.value["origin"][8:]
        connection = (_TLS(host, timeout=5, context=ssl.create_default_context()) if port is None
                      else http.client.HTTPConnection("127.0.0.1", port, timeout=5))
        try:
            path = "/__citygo_web_slot" if port is None else "/api/ready"
            connection.request("GET", path, headers={"Host": host, "X-Forwarded-Proto": "https", "Connection": "close"})
            response = connection.getresponse()
            require(response.status == 200 and strict_json(response.read(4097)) == {"status": "ok"}, "web-not-ready")
            if port is None:
                return response.getheader("X-CityGo-Web-Slot")
            connection.close()
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request("GET", "/api/v1/dashboard", headers={"Host": host, "X-Forwarded-Proto": "https",
                               "X-CityGo-Contract-Version": "1", "Connection": "close"})
            response = connection.getresponse()
            body = strict_json(response.read(4097))
            require(response.status == 401 and body.get("code") == "UNAUTHENTICATED"
                    and body.get("contractVersion") == "1" and response.getheader("X-CityGo-Contract-Version") == "1", "web-auth-contract")
        finally:
            connection.close()

    def sigterm(self, ident):
        self.capture(["/usr/bin/docker", "kill", "--signal", "SIGTERM", ident])

    def pause(self):
        time.sleep(0.1)


def _compatibility(host, value):
    records = {name: strict_json(host.pinned(pin)) for name, pin in value["compatibility"].items()}
    fields = {"version", "source_sha", "backend_sha256", "schema_sha256", "api_contract", "api_internal_url", "advertising"}
    for name, record in records.items():
        keys(record, fields, "compatibility-schema")
        require(type(record["version"]) is int and record["version"] == 1
                and matches(record["backend_sha256"], HEX) and matches(record["schema_sha256"], HEX)
                and record["source_sha"] == value["slots"][name]["container"]["source_sha"]
                and record["api_contract"] == "1" and record["api_internal_url"] == "http://api:4000"
                and record["advertising"] == "disabled", "compatibility-unverified")
    require(all(records["old"][k] == records["new"][k] for k in fields - {"source_sha"}), "backend-or-schema-changed")
    return {"backend_sha256": records["old"]["backend_sha256"], "schema_sha256": records["old"]["schema_sha256"]}


def _containers(host, value, *, retired=False):
    baseline = value["baseline"]
    pins = [baseline[k] for k in ("api", "postgres")] + baseline["jobs"]
    pins += [slot["container"] for slot in value["slots"].values()]
    require(host.inventory({pin["project"] for pin in pins}) == {pin["id"] for pin in pins}, "container-inventory-changed")
    details = {}
    for pin in pins:
        item = host.inspect(pin["id"])
        state, cfg = item.get("State", {}), item.get("Config", {})
        labels = cfg.get("Labels", {}) or {}
        old = pin["id"] == value["slots"]["old"]["container"]["id"]
        runtime = item
        if retired and old:
            # Docker clears the published address after a clean stop. This is
            # the ONLY permitted inspect drift: the same configured network,
            # aliases, ports, image, process and isolation remain hash-bound.
            networks = item.get("NetworkSettings", {}).get("Networks", {})
            require(len(networks) == 1, "retired-web-network-changed")
            endpoint = next(iter(networks.values()))
            require(endpoint.get("NetworkID") == value["networks"]["web"]
                    and endpoint.get("IPAddress") in ("", None, value["slots"]["old"]["ip"]), "retired-web-network-changed")
            runtime = copy.deepcopy(item)
            next(iter(runtime["NetworkSettings"]["Networks"].values()))["IPAddress"] = value["slots"]["old"]["ip"]
        require(item.get("Id") == pin["id"] and item.get("Image") == pin["image"]
                and state.get("StartedAt") == pin["started_at"] and item.get("RestartCount") == 0
                and runtime_fingerprint(runtime) == pin["runtime_sha256"], "container-pin-changed")
        require(labels.get("com.docker.compose.project") == pin["project"]
                and labels.get("com.docker.compose.service") == pin["service"], "container-role-changed")
        if pin["service"] != "postgres":
            require(labels.get("org.opencontainers.image.revision") == pin["source_sha"], "container-source-changed")
        require(all(state.get(k) is False for k in ("Paused", "Restarting", "OOMKilled", "Dead"))
                and state.get("Error") == "", "container-unhealthy")
        exited = pin in baseline["jobs"] or (retired and old)
        if exited:
            require(state.get("Running") is False and state.get("Status") == "exited"
                    and type(state.get("ExitCode")) is int and state["ExitCode"] == 0, "unclean-exit")
        else:
            require(state.get("Running") is True and state.get("Status") == "running"
                    and state.get("Health", {}).get("Status") == "healthy", "container-not-ready")
        details[pin["id"]] = item
        # Config fingerprints pin mount identity, while these hashes pin the
        # bytes behind every bind-mounted configuration/secret file.
        pinned_paths = {entry["path"] for entry in value["files"]}
        for mount in item.get("Mounts", []):
            if mount.get("Type") == "bind":
                require(mount.get("RW") is False and mount.get("Source") in pinned_paths, "unbound-runtime-file")
    api = details[baseline["api"]["id"]]
    env = dict(x.split("=", 1) for x in api["Config"].get("Env", []) if "=" in x)
    require(set(env.get("TRUSTED_PROXY_CIDRS", "").split(",")) == {ip + "/32" for ip in SLOTS.values()}, "trusted-web-ips-not-bootstrapped")
    require(api["HostConfig"].get("Memory") == 768 * MIB
            and details[baseline["postgres"]["id"]]["HostConfig"].get("Memory") == 1024 * MIB, "runtime-memory-budget")
    for name, slot in value["slots"].items():
        item = details[slot["container"]["id"]]
        cfg = item["HostConfig"]
        policy = cfg.get("RestartPolicy", {})
        if value["version"] == 1:
            # Preserve the original v1 contract, including its inspect shape.
            valid_restart = policy.get("Name") == "no"
        else:
            # V2 alone authorizes one durable ACTIVE Web. Retired/old Web never
            # automatically restarts; no arbitrary policy or retry authority.
            valid_restart = (type(policy) is dict and set(policy) == {"Name", "MaximumRetryCount"}
                             and policy["Name"] == ("no" if name == "old" else "unless-stopped")
                             and type(policy["MaximumRetryCount"]) is int and policy["MaximumRetryCount"] == 0)
        require(cfg.get("Memory") == 768 * MIB and cfg.get("ReadonlyRootfs") is True
                and cfg.get("Privileged") is False and cfg.get("Init") is True
                and valid_restart
                and cfg.get("PortBindings") == {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(slot["port"])}]}, "web-runtime-isolation")
        if not (retired and slot == value["slots"]["old"]):
            require(item.get("NetworkSettings", {}).get("Ports") == {
                "3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(slot["port"])}]}, "web-live-port-changed")
        nets = item.get("NetworkSettings", {}).get("Networks", {})
        require(len(nets) == 1 and next(iter(nets.values())).get("NetworkID") == value["networks"]["web"]
                and (next(iter(nets.values())).get("IPAddress") in ("", None, slot["ip"])
                     if retired and slot == value["slots"]["old"] else
                     next(iter(nets.values())).get("IPAddress") == slot["ip"]), "web-network-changed")
    web_peers = {baseline["api"]["id"]} | {s["container"]["id"] for s in value["slots"].values()
                                                           if details[s["container"]["id"]]["State"]["Running"]}
    db_peers = {baseline["api"]["id"], baseline["postgres"]["id"]}
    require(host.network_peers(value["networks"]["web"]) == web_peers
            and host.network_peers(value["networks"]["database"]) == db_peers, "unexpected-network-peer")
    return details


def _verify(plan, host, *, retired=False, check_workers=True):
    require(type(plan) is WebSwitchPlan, "loaded-plan-required")
    host.assert_plan()
    value = plan.values
    host.quiet()
    for pin in value["files"]:
        host.pinned(pin)
    host.read(value["paths"]["traffic_marker"])
    compatibility = _compatibility(host, value)
    _containers(host, value, retired=retired)
    host.resources()
    host.nginx_policy()
    workers = host.processes()
    if check_workers:
        require(sorted(workers, key=lambda x: x["pid"]) == sorted(value["nginx"]["workers"], key=lambda x: x["pid"]), "nginx-workers-changed")
    try:
        section = value["assets"]
        old, new, archive = (strict_json(host.pinned(section[k])) for k in ("public_old", "public_new", "archive"))
        assets.verify_public_compatibility(old, new)
        proof = assets.verify_archive(section["root"], archive)
    except (b.BackupError, ValueError, OSError):
        raise WebSwitchError("assets-unverified") from None
    for name, slot in value["slots"].items():
        if not (retired and name == "old"):
            host.probe(slot["port"])
    host.assert_plan()
    proof = {"version": 1, "plan_sha256": plan.sha256, "operation_id": value["operation_id"],
             "compatibility": compatibility, "assets": proof}
    if value["version"] == 2:
        proof.update(plan_version=2, purpose=PLAN_PURPOSES[2])
    return proof


def verify(plan, *, _host=None):
    host = _host or Host(plan)
    with host.locked():
        require(host.record(PENDING) is None, "web-switch-pending")
        proof = _verify(plan, host)
        require(host.read(plan.values["paths"]["upstream_include"]) == upstream(plan.values["slots"]["old"]["port"]), "upstream-changed")
        require(host.probe() == "127.0.0.1:" + str(plan.values["slots"]["old"]["port"]), "active-route-changed")
        return {**proof, "status": "verified-not-switched"}


def _pending(plan, host):
    record = host.record(PENDING)
    require(type(record) is dict and record.get("plan_sha256") == plan.sha256
            and record.get("operation_id") == plan.values["operation_id"]
            and record.get("old_workers") == plan.values["nginx"]["workers"], "pending-other-operation")
    return record


def switch(plan, *, allow_switch=False, _host=None):
    require(allow_switch is True, "explicit-switch-permission-required")
    host = _host or Host(plan)
    with host.locked():
        require(host.record(PENDING) is None, "web-switch-pending")
        active = host.record(ACTIVE)
        require(active is None or type(active) is dict, "active-record-invalid")
        require(active is None or active.get("operation_id") != plan.values["operation_id"], "operation-already-used")
        proof = _verify(plan, host)
        value = plan.values
        path = value["paths"]["upstream_include"]
        old, new = (upstream(value["slots"][k]["port"]) for k in ("old", "new"))
        require(host.read(path) == old and host.probe() == "127.0.0.1:" + str(value["slots"]["old"]["port"]), "active-route-changed")
        record = {**proof, "phase": "prepared", "old_workers": value["nginx"]["workers"]}
        host.save(PENDING, record)  # durable BEFORE the first ingress mutation
        host.assert_plan()
        host.write(path, new)
        try:
            host.nginx_test()
        except WebSwitchError:
            host.write(path, old)  # no HUP has been sent; preserve pending anyway
            host.save(PENDING, {**record, "phase": "configuration-rejected"})
            raise
        host.assert_plan()
        require(host.read(path) == new, "upstream-changed")
        _verify(plan, host)  # No source/config/process drift may cross HUP.
        host.save(PENDING, {**record, "phase": "reload-requested"})
        host.hup()
        deadline = time.monotonic() + 10
        while True:
            host.assert_plan()
            workers = host.processes()
            fresh = [p for p in workers if p not in value["nginx"]["workers"]]
            if fresh and host.probe() == "127.0.0.1:" + str(value["slots"]["new"]["port"]):
                break
            require(time.monotonic() < deadline, "new-nginx-generation-unconfirmed")
            host.pause()
        _verify(plan, host, check_workers=False)
        require(host.read(path) == new, "upstream-changed")
        receipt = {**record, "phase": "switched-awaiting-retirement", "new_workers": fresh,
                   "active_web": value["slots"]["new"]["container"]["id"]}
        host.save(ACTIVE, receipt)
        host.save(PENDING, receipt)
        return receipt


def retire(plan, *, allow_stop=False, _host=None, _wait_seconds=330):
    require(allow_stop is True, "explicit-retire-permission-required")
    require(type(_wait_seconds) in (int, float) and 0 <= _wait_seconds <= 330, "retire-deadline")
    host = _host or Host(plan)
    with host.locked():
        host.assert_plan()
        if host.record(PENDING) is None:
            active = host.record(ACTIVE)
            require(type(active) is dict and active.get("phase") == "retired"
                    and active.get("plan_sha256") == plan.sha256, "no-confirmed-retirement")
            _verify(plan, host, retired=True, check_workers=False)
            require(host.read(plan.values["paths"]["upstream_include"]) == upstream(plan.values["slots"]["new"]["port"])
                    and host.probe() == "127.0.0.1:" + str(plan.values["slots"]["new"]["port"]), "active-route-changed")
            return active
        record = _pending(plan, host)
        require(record.get("phase") in ("switched-awaiting-retirement", "stop-requested", "retired"), "switch-not-confirmed")
        active = host.record(ACTIVE)
        require(type(active) is dict and active.get("plan_sha256") == plan.sha256
                and active.get("active_web") == plan.values["slots"]["new"]["container"]["id"], "active-record-changed")
        value = plan.values
        path = value["paths"]["upstream_include"]
        def check_route():
            host.assert_plan()
            require(host.read(path) == upstream(value["slots"]["new"]["port"])
                    and host.probe() == "127.0.0.1:" + str(value["slots"]["new"]["port"]), "active-route-changed")
        check_route()
        deadline = time.monotonic() + _wait_seconds
        while any(p in host.processes() for p in record["old_workers"]):
            require(time.monotonic() < deadline, "old-nginx-workers-still-active")
            check_route()
            host.pause()
        old_id = value["slots"]["old"]["container"]["id"]
        if record["phase"] == "switched-awaiting-retirement":
            _verify(plan, host, check_workers=False)
            check_route()
            host.save(PENDING, {**record, "phase": "stop-requested"})
            host.sigterm(old_id)  # NOT docker stop: never escalate to SIGKILL
        while host.inspect(old_id).get("State", {}).get("Running"):
            require(time.monotonic() < deadline, "old-web-still-active")
            check_route()
            host.pause()
        while old_id in host.network_peers(value["networks"]["web"]):
            require(time.monotonic() < deadline, "old-web-endpoint-still-active")
            check_route()
            host.pause()
        _verify(plan, host, retired=True, check_workers=False)
        check_route()
        receipt = {**active, "phase": "retired", "retired_web": old_id}
        host.save(ACTIVE, receipt)
        host.save(PENDING, receipt)
        host.assert_plan()
        require(_pending(plan, host) == receipt, "pending-changed")
        host.clear_pending()
        return receipt


def inspect_pending(plan, *, _host=None):
    host = _host or Host(plan)
    with host.locked():
        host.assert_plan()
        def summary(record):
            if record is None:
                return None
            require(type(record) is dict and record.get("plan_sha256") == plan.sha256
                    and record.get("operation_id") == plan.values["operation_id"]
                    and record.get("phase") in {"prepared", "configuration-rejected", "reload-requested",
                                                 "switched-awaiting-retirement", "stop-requested", "retired"}, "state-record-invalid")
            # Do not echo arbitrary JSON/paths/errors from a corrupt state file.
            return {key: record[key] for key in ("plan_sha256", "operation_id", "phase")}
        return {"pending": summary(host.record(PENDING)), "active": summary(host.record(ACTIVE))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify", "switch", "retire", "inspect"))
    parser.add_argument("--plan", required=True)
    parser.add_argument("--allow-switch", action="store_true")
    parser.add_argument("--allow-stop", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(args.allow_switch is (args.operation == "switch") and args.allow_stop is (args.operation == "retire"), "explicit-operation-flags")
        plan = load_plan(args.plan)
        result = ({"verify": verify, "inspect": inspect_pending}[args.operation](plan)
                  if args.operation in ("verify", "inspect") else
                  switch(plan, allow_switch=True) if args.operation == "switch" else retire(plan, allow_stop=True))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (WebSwitchError, b.BackupError, OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        # No environment, inspect payload, response, CLI stderr, or raw exception.
        print(json.dumps({"status": "failed-inspect-required"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
