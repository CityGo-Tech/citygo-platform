"""Closed runtime bootstrap: six bounded Docker mutations, no activation.

Unknown command acceptance is never replayed. A fresh adopt authorization can
record only an already complete, freshly verified target. Both transaction
barriers remain until a separate, explicitly authorized handoff/return.
"""
from contextlib import contextmanager
from functools import wraps
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import time

import web_bootstrap as compiler
import web_switch as w

STATE_ROOT = Path("/var/lib/citygo-web-runtime-stage")
COORDINATION_ROOT = Path("/var/lib/citygo-backup")
TRAFFIC_MARKER = Path("/var/lib/citygo/ingress/traffic-open")
PURPOSE = "citygo-web-runtime-stage-v1"
STAGE_APPROVAL = "citygo-web-runtime-stage-approval-v1"
ADOPT_APPROVAL = "citygo-web-runtime-stage-adopt-v1"
LABEL = "citygo.web-runtime-stage"
INTENTS = ("api-term", "api-remove", "api-create", "api-start", "web-create", "web-start")
COMPOSE_LABELS = {"com.docker.compose." + name for name in ("project", "service", "oneoff", "config-hash", "version",
                  "project.config_files", "project.working_dir", "project.environment_file", "container-number", "depends_on", "image", "replace")}
MAX_JSON = 512 * 1024
MIB = 1024 * 1024


class StageError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise StageError(code)


def _sanitized(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (OSError, ValueError, KeyError, TypeError, w.WebSwitchError, w.b.BackupError, compiler.BootstrapError):
            raise StageError("runtime-stage-rejected") from None
    return call


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def keys(value, expected, code):
    require(type(value) is dict and set(value) == set(expected), code)


def matches(value, expression):
    return type(value) is str and re.fullmatch(expression, value) is not None


def read(path, *, private=False, allow_empty=False):
    try:
        return w.read_protected(Path(path).absolute(), private=private, limit=MAX_JSON, allow_empty=allow_empty)
    except (OSError, w.WebSwitchError):
        raise StageError("protected-input") from None


def _platform():
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "root-linux-required")
    for module in (sys.modules[__name__], compiler, w, w.b, w.assets):
        read(module.__file__)


def validate_plan(raw, now=None):
    try:
        value = w.strict_json(raw)
        keys(value, ("version", "purpose", "operation_id", "origin", "observed_at", "expires_at", "draft_dir", "draft_sha256",
                     "baseline", "networks", "files", "attestation", "runtime_semantics"), "plan-shape")
        require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == PURPOSE
                and matches(value["operation_id"], r"[a-f0-9]{32}"), "plan-purpose")
        require(matches(value["origin"], r"https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}"), "plan-origin")
        require(type(value["observed_at"]) is int and type(value["expires_at"]) is int
                and 0 < value["observed_at"] < value["expires_at"] <= value["observed_at"] + 3600, "plan-time")
        if now is not None:
            require(type(now) is int and value["observed_at"] <= now < value["expires_at"], "plan-expired")
        w.absolute(value["draft_dir"])
        require(matches(value["draft_sha256"], w.HEX), "plan-draft")
        keys(value["baseline"], ("api", "web", "postgres", "jobs"), "plan-baseline")
        require(type(value["baseline"]["jobs"]) is list and len(value["baseline"]["jobs"]) <= 60, "plan-baseline")
        pins = [value["baseline"][name] for name in ("api", "web", "postgres")] + value["baseline"]["jobs"]
        for pin in pins:
            w.container_pin(pin)
            require(pin["project"] == compiler.PROJECT, "plan-baseline")
        require(len({pin["id"] for pin in pins}) == len(pins), "plan-baseline")
        for name in ("api", "web", "postgres"):
            require(value["baseline"][name]["service"] == name, "plan-baseline")
        require(all(p["service"] in {"worker", "migrator", "backup"} for p in value["baseline"]["jobs"]), "plan-baseline")
        keys(value["networks"], ("web", "database"), "plan-network")
        for role, suffix in (("web", "web_api"), ("database", "database")):
            keys(value["networks"][role], ("id", "name"), "plan-network")
            require(matches(value["networks"][role]["id"], w.HEX)
                    and value["networks"][role]["name"] == compiler.PROJECT + "_" + suffix, "plan-network")
        require(value["networks"]["web"]["id"] != value["networks"]["database"]["id"], "plan-network")
        keys(value["runtime_semantics"], ("api", "web"), "plan-runtime-semantics")
        require(all(matches(item, w.HEX) for item in value["runtime_semantics"].values()), "plan-runtime-semantics")
        require(type(value["files"]) is list and 8 <= len(value["files"]) <= 64, "plan-files")
        for pin in value["files"]:
            w.file_pin(pin)
        require(len({p["path"] for p in value["files"]}) == len(value["files"]), "plan-files")
        keys(value["attestation"], ("drained", "backup", "restore", "observed_at"), "plan-attestation")
        attestation = value["attestation"]
        require(attestation["drained"] is True and type(attestation["observed_at"]) is int
                and value["observed_at"] - 3600 <= attestation["observed_at"] <= value["observed_at"], "plan-attestation")
        for name in ("backup", "restore"):
            w.file_pin(attestation[name])
            require(attestation[name] in value["files"], "plan-attestation")
        return value
    except (w.WebSwitchError, TypeError, ValueError):
        raise StageError("plan-shape") from None


def authorization(raw, purpose, now=None):
    try:
        value = w.strict_json(raw)
        adopt = purpose == ADOPT_APPROVAL
        keys(value, {"version", "purpose", "operation_id", "plan_sha256", "approved_at", "expires_at",
                     "allow_adopt" if adopt else "allow_stage"} | ({"pending_sha256"} if adopt else set()), "approval-shape")
        require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == purpose
                and value["allow_adopt" if adopt else "allow_stage"] is True
                and matches(value["operation_id"], r"[a-f0-9]{32}") and matches(value["plan_sha256"], w.HEX), "approval-shape")
        require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
                and 0 < value["approved_at"] < value["expires_at"] <= value["approved_at"] + 3600, "approval-shape")
        if adopt:
            require(matches(value["pending_sha256"], w.HEX), "approval-shape")
        if now is not None:
            require(type(now) is int and value["approved_at"] <= now < value["expires_at"], "approval-expired")
        return value
    except (w.WebSwitchError, TypeError, ValueError):
        raise StageError("approval-shape") from None


def load_draft(plan, at):
    root = Path(plan["draft_dir"])
    require(set(os.listdir(w.protected(root, directory=True))) == {"canonical.original.json", "request.original.json",
                "canonical.prepared.json", "slot2.compose.json", "draft.json"}, "draft-tree")
    files = {name: read(root / name, private=True) for name in os.listdir(root)}
    require(digest(files["draft.json"]) == plan["draft_sha256"], "draft-pin")
    try:
        expected = compiler.compile_draft(files["canonical.original.json"], files["request.original.json"], at)
        req = compiler.strict_json(files["request.original.json"])
    except compiler.BootstrapError:
        raise StageError("draft-invalid") from None
    require(expected == files and req["operation_id"] == plan["operation_id"] and req["origin"] == plan["origin"], "draft-pin")
    pins = {p["path"]: p["sha256"] for p in plan["files"]}
    for pin in list(req["originals"].values()) + req["secret_pins"]:
        require(pins.get(pin["path"]) == pin["sha256"], "draft-file-pin")
    for role in ("api", "web"):
        require(plan["baseline"][role]["image"] == req["images"][role]["id"]
                and plan["baseline"][role]["source_sha"] == req["source_sha"], "draft-image-pin")
    require(all(plan["baseline"][role]["id"] == req["baseline"][role + "_id"] for role in ("api", "web", "postgres"))
            and plan["networks"]["web"] == req["web_network"], "draft-baseline-pin")
    original = compiler.strict_json(files["canonical.original.json"])
    prepared = compiler.strict_json(files["canonical.prepared.json"])
    slot2 = compiler.strict_json(files["slot2.compose.json"])
    api_spec = {"name": compiler.PROJECT, "services": {"api": copy.deepcopy(prepared["services"]["api"])},
                "secrets": {"api_config": prepared["secrets"]["api_config"]}, "networks": prepared["networks"]}
    for spec, role in ((api_spec, "api"), (slot2, "web")):
        spec["services"][role]["labels"] = {LABEL: plan["operation_id"]}
    return {"files": files, "request": req, "original": original, "api": api_spec, "web": slot2}


class Host:
    """Fixed local Docker operations; no shell, inherited provider or proxy env."""
    def __init__(self, plan):
        self.plan = plan
        self.env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": str(STATE_ROOT), "LANG": "C.UTF-8",
                    "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": str(STATE_ROOT / "docker")}

    def capture(self, args, timeout=20):
        try:
            result = subprocess.run(["/usr/bin/docker", *args], env=self.env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
            require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024, "docker-command-uncertain")
            return result.stdout
        except (OSError, subprocess.SubprocessError):
            raise StageError("docker-command-uncertain") from None

    def inspect(self, ident):
        return json.loads(self.capture(["inspect", ident]))[0]

    def image(self, ident):
        return json.loads(self.capture(["image", "inspect", ident]))[0]

    def inventory(self, projects):
        result = set()
        for project in sorted(projects):
            values = self.capture(["ps", "--all", "--no-trunc", "--format", "{{.ID}}", "--filter",
                                   "label=com.docker.compose.project=" + project]).decode().splitlines()
            require(len(values) <= 64 and all(matches(v, w.HEX) for v in values), "inventory")
            result.update(values)
        return result

    def find(self, project, role, operation_id):
        return self.capture(["ps", "--all", "--no-trunc", "--format", "{{.ID}}", "--filter", "label=com.docker.compose.project=" + project,
                             "--filter", "label=com.docker.compose.service=" + role, "--filter", "label=" + LABEL + "=" + operation_id]).decode().splitlines()

    def network(self, ident):
        value = json.loads(self.capture(["network", "inspect", ident]))[0]
        return {"id": value["Id"], "name": value["Name"],
                "peers": {key: item["IPv4Address"].split("/")[0] for key, item in (value.get("Containers") or {}).items()}}

    def closed(self, origin):
        require(not os.path.lexists(TRAFFIC_MARKER), "traffic-not-closed")
        for path in ("/", "/api/ready"):
            connection = w._TLS(origin[8:], timeout=10, context=ssl.create_default_context())
            try:
                connection.request("GET", path, headers={"Connection": "close"})
                response = connection.getresponse()
                headers = {key.lower(): value for key, value in response.getheaders()}
                body = response.read(4097)
                value = json.loads(body)
                require(response.status == 503 and headers.get("cache-control") == "no-store"
                        and headers.get("x-citygo-contract-version") == "1" and value.get("code") == "SERVICE_UNAVAILABLE"
                        and value.get("contractVersion") == "1" and value.get("retryable") is False, "traffic-not-closed")
            finally:
                connection.close()

    def probe(self, port, origin):
        for path, ready in (("/api/ready", True), ("/api/v1/dashboard", False)):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            try:
                connection.request("GET", path, headers={"Host": origin[8:], "X-Forwarded-Proto": "https",
                                                        "X-CityGo-Contract-Version": "1", "Connection": "close"})
                response = connection.getresponse()
                value = json.loads(response.read(4097))
                require(response.getheader("Content-Type", "").startswith("application/json"), "web-probe")
                require((response.status == 200 and value == {"status": "ok"}) if ready else
                        (response.status == 401 and value.get("code") == "UNAUTHENTICATED" and value.get("contractVersion") == "1"
                         and value.get("retryable") is False and response.getheader("X-CityGo-Contract-Version") == "1"), "web-probe")
            finally:
                connection.close()

    def resources(self):
        memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()}
        pressure = Path("/proc/pressure/memory").read_text()
        full = next(line for line in pressure.splitlines() if line.startswith("full "))
        return {"total_bytes": memory["MemTotal"], "available_bytes": memory["MemAvailable"],
                "swap_used_bytes": memory["SwapTotal"] - memory["SwapFree"],
                "pressure_full_avg10": float(re.search(r"avg10=([0-9.]+)", full)[1]),
                "free_bytes": os.statvfs(STATE_ROOT).f_bavail * os.statvfs(STATE_ROOT).f_frsize}

    def sigterm(self, ident):
        self.capture(["kill", "--signal", "SIGTERM", ident])

    def wait_exit(self, ident, started_at, timeout=330):
        deadline = time.monotonic() + timeout
        while True:
            value = self.inspect(ident)
            require(value["State"]["StartedAt"] == started_at, "api-process-changed")
            if not value["State"]["Running"]:
                return value
            require(time.monotonic() < deadline, "api-drain-timeout")
            time.sleep(0.1)

    def remove(self, ident):
        self.capture(["rm", ident])  # Never --force or --volumes.

    def create(self, spec_path, project, role):
        self.capture(["compose", "--project-directory", str(spec_path.parent), "--env-file", str(STATE_ROOT / "empty.env"),
                      "-p", project, "-f", str(spec_path), "create", "--no-build", "--pull", "never", "--no-recreate", role], timeout=180)
        found = self.find(project, role, self.plan["operation_id"])
        require(len(found) == 1, "created-identity-uncertain")
        return found[0]

    def start(self, ident):
        self.capture(["start", ident])

    def preflight(self, specs):
        self.capture(["compose", "version", "--short"])
        for path, project in specs:
            value = json.loads(self.capture(["compose", "--project-directory", str(path.parent), "--env-file", str(STATE_ROOT / "empty.env"),
                                             "-p", project, "-f", str(path), "config", "--format", "json"]))
            require(set(value.get("services", {})) == ({"api"} if project == compiler.PROJECT else {"web"}), "compose-projection-changed")


def _emit(callback, name):
    if callback is not None:
        callback(name)


def _save(path, value):
    w.protected(path.parent, directory=True, private=True)
    w.b.atomic_json(path, value)


def _once(path, raw):
    w.protected(path.parent, directory=True, private=True)
    if os.path.lexists(path):
        require(read(path, private=True) == raw, "stage-file-changed")
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fchmod(stream.fileno(), 0o400)
        os.fsync(stream.fileno())
    w.b.sync_directory(path.parent)


@contextmanager
def _lock(root, name, readonly=False):
    w.protected(root, directory=True, private=True)
    path = root / name
    require(not readonly or os.path.lexists(path), "stage-lock-missing")
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | (0 if readonly else os.O_CREAT), 0o600)
    directory = None
    try:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        w.protected(path, private=True)
        original, root_original = os.fstat(fd), os.fstat(directory)

        def namespace():
            w.protected(root, directory=True, private=True)
            w.protected(path, private=True)
            current, root_current = path.lstat(), root.lstat()
            require((current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
                    and (root_current.st_dev, root_current.st_ino) == (root_original.st_dev, root_original.st_ino), "stage-lock-namespace-changed")

        namespace()
        import fcntl
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise StageError("runtime-stage-already-running") from None
        yield namespace
    finally:
        if directory is not None:
            os.close(directory)
        os.close(fd)


@contextmanager
def _locked(create=False, readonly=False):
    with _lock(COORDINATION_ROOT, "maintenance.lock", readonly) as first, _lock(COORDINATION_ROOT, "worker-admission.lock", readonly) as second:
        if create and not os.path.lexists(STATE_ROOT):
            w.protected(STATE_ROOT.parent, directory=True)
            STATE_ROOT.mkdir(mode=0o700)
            w.b.sync_directory(STATE_ROOT.parent)
        w.protected(STATE_ROOT, directory=True, private=True)
        with _lock(STATE_ROOT, "runtime-stage.lock", readonly) as third:
            def namespace():
                first(); second(); third()
            yield namespace


def _pin(value, source):
    labels = value["Config"].get("Labels") or {}
    return {"id": value["Id"], "image": value["Image"], "source_sha": source,
            "project": labels["com.docker.compose.project"], "service": labels["com.docker.compose.service"],
            "started_at": value["State"]["StartedAt"], "runtime_sha256": w.runtime_fingerprint(value)}


def _ready(item):
    state = item["State"]
    require(state.get("Running") is True and state.get("Status") == "running"
            and state.get("Health", {}).get("Status") == "healthy" and item.get("RestartCount") == 0
            and all(state.get(key) is False for key in ("Paused", "Restarting", "OOMKilled", "Dead"))
            and state.get("Error") == "", "container-not-ready")


def _clean(item):
    state = item["State"]
    require(state.get("Running") is False and state.get("Status") == "exited" and type(state.get("ExitCode")) is int
            and state["ExitCode"] == 0 and all(state.get(key) is False for key in ("Paused", "Restarting", "OOMKilled", "Dead"))
            and state.get("Error") == "" and item.get("RestartCount") == 0, "api-not-clean")


def _files(plan, draft):
    environment = draft["request"]["originals"]["env"]
    for pin in plan["files"]:
        allow_empty = pin == environment and pin["sha256"] == digest(b"")
        require(digest(read(pin["path"], allow_empty=allow_empty)) == pin["sha256"], "file-pin-changed")
    require(not os.path.lexists(TRAFFIC_MARKER) and not os.path.lexists(COORDINATION_ROOT / "worker-admission.json"), "admission-not-closed")


def _resources(host):
    value = host.resources()
    require(value["total_bytes"] >= 3840 * MIB and value["available_bytes"] >= 512 * MIB
            and value["swap_used_bytes"] == 0 and value["pressure_full_avg10"] <= 1.0
            and value["free_bytes"] >= 8 * 1024 ** 3, "runtime-resources")


def _oom_enabled(host):
    # Docker stores this nullable pointer as null on an inspected running
    # container and false on CREATE; both mean the default enabled OOM killer.
    # Missing, true, numeric and string values are never normalized.
    require(type(host) is dict and "OomKillDisable" in host
            and (host["OomKillDisable"] is None or host["OomKillDisable"] is False), "oom-killer-must-remain-enabled")


def _baseline(host, plan, *, api_present=True, allow_web_unhealthy=False):
    result = {}
    pins = [plan["baseline"][name] for name in ("web", "postgres")] + plan["baseline"]["jobs"]
    if api_present:
        pins.append(plan["baseline"]["api"])
    for pin in pins:
        item = host.inspect(pin["id"])
        require(_pin(item, pin["source_sha"]) == pin, "baseline-changed")
        if pin in plan["baseline"]["jobs"]:
            _clean(item)
        elif allow_web_unhealthy and pin["service"] == "web":
            state = item["State"]
            require(state.get("Running") is True and state.get("Status") == "running"
                    and item.get("RestartCount") == 0 and state.get("Error") == ""
                    and all(state.get(key) is False for key in ("Paused", "Restarting", "OOMKilled", "Dead")), "baseline-changed")
        else:
            _ready(item)
        if pin["service"] != "postgres":
            require((item["Config"].get("Labels") or {}).get("org.opencontainers.image.revision") == pin["source_sha"], "source-changed")
        result[pin["id"]] = item
    return result


def _environment(value):
    require(type(value) is list and all(type(item) is str and "=" in item for item in value), "runtime-environment")
    result = dict(item.split("=", 1) for item in value)
    require(len(result) == len(value), "runtime-environment")
    return result


def _networks(host, plan, api_id, web_id=None):
    old_web = plan["baseline"]["web"]["id"]
    pg = plan["baseline"]["postgres"]["id"]
    web = host.network(plan["networks"]["web"]["id"])
    database = host.network(plan["networks"]["database"]["id"])
    require(web["id"] == plan["networks"]["web"]["id"] and web["name"] == plan["networks"]["web"]["name"]
            and database["id"] == plan["networks"]["database"]["id"] and database["name"] == plan["networks"]["database"]["name"], "network-changed")
    require(set(web["peers"]) == {old_web, api_id} | ({web_id} if web_id else set())
            and web["peers"][old_web] == "172.30.92.10" and web["peers"][api_id] == "172.30.92.11"
            and (not web_id or web["peers"][web_id] == "172.30.92.20")
            and set(database["peers"]) == {pg, api_id}, "network-peers-changed")


def _initial(host, plan, draft):
    _files(plan, draft)
    _resources(host)
    host.closed(plan["origin"])
    values = _baseline(host, plan)
    expected_ids = {p["id"] for p in [plan["baseline"][name] for name in ("api", "web", "postgres")] + plan["baseline"]["jobs"]}
    require(host.inventory({compiler.PROJECT, draft["web"]["name"]}) == expected_ids, "inventory-changed")
    _networks(host, plan, plan["baseline"]["api"]["id"])
    for role in ("api", "web"):
        item = values[plan["baseline"][role]["id"]]
        expected = draft["original"]["services"][role]
        policy = item["HostConfig"].get("RestartPolicy", {})
        require(policy == {"Name": "no", "MaximumRetryCount": 0} and type(policy.get("MaximumRetryCount")) is int
                and item["HostConfig"].get("Memory") == 768 * MIB
                and item["HostConfig"].get("MemorySwap") == 768 * MIB
                and item["HostConfig"].get("ReadonlyRootfs") is True
                and item["HostConfig"].get("Init") is True and item["HostConfig"].get("Privileged") is False
                and item["HostConfig"].get("CapDrop") == ["ALL"]
                and item["HostConfig"].get("SecurityOpt") == ["no-new-privileges:true"]
                and item["Config"].get("User") == "1000:1000"
                and item["Config"].get("WorkingDir") == "/app"
                and item["Config"].get("Entrypoint") == expected["entrypoint"]
                and item["Config"].get("Cmd") == expected["command"], "baseline-runtime")
        image = host.image(item["Image"])
        require(image.get("Id") == item["Image"]
                and (image.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision") == plan["baseline"][role]["source_sha"], "image-source-changed")
        image_env = _environment(image.get("Config", {}).get("Env") or [])
        image_env.update(expected["environment"])
        require(_environment(item["Config"].get("Env", [])) == image_env, "baseline-environment")
        image_labels = image.get("Config", {}).get("Labels") or {}
        labels = item["Config"].get("Labels") or {}
        require(all(labels.get(key) == val for key, val in image_labels.items())
                and all(key in image_labels or key in COMPOSE_LABELS for key in labels), "unsupported-baseline-label")
        names = {plan["networks"]["web"]["name"]} | ({plan["networks"]["database"]["name"]} if role == "api" else set())
        require(set(item.get("NetworkSettings", {}).get("Networks", {})) == names, "baseline-network")
        runtime_host = item["HostConfig"]
        _oom_enabled(runtime_host)
        require(runtime_host.get("PidsLimit") == expected["pids_limit"]
                and runtime_host.get("Tmpfs", {}) == dict(entry.split(":", 1) for entry in expected["tmpfs"])
                and runtime_host.get("LogConfig") == {"Type": expected["logging"]["driver"], "Config": expected["logging"]["options"]}
                and item["Config"].get("StopTimeout") == int(expected["stop_grace_period"][:-1]), "baseline-runtime")
        bindings = {} if role == "api" else {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}
        require((runtime_host.get("PortBindings") or {}) == bindings, "baseline-ports")
        mounts = item.get("Mounts", [])
        binds = [mount for mount in mounts if mount.get("Type") == "bind"]
        require(all(mount.get("Type") in {"bind", "tmpfs"} for mount in mounts), "baseline-mounts")
        if role == "api":
            require(len(binds) == 1 and binds[0].get("Source") == draft["original"]["secrets"]["api_config"]["file"]
                    and binds[0].get("Destination") == "/run/secrets/api.json" and binds[0].get("RW") is False, "baseline-mounts")
        else:
            require(not binds, "baseline-mounts")
        require(all(mount.get("Destination") in {entry.split(":", 1)[0] for entry in expected["tmpfs"]}
                    for mount in mounts if mount.get("Type") == "tmpfs"), "baseline-mounts")
        for endpoint in item["NetworkSettings"]["Networks"].values():
            require(set(endpoint.get("Aliases") or []) == {role, item["Name"].lstrip("/")}, "baseline-network-aliases")
    require(values[plan["baseline"]["postgres"]["id"]]["HostConfig"].get("Memory") == 1024 * MIB, "baseline-runtime")
    require({role: digest(wire(_semantic(values[plan["baseline"][role]["id"]], role))) for role in ("api", "web")}
            == plan["runtime_semantics"], "baseline-semantic-pin")
    host.probe(3000, plan["origin"])
    return values


def _journal():
    raw = read(STATE_ROOT / "pending.json", private=True)
    value = w.strict_json(raw)
    keys(value, ("version", "operation_id", "plan_sha256", "started_at", "original_approval_sha256", "legacy_barrier_sha256",
                 "phase", "intent", "targets", "completed", "ready_pins", "runtime_semantics_sha256"), "pending-shape")
    require(type(value["version"]) is int and value["version"] == 1 and matches(value["operation_id"], r"[a-f0-9]{32}")
            and all(matches(value[name], w.HEX) for name in ("plan_sha256", "original_approval_sha256", "legacy_barrier_sha256", "runtime_semantics_sha256"))
            and type(value["started_at"]) is int and value["started_at"] > 0
            and value["phase"] in ("starting", "intent", "done", "prepared-closed"), "pending-shape")
    require(type(value["completed"]) is list and value["completed"] == list(INTENTS[:len(value["completed"])])
            and len(value["completed"]) <= len(INTENTS), "pending-shape")
    require((value["phase"] == "intent" and len(value["completed"]) < len(INTENTS)
             and value["intent"] == INTENTS[len(value["completed"])])
            or (value["phase"] != "intent" and value["intent"] is None), "pending-shape")
    require(type(value["targets"]) is dict and set(value["targets"]) <= {"api", "web"}
            and all(matches(ident, w.HEX) for ident in value["targets"].values())
            and type(value["ready_pins"]) is dict and set(value["ready_pins"]) <= set(value["targets"]), "pending-shape")
    for role, pin in value["ready_pins"].items():
        w.container_pin(pin)
        require(pin["id"] == value["targets"][role] and pin["service"] == role, "pending-shape")
    plan_raw = read(STATE_ROOT / ("plan-" + value["operation_id"] + ".json"), private=True)
    approval_raw = read(STATE_ROOT / ("approval-" + value["operation_id"] + ".json"), private=True)
    require(digest(plan_raw) == value["plan_sha256"] and digest(approval_raw) == value["original_approval_sha256"], "pending-audit-changed")
    plan = validate_plan(plan_raw, value["started_at"])
    approved = authorization(approval_raw, STAGE_APPROVAL, value["started_at"])
    require(plan["operation_id"] == approved["operation_id"] == value["operation_id"]
            and approved["plan_sha256"] == value["plan_sha256"]
            and value["runtime_semantics_sha256"] == digest(wire(plan["runtime_semantics"])), "pending-audit-changed")
    return value, raw


def _barrier(pending):
    require(digest(read(COORDINATION_ROOT / "operation-pending.json", private=True)) == pending["legacy_barrier_sha256"], "legacy-barrier-changed")


def _desired(host, plan, draft, pending):
    _files(plan, draft)
    _resources(host)
    host.closed(plan["origin"])
    values = _baseline(host, plan, api_present=False)
    api = host.find(compiler.PROJECT, "api", plan["operation_id"])
    web = host.find(draft["web"]["name"], "web", plan["operation_id"])
    require(len(api) == len(web) == 1 and api[0] != plan["baseline"]["api"]["id"], "prepared-target-incomplete")
    expected = set(values) | {api[0], web[0]}
    require(host.inventory({compiler.PROJECT, draft["web"]["name"]}) == expected, "inventory-changed")
    runtime_raw = read(STATE_ROOT / ("runtime-" + plan["operation_id"] + ".json"), private=True)
    require(runtime_raw == wire(plan["runtime_semantics"])
            and digest(runtime_raw) == pending["runtime_semantics_sha256"], "runtime-cache-changed")
    old_api = plan["runtime_semantics"]
    for role in ("api", "web"):
        require(read(STATE_ROOT / (role + "-" + plan["operation_id"] + ".json"), private=True) == wire(draft[role]), "stage-spec-changed")
    require(read(STATE_ROOT / "empty.env", private=True) == b"# empty environment\n", "stage-spec-changed")
    # Only immutable raw hashes are persisted. The original Config/HostConfig
    # remains in the protected canonical snapshot, not in public diagnostics.
    api_item, web_item = host.inspect(api[0]), host.inspect(web[0])
    for role, item in (("api", api_item), ("web", web_item)):
        _target(host, item, role, compiler.PROJECT if role == "api" else draft["web"]["name"], plan, old_api[role])
    _networks(host, plan, api[0], web[0])
    host.probe(3000, plan["origin"])
    host.probe(3001, plan["origin"])
    _barrier(pending)
    targets = {"api": _pin(api_item, plan["baseline"]["api"]["source_sha"]), "web": _pin(web_item, plan["baseline"]["web"]["source_sha"])}
    require(all(targets[role] == pin for role, pin in pending["ready_pins"].items()), "target-process-changed")
    receipt_path = STATE_ROOT / ("prepared-" + plan["operation_id"] + ".json")
    if os.path.lexists(receipt_path):
        _validate_receipt(read(receipt_path, private=True), plan, pending, targets)
    return targets


def _target(host, item, role, project, plan, expected_semantic, *, created=False):
    if created:
        require(item["State"].get("Status") == "created" and item["State"].get("Running") is False
                and item.get("RestartCount") == 0, "target-not-created")
    else:
        _ready(item)
    require(matches(item.get("Id"), w.HEX) and item["Image"] == plan["baseline"][role]["image"], "target-image")
    cfg = item["Config"]
    labels = cfg.get("Labels") or {}
    require(type(labels) is dict and labels.get("com.docker.compose.project") == project
            and labels.get("com.docker.compose.service") == role and labels.get("com.docker.compose.oneoff") in ("False", "false")
            and labels.get(LABEL) == plan["operation_id"]
            and labels.get("org.opencontainers.image.revision") == plan["baseline"][role]["source_sha"], "target-ownership")
    image_labels = host.image(item["Image"]).get("Config", {}).get("Labels") or {}
    require(all(labels.get(key) == value for key, value in image_labels.items())
            and all(key in image_labels or key == LABEL or key in COMPOSE_LABELS for key in labels), "target-labels")
    require(cfg.get("Hostname") == item["Id"][:12], "target-hostname")
    require(digest(wire(_semantic(item, role, undo=True))) == expected_semantic, "target-runtime-changed")
    networks = item.get("NetworkSettings", {}).get("Networks", {})
    names = {plan["networks"]["web"]["name"]} | ({plan["networks"]["database"]["name"]} if role == "api" else set())
    require(type(networks) is dict and set(networks) == names, "target-networks")
    for endpoint in networks.values():
        require(set(endpoint.get("Aliases") or []) == {role, item["Name"].lstrip("/")}, "target-network-aliases")
    if not created:
        require({data.get("NetworkID") for data in networks.values()} == {plan["networks"][name]["id"]
                for name in (("web", "database") if role == "api" else ("web",))}, "target-networks")
        ports = item.get("NetworkSettings", {}).get("Ports") or {}
        require((ports == {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3001"}]}) if role == "web" else
                all(not value for value in ports.values()), "target-live-ports")


def _semantic(item, role, undo=False):
    config = copy.deepcopy(item["Config"])
    config.pop("Hostname", None)
    config.pop("Labels", None)
    config["Env"] = _environment(config.get("Env", []))
    host = copy.deepcopy(item["HostConfig"])
    _oom_enabled(host)
    host["OomKillDisable"] = False
    if undo:
        policy = host.get("RestartPolicy")
        require(type(policy) is dict and set(policy) == {"Name", "MaximumRetryCount"}
                and policy["Name"] == "unless-stopped" and type(policy["MaximumRetryCount"]) is int
                and policy["MaximumRetryCount"] == 0, "target-restart-changed")
        host["RestartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}
        if role == "api":
            require(config["Env"].get("TRUSTED_PROXY_CIDRS") == compiler.NEW_CIDRS, "target-runtime-changed")
            config["Env"]["TRUSTED_PROXY_CIDRS"] = compiler.OLD_CIDR
        else:
            require(host.get("PortBindings") == {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3001"}]}, "target-runtime-changed")
            host["PortBindings"] = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}
    return {"Config": config, "HostConfig": host, "Mounts": item.get("Mounts", [])}


def _receipt(plan, raw, pending, targets, adopt_hash=None):
    return {"version": 1, "status": "prepared-closed", "operation_id": plan["operation_id"], "plan_sha256": digest(raw),
            "original_approval_sha256": pending["original_approval_sha256"], "adopt_approval_sha256": adopt_hash,
            "targets": targets, "legacy_barrier_retained": True, "traffic_opened": False, "nginx_changed": False,
            "runtime_changed": True, "attestation_provenance": "operator-supplied-not-live-proof",
            "requires_fresh_handoff": True, "legacy_resume_allowed": False}


def _validate_receipt(raw, plan, pending, targets):
    value = w.strict_json(raw)
    require(type(value) is dict, "prepared-receipt-changed")
    adopt_hash = value.get("adopt_approval_sha256")
    require(adopt_hash is None or matches(adopt_hash, w.HEX), "prepared-receipt-changed")
    expected = _receipt(plan, read(STATE_ROOT / ("plan-" + plan["operation_id"] + ".json"), private=True), pending, targets, adopt_hash)
    require(value == expected and type(value.get("version")) is int
            and value.get("legacy_barrier_retained") is True and value.get("traffic_opened") is False
            and value.get("nginx_changed") is False and value.get("runtime_changed") is True
            and value.get("requires_fresh_handoff") is True and value.get("legacy_resume_allowed") is False,
            "prepared-receipt-changed")
    if adopt_hash is not None:
        approved_raw = read(STATE_ROOT / ("adopt-" + adopt_hash + ".json"), private=True)
        snapshot_raw = read(STATE_ROOT / ("adopt-state-" + adopt_hash + ".json"), private=True)
        require(digest(approved_raw) == adopt_hash, "adopt-audit-changed")
        approved = authorization(approved_raw, ADOPT_APPROVAL)
        snapshot = w.strict_json(snapshot_raw)
        require(approved["pending_sha256"] == digest(snapshot_raw)
                and approved["operation_id"] == snapshot.get("operation_id") == pending["operation_id"]
                and approved["plan_sha256"] == snapshot.get("plan_sha256") == pending["plan_sha256"]
                and snapshot.get("original_approval_sha256") == pending["original_approval_sha256"]
                and snapshot.get("runtime_semantics_sha256") == pending["runtime_semantics_sha256"], "adopt-audit-changed")
    return value


def _wait_ready(host, ident, timeout=150):
    deadline = time.monotonic() + timeout
    original_started = None
    while True:
        item = host.inspect(ident)
        state = item["State"]
        require(item["Id"] == ident and state.get("Running") is True and item.get("RestartCount") == 0
                and state.get("OOMKilled") is False and state.get("Dead") is False and state.get("Restarting") is False,
                "target-not-running")
        if original_started is None:
            original_started = state["StartedAt"]
        require(state["StartedAt"] == original_started, "target-process-changed")
        if state.get("Health", {}).get("Status") == "healthy":
            _ready(item)
            return item
        require(time.monotonic() < deadline, "target-health-timeout")
        time.sleep(0.1)


def _detached(host, plan, old_id):
    deadline = time.monotonic() + 10
    while True:
        web = host.network(plan["networks"]["web"]["id"])
        database = host.network(plan["networks"]["database"]["id"])
        require(set(web["peers"]) <= {old_id, plan["baseline"]["web"]["id"]}
                and set(database["peers"]) <= {old_id, plan["baseline"]["postgres"]["id"]}, "network-peers-changed")
        if old_id not in web["peers"] and old_id not in database["peers"]:
            return
        require(time.monotonic() < deadline, "api-endpoint-still-active")
        time.sleep(0.1)


@_sanitized
def stage(plan_path, approval_path, *, allow_stage=False, now=None, _host=None, _checkpoint=None):
    require(allow_stage is True, "explicit-stage-required")
    _platform()
    current = int(time.time()) if now is None else now
    raw, approved_raw = read(plan_path, private=True), read(approval_path, private=True)
    plan, approved = validate_plan(raw, current), authorization(approved_raw, STAGE_APPROVAL, current)
    require(approved["plan_sha256"] == digest(raw) and approved["operation_id"] == plan["operation_id"], "approval-binding")
    draft = load_draft(plan, current)
    host = _host or Host(plan)
    with _locked(create=True) as namespace:
        require(not os.path.lexists(STATE_ROOT / "pending.json") and not os.path.lexists(COORDINATION_ROOT / "operation-pending.json"), "runtime-stage-pending")
        baseline = _initial(host, plan, draft)
        _once(STATE_ROOT / ("plan-" + plan["operation_id"] + ".json"), raw)
        _once(STATE_ROOT / ("approval-" + plan["operation_id"] + ".json"), approved_raw)
        _once(STATE_ROOT / "empty.env", b"# empty environment\n")
        for role in ("api", "web"):
            _once(STATE_ROOT / (role + "-" + plan["operation_id"] + ".json"), wire(draft[role]))
        if _host is None:
            host.preflight([(STATE_ROOT / ("api-" + plan["operation_id"] + ".json"), compiler.PROJECT),
                            (STATE_ROOT / ("web-" + plan["operation_id"] + ".json"), draft["web"]["name"])])
        semantics = plan["runtime_semantics"]
        _once(STATE_ROOT / ("runtime-" + plan["operation_id"] + ".json"), wire(semantics))
        barrier = {"version": 1, "operation": "web-runtime-stage", "id": plan["operation_id"],
                   "configuration_sha256": digest(wire(draft["request"]["originals"])), "stage_plan_sha256": digest(raw)}
        _once(COORDINATION_ROOT / "operation-pending.json", wire(barrier))
        pending = {"version": 1, "operation_id": plan["operation_id"], "plan_sha256": digest(raw), "started_at": current,
                   "original_approval_sha256": digest(approved_raw), "legacy_barrier_sha256": digest(wire(barrier)),
                   "phase": "starting", "intent": None, "targets": {}, "completed": [], "ready_pins": {},
                   "runtime_semantics_sha256": digest(wire(semantics))}
        expected_pending_raw = None

        def store_pending():
            nonlocal expected_pending_raw
            namespace()
            if expected_pending_raw is None:
                require(not os.path.lexists(STATE_ROOT / "pending.json"), "pending-changed")
            else:
                require(read(STATE_ROOT / "pending.json", private=True) == expected_pending_raw, "pending-changed")
            _save(STATE_ROOT / "pending.json", pending)
            expected_pending_raw = read(STATE_ROOT / "pending.json", private=True)

        store_pending()
        api_recovered = False

        def guard():
            namespace()
            require(read(STATE_ROOT / "pending.json", private=True) == expected_pending_raw, "pending-changed")
            require(read(plan_path, private=True) == raw and read(approval_path, private=True) == approved_raw, "approval-binding")
            authorization(approved_raw, STAGE_APPROVAL, int(time.time()) if now is None else now)
            _files(plan, draft)
            host.closed(plan["origin"])
            _barrier(pending)
            require(read(STATE_ROOT / "empty.env", private=True) == b"# empty environment\n"
                    and read(STATE_ROOT / ("runtime-" + plan["operation_id"] + ".json"), private=True) == wire(semantics), "stage-spec-changed")
            for role in ("api", "web"):
                require(read(STATE_ROOT / (role + "-" + plan["operation_id"] + ".json"), private=True) == wire(draft[role]), "stage-spec-changed")
            others = _baseline(host, plan, api_present=False,
                               allow_web_unhealthy="api-term" in pending["completed"] and not api_recovered)
            if "api-term" not in pending["completed"]:
                _baseline(host, plan)
            expected_ids = set(others) | set(pending["targets"].values())
            if "api-remove" not in pending["completed"]:
                expected_ids.add(plan["baseline"]["api"]["id"])
            require(host.inventory({compiler.PROJECT, draft["web"]["name"]}) == expected_ids, "inventory-changed")
            for role, ident in pending["targets"].items():
                target = host.inspect(ident)
                _target(host, target, role, compiler.PROJECT if role == "api" else draft["web"]["name"], plan, semantics[role],
                        created=target["State"].get("Status") == "created")
                if role in pending["ready_pins"]:
                    require(_pin(target, plan["baseline"][role]["source_sha"]) == pending["ready_pins"][role], "target-process-changed")

        def mutate(intent, action, verify=lambda value: None):
            guard()
            pending.update(phase="intent", intent=intent)
            store_pending()
            _emit(_checkpoint, "intent:" + intent)
            guard()
            value = action()
            _emit(_checkpoint, "accepted:" + intent)
            verify(value)
            pending["completed"].append(intent)
            pending.update(phase="done", intent=None)
            store_pending()
            _emit(_checkpoint, "done:" + intent)
            return value

        old = plan["baseline"]["api"]
        mutate("api-term", lambda: host.sigterm(old["id"]))
        exited = host.wait_exit(old["id"], old["started_at"], timeout=330)
        _clean(exited)
        require(exited.get("Id") == old["id"] and exited.get("Image") == old["image"]
                and exited["State"]["StartedAt"] == old["started_at"]
                and digest(wire(_semantic(exited, "api"))) == digest(wire(_semantic(baseline[old["id"]], "api"))), "api-process-changed")
        _detached(host, plan, old["id"])
        def remove_old():
            observed = host.inspect(old["id"])
            _clean(observed)
            require(observed["Id"] == old["id"] and observed["State"]["StartedAt"] == old["started_at"]
                    and digest(wire(_semantic(observed, "api"))) == semantics["api"], "api-process-changed")
            _detached(host, plan, old["id"])
            host.remove(old["id"])

        mutate("api-remove", remove_old)
        api_id = mutate("api-create", lambda: host.create(STATE_ROOT / ("api-" + plan["operation_id"] + ".json"), compiler.PROJECT, "api"),
                        lambda ident: _target(host, host.inspect(ident), "api", compiler.PROJECT, plan, semantics["api"], created=True))
        pending["targets"]["api"] = api_id
        mutate("api-start", lambda: host.start(api_id))
        api_ready = _wait_ready(host, api_id)
        _target(host, api_ready, "api", compiler.PROJECT, plan, semantics["api"])
        pending["ready_pins"]["api"] = _pin(api_ready, plan["baseline"]["api"]["source_sha"])
        host.probe(3000, plan["origin"])
        _wait_ready(host, plan["baseline"]["web"]["id"])
        api_recovered = True
        web_id = mutate("web-create", lambda: host.create(STATE_ROOT / ("web-" + plan["operation_id"] + ".json"), draft["web"]["name"], "web"),
                        lambda ident: _target(host, host.inspect(ident), "web", draft["web"]["name"], plan, semantics["web"], created=True))
        pending["targets"]["web"] = web_id
        mutate("web-start", lambda: host.start(web_id))
        web_ready = _wait_ready(host, web_id)
        _target(host, web_ready, "web", draft["web"]["name"], plan, semantics["web"])
        pending["ready_pins"]["web"] = _pin(web_ready, plan["baseline"]["web"]["source_sha"])
        targets = _desired(host, plan, draft, pending)
        guard()
        receipt = _receipt(plan, raw, pending, targets)
        _once(STATE_ROOT / ("prepared-" + plan["operation_id"] + ".json"), wire(receipt))
        pending.update(phase="prepared-closed", intent=None)
        store_pending()
        _emit(_checkpoint, "prepared-closed")
        return receipt


@_sanitized
def inspect_stage(plan_path, *, _host=None):
    _platform()
    raw = read(plan_path, private=True)
    plan = validate_plan(raw)
    if os.path.lexists(STATE_ROOT):
        w.protected(STATE_ROOT, directory=True, private=True)
    if not os.path.lexists(STATE_ROOT / "pending.json"):
        w.protected(COORDINATION_ROOT, directory=True, private=True)
        require(not os.path.lexists(COORDINATION_ROOT / "operation-pending.json"), "stage-state-indeterminate")
        evidence = [prefix + plan["operation_id"] + ".json" for prefix in ("plan-", "approval-", "api-", "web-", "runtime-", "prepared-")]
        require(not any(os.path.lexists(STATE_ROOT / name) for name in evidence), "stage-state-indeterminate")
        return {"status": "not-started", "runtime_changed": False}
    with _locked(readonly=True) as namespace:
        pending, pending_raw = _journal()
        require(pending["plan_sha256"] == digest(raw) and pending["operation_id"] == plan["operation_id"], "pending-binding")
        draft = load_draft(plan, pending["started_at"])
        host = _host or Host(plan)
        complete = False
        try:
            _desired(host, plan, draft, pending)
            complete = True
        except (StageError, OSError, w.WebSwitchError):
            require(not os.path.lexists(STATE_ROOT / ("prepared-" + plan["operation_id"] + ".json")), "prepared-target-unverified")
        namespace()
        return {"status": pending["phase"], "intent": pending["intent"], "operation_id": plan["operation_id"],
                "plan_sha256": digest(raw), "pending_sha256": digest(pending_raw), "desired_ready": complete,
                "legacy_barrier_retained": True, "traffic_opened": False}


@_sanitized
def adopt_prepared(plan_path, approval_path, *, allow_adopt=False, now=None, _host=None, _checkpoint=None):
    require(allow_adopt is True, "explicit-adopt-required")
    _platform()
    raw, approval_raw = read(plan_path, private=True), read(approval_path, private=True)
    plan = validate_plan(raw)
    approved = authorization(approval_raw, ADOPT_APPROVAL, int(time.time()) if now is None else now)
    with _locked() as namespace:
        pending, pending_raw = _journal()
        require(approved["operation_id"] == plan["operation_id"] == pending["operation_id"]
                and approved["plan_sha256"] == digest(raw) == pending["plan_sha256"]
                and approved["pending_sha256"] == digest(pending_raw), "approval-binding")
        draft = load_draft(plan, pending["started_at"])
        host = _host or Host(plan)
        targets = _desired(host, plan, draft, pending)
        namespace()
        require(read(plan_path, private=True) == raw and read(approval_path, private=True) == approval_raw
                and read(STATE_ROOT / "pending.json", private=True) == pending_raw, "approval-binding")
        authorization(approval_raw, ADOPT_APPROVAL, int(time.time()) if now is None else now)
        _once(STATE_ROOT / ("adopt-state-" + digest(approval_raw) + ".json"), pending_raw)
        _once(STATE_ROOT / ("adopt-" + digest(approval_raw) + ".json"), approval_raw)
        receipt_path = STATE_ROOT / ("prepared-" + plan["operation_id"] + ".json")
        if os.path.lexists(receipt_path):
            receipt = _validate_receipt(read(receipt_path, private=True), plan, pending, targets)
        else:
            receipt = _receipt(plan, raw, pending, targets, digest(approval_raw))
            _once(receipt_path, wire(receipt))
        pending.update(phase="prepared-closed", intent=None)
        namespace()
        require(read(STATE_ROOT / "pending.json", private=True) == pending_raw, "pending-changed")
        _save(STATE_ROOT / "pending.json", pending)
        _emit(_checkpoint, "prepared-closed")
        return receipt
