"""Internal AI-disabled API/Web replacement + read-only health, not full deploy.

Requires independent startup approval AND the live migration continuation.
start() retains pending. Only the internal live continuation can feed the separately
approved closed finish. No CLI, traffic/Worker opening or automatic rollback.
"""
import copy
from contextlib import contextmanager
import http.client
import os
from pathlib import Path, PurePosixPath
import tempfile
import threading
import time
from urllib.parse import urlsplit

import backup as b
import migrate as c
import migration_job as m
import prepare as p
import target as t
import worker as w

PROFILE = "citygo-api-web-disabled-v1"
MEMORY = 768 * 1024 * 1024
INSPECT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
           '"RestartCount":{{json .RestartCount}},"State":{{json .State}},'
           '"Config":{{json .Config}},"HostConfig":{{json .HostConfig}},'
           '"Mounts":{{json .Mounts}},"NetworkSettings":{{json .NetworkSettings}}}')


def api_secret(path):
    data = t.read_file(path)
    b.require(len(data) <= 16384, "start-secret")
    value = t.strict_json(data)
    b.require(type(value) is dict and {"DATABASE_URL"} <= set(value) <= {"DATABASE_URL", "ADMIN_USER_IDS"}, "start-secret")
    url = value["DATABASE_URL"]
    b.require(type(url) is str and not any(ord(ch) <= 32 for ch in url), "start-secret")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in ("postgres", "postgresql") and parsed.username == "citygo_api"
                 and bool(parsed.password) and parsed.hostname == "postgres" and parsed.port == 5432
                 and parsed.path == "/citygo_pilot" and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    b.require(valid, "start-secret")
    if "ADMIN_USER_IDS" in value:
        b.require(t.matches(value["ADMIN_USER_IDS"], r"[0-9a-f-]{36}(?:,[0-9a-f-]{36})*"), "start-secret")
    return data


def approval(data, now):
    value = t.strict_json(data)
    t.keys(value, {"version", "purpose", "profile", "migration_approval_sha256", "api_secret_sha256",
                   "web_network_id", "approved_at", "expires_at", "allow_start", "allow_traffic"}, "start-approval")
    b.require(type(value["version"]) is int and value["version"] == 1
              and value["purpose"] == "citygo-release-start" and value["profile"] == PROFILE
              and value["allow_start"] is True and value["allow_traffic"] is False, "start-approval")
    for key in ("migration_approval_sha256", "api_secret_sha256", "web_network_id"):
        b.require(t.matches(value[key], t.HASH), "start-approval")
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400, "start-expired")
    return value


class Approval:
    def __init__(self, path):
        self.path = Path(path)
        self._pin, self._failed = None, False

    def verify(self, selection, migration_authorization, config, target_sha, origin, images, secret_file):
        b.require(not self._failed, "start-approval-invalidated")
        try:
            b.require(type(selection) is t.Selection and type(migration_authorization) is c.Approval, "start-selection")
            b.require(self.path.is_absolute() and ".." not in self.path.parts
                      and self.path not in (selection.approval_file, migration_authorization.path)
                      and all(not self.path.is_relative_to(root) for root in
                              (selection.current_directory, selection.target_directory)), "start-self-approval")
            raw = t.read_file(self.path, private=True)
            approved = approval(raw, time.time())
            b.require(self._pin is None or self._pin == t.sha256(raw), "start-approval-changed")
            migration = migration_authorization.verify(selection, config, target_sha, origin, images)
            b.require(approved["migration_approval_sha256"] == migration["approval_sha256"]
                      and approved["api_secret_sha256"] == t.sha256(api_secret(secret_file)), "start-binding")
            b.require(t.read_file(self.path, private=True) == raw, "start-approval-changed")
            approval(raw, time.time())
            self._pin = t.sha256(raw)
            return {"approval_sha256": self._pin, "migration": migration,
                    "web_network_id": approved["web_network_id"], "api_secret_sha256": approved["api_secret_sha256"]}
        except Exception:
            self._failed = True
            raise


def compose_spec(project, origin, images, secret_file):
    # Fixed trusted profile, never execute candidate Compose, lifecycle hooks,
    # env_file, shell or inherited variables. Only two services, external nets.
    p.hostname(origin)
    secret_file = str(secret_file)
    b.require(PurePosixPath(secret_file).is_absolute() and ".." not in PurePosixPath(secret_file).parts
              and not any(ch in secret_file for ch in "$\r\n\0"), "start-secret-path")
    shared = {"init": True, "read_only": True, "user": "1000:1000", "restart": "no",
              "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "pids_limit": 128,
              "mem_limit": MEMORY, "memswap_limit": MEMORY, "tmpfs": ["/tmp:size=64m,mode=1777"],
              "entrypoint": ["node", "scripts/container-runtime.mjs"], "working_dir": "/app",
              "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}}
    api = {**copy.deepcopy(shared), "image": images["api"]["local_id"], "command": ["api"], "stop_grace_period": "330s",
           "environment": {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0", "API_PORT": "4000",
                           "WEB_ORIGIN": origin, "TRUSTED_PROXY_CIDRS": "172.30.92.10/32", "LLM_PROVIDER": "disabled"},
           "secrets": [{"source": "api_config", "target": "api.json"}],
           "networks": {"web_api": {"ipv4_address": "172.30.92.11"}, "database": {}}}
    web = {**copy.deepcopy(shared), "image": images["web"]["local_id"], "command": ["web"], "stop_grace_period": "30s",
           "environment": {"PORT": "3000"}, "ports": ["127.0.0.1:3000:3000"],
           "tmpfs": ["/tmp:size=64m,mode=1777", "/app/apps/web/.next/cache:size=64m,uid=1000,gid=1000"],
           "networks": {"web_api": {"ipv4_address": "172.30.92.10"}},
           "depends_on": {"api": {"condition": "service_healthy"}}}
    for role, service in (("api", api), ("web", web)):
        service["healthcheck"] = {"test": ["CMD", "node", "scripts/container-health.mjs", role],
                                  "interval": "5s", "timeout": "5s", "start_period": "15s", "retries": 12}
    return {"name": project, "services": {"api": api, "web": web},
            "secrets": {"api_config": {"file": secret_file}},
            "networks": {name: {"external": True, "name": project + "_" + name} for name in ("web_api", "database")}}


def health(status, headers, body, *, ready):
    b.require(len(body) <= 4096 and headers.get("content-type", "").startswith("application/json"), "start-health")
    value = t.strict_json(body)
    if ready:
        b.require(status == 200 and value == {"status": "ok"}, "start-health")
    else:
        b.require(status == 401 and type(value) is dict and value.get("code") == "UNAUTHENTICATED"
                  and value.get("contractVersion") == "1" and value.get("retryable") is False
                  and type(value.get("error")) is str and bool(value["error"])
                  and headers.get("x-citygo-contract-version") == "1"
                  and type(value.get("requestId")) is str and bool(value["requestId"])
                  and headers.get("x-request-id") == value["requestId"], "start-contract")


class Host(p.Host):
    def web_network(self):
        value = t.strict_json(self.capture(["network", "inspect", "--format",
            '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
            self.project + "_web_api"]).encode())
        b.require(value.get("Name") == self.project + "_web_api"
                  and value.get("Labels", {}).get("com.docker.compose.project") == self.project
                  and value.get("Labels", {}).get("com.docker.compose.network") == "web_api", "start-network")
        return {"id": value.get("Id"), "peers": sorted(value.get("Containers", {}))}

    def detail(self, ident):
        # Never persist this raw result (contains environment/engine health log).
        return t.strict_json(self.capture(["inspect", "--format", INSPECT, ident]).encode())

    def replace(self, directory, spec):
        path = directory / "start.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream: stream.write(m.wire(spec))
        (directory / "empty.env").write_bytes(b"# no inherited environment\n")
        self.capture(["compose", "--project-directory", str(directory), "--env-file", str(directory / "empty.env"),
                      "-p", self.project, "-f", str(path), "up", "--no-deps", "--no-build", "--pull", "never",
                      "--force-recreate", "--wait", "--wait-timeout", "150", "--timeout", "30", "api", "web"], timeout=240)

    def probe(self):
        # Direct loopback only; no DNS, redirects, proxy, registration or AI call.
        for path, ready, version in (("/api/ready", True, None), ("/api/v1/dashboard", False, "1"), ("/api/v1/dashboard", False, None)):
            connection = http.client.HTTPConnection("127.0.0.1", 3000, timeout=10)
            try:
                headers = {"Host": self.host, "X-Forwarded-Proto": "https", "Connection": "close"}
                if version is not None: headers["X-CityGo-Contract-Version"] = version
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                health(response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(4097), ready=ready)
            finally: connection.close()


def runtime(value, role, image, project, origin, secret_file, networks):
    cfg, host, state = value.get("Config", {}), value.get("HostConfig", {}), value.get("State", {})
    b.require(t.matches(value.get("Id"), t.HASH) and value.get("Image") in (image["local_id"], image["config_id"])
              and cfg.get("Image") == image["local_id"] and cfg.get("User") == "1000:1000"
              and cfg.get("Entrypoint") == ["node", "scripts/container-runtime.mjs"] and cfg.get("Cmd") == [role]
              and cfg.get("WorkingDir") == "/app", "start-runtime")
    labels = cfg.get("Labels", {})
    b.require(labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.service") == role
              and labels.get("com.docker.compose.oneoff") in ("False", "false"), "start-container")
    b.require(type(value.get("RestartCount")) is int and value["RestartCount"] == 0
              and state.get("Running") is True and state.get("Status") == "running"
              and all(state.get(k) is False for k in ("Paused", "Restarting", "OOMKilled", "Dead"))
              and state.get("Error") == "" and state.get("Health", {}).get("Status") == "healthy", "start-unhealthy")
    w.timestamp(state.get("StartedAt"))
    b.require(host.get("Init") is True and host.get("ReadonlyRootfs") is True and host.get("Privileged") is False
              and host.get("AutoRemove") is False and host.get("Memory") == MEMORY and host.get("MemorySwap") == MEMORY
              and host.get("PidsLimit") == 128 and host.get("CapDrop") == ["ALL"]
              and host.get("SecurityOpt") == ["no-new-privileges:true"] and host.get("RestartPolicy", {}).get("Name") == "no"
              and cfg.get("StopTimeout") == (330 if role == "api" else 30), "start-isolation")
    ports = host.get("PortBindings") or {}
    b.require(ports == ({} if role == "api" else {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}), "start-ports")
    mounts = value.get("Mounts", [])
    b.require(len(mounts) == (1 if role == "api" else 0), "start-mounts")
    if role == "api":
        mount = mounts[0]
        b.require(mount.get("Type") == "bind" and mount.get("Source") == str(secret_file)
                  and mount.get("Destination") == "/run/secrets/api.json" and mount.get("RW") is False, "start-mounts")
    env = cfg.get("Env", [])
    b.require(type(env) is list and all(type(e) is str and "=" in e for e in env), "start-environment")
    values = dict(e.split("=", 1) for e in env)
    allowed_env = {"PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "NEXT_TELEMETRY_DISABLED"}
    allowed_env |= ({"CITYGO_MOUNTED_CONFIG", "API_HOST", "API_PORT", "WEB_ORIGIN", "TRUSTED_PROXY_CIDRS", "LLM_PROVIDER"}
                    if role == "api" else {"PORT"})
    b.require(len(values) == len(env) and values.get("NODE_ENV") == "production"
              and set(values) <= allowed_env
              and not any(k in values for k in ("DATABASE_URL", "OPENAI_API_KEY", "ROUTERAI_API_KEY", "GIGACHAT_CREDENTIALS")), "start-environment")
    if role == "api":
        b.require(all(values.get(k) == v for k, v in {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0",
            "API_PORT": "4000", "WEB_ORIGIN": origin, "LLM_PROVIDER": "disabled", "TRUSTED_PROXY_CIDRS": "172.30.92.10/32"}.items()), "start-environment")
    attached = value.get("NetworkSettings", {}).get("Networks", {})
    expected = {project + "_web_api": networks["web_api"]}
    if role == "api": expected[project + "_database"] = networks["database"]
    b.require(set(attached) == set(expected) and all(attached[k].get("NetworkID") == v for k, v in expected.items())
              and attached[project + "_web_api"].get("IPAddress") == ("172.30.92.11" if role == "api" else "172.30.92.10"), "start-networks")
    return {"id": value["Id"], "image": value["Image"], "role": role, "started_at": state["StartedAt"]}


def start(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file, *,
          startup_authorization=None, allow_start=False, **options):
    b.require("authorization_check" not in options, "start-only")
    with _started_window(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file,
                         startup_authorization=startup_authorization, allow_start=allow_start, **options) as stage:
        result = copy.deepcopy(stage["result"])
    return result


@contextmanager
def _started_window(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file, *,
                    startup_authorization=None, allow_start=False, authorization_check=None, **options):
    b.require(allow_start is True and type(startup_authorization) is Approval, "explicit-start-permission-required")
    b.require("authorization_check" not in options, "start-only")
    config, images = copy.deepcopy(b.validate(config)), p.expected_images(images)
    api_secret_file = Path(api_secret_file)
    selected = options.get("selection"); migration_auth = options.get("authorization")
    approved = startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file)
    state = b.protected(config["state_dir"], directory=True)
    used = state / ("start-approval-" + approved["approval_sha256"] + ".used.json")
    reservation = None
    host_factory = options.setdefault("host_factory", Host)
    def check(*, initial=False):
        if authorization_check is not None: authorization_check()
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
        if reservation is None: b.require(not os.path.lexists(used), "start-approval-used")
        else: b.require(t.read_file(used, private=True) == reservation, "start-reservation-changed")
        # Read-only preflight, repeated at migration boundaries. A stale web
        # network approval must fail BEFORE pause/drain/backup/DDL, not after it.
        with tempfile.TemporaryDirectory(prefix=".start-preflight-", dir=state) as tmp:
            probe_host = host_factory(config, Path(tmp), ingress_directory, origin)
            values = probe_host.inventory()
            if initial:
                p.validate_inventory(values, config["project"], images, initial=True)
            apps = [v for v in values if v.get("Labels", {}).get("com.docker.compose.service") in ("api", "web")]
            b.require(len(apps) == 2 and {v["Labels"]["com.docker.compose.service"] for v in apps} == {"api", "web"}
                      and all(v["Labels"].get("com.docker.compose.project") == config["project"]
                              and t.matches(v.get("Id"), t.HASH) for v in apps), "start-container-set")
            allowed = {v["Id"] for v in apps}
            required = {v["Id"] for v in apps if v["State"]["Running"]}
            network = probe_host.web_network()
            b.require(network.get("id") == approved["web_network_id"], "start-network-changed")
            b.require(required <= set(network["peers"]) <= allowed, "start-network-peers")
        # The Docker read must not outlive a revoked/expired approval.
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
    check(initial=True)
    with c._migrated_window(config, target_sha, origin, ingress_directory, images, secret_file,
                            authorization_check=check, **options) as stage:
        window, host, migration = stage["window"], stage["host"], stage["result"]["migration"]
        stage["assert_migrated"]()
        before = host.inventory()
        baseline = {v["Id"]: v for v in before if v["Labels"]["com.docker.compose.service"] not in ("api", "web")}
        old_apps = {v["Labels"]["com.docker.compose.service"]: v["Id"] for v in before if v["Labels"]["com.docker.compose.service"] in ("api", "web")}
        network_ids = {"web_api": approved["web_network_id"], "database": stage["network"]["id"]}
        target_images = stage["proof"]["local_images"]["target"]
        spec = compose_spec(config["project"], origin, target_images, api_secret_file)
        def guard(*, final=False, cutover=False):
            if final:
                # Read-only receipt gate after context cleanup, NOT a resumed
                # release window or permission to mutate services/the database.
                b.verify_operation(state, window._operation)
                b.require(not os.path.lexists(state / w.ADMISSION), "worker-not-paused")
                if not cutover:
                    b.require(b.configuration_fingerprint(config) == window._operation["configuration_sha256"], "configuration-changed")
            else:
                window._check()
            if not cutover: stage["check_selection"]()
            host.assert_closed()
            values = host.inventory()
            retained = {v["Id"]: v for v in values if v.get("Id") in baseline}
            b.require(set(retained) == set(baseline), "start-retained-missing")
            p.same_inventory(baseline, retained)
            for ident, value in retained.items():
                b.require(p.evidence(value) == p.evidence(baseline[ident]), "start-retained-changed")
                if value["Labels"]["com.docker.compose.service"] == "postgres":
                    b.require(value["State"].get("Health", {}).get("Status") == "healthy", "start-postgres-unhealthy")
            apps = [v for v in values if v["Id"] not in baseline]
            b.require(len(apps) == 2 and {v["Labels"]["com.docker.compose.service"] for v in apps} == {"api", "web"}, "start-container-set")
            for name, network in (("database", host.database_network()), ("web_api", host.web_network())):
                allowed = {v["Id"] for v in values if (v["Labels"]["com.docker.compose.service"] != "web" if name == "database" else v in apps)}
                required = {v["Id"] for v in values if v["Id"] in allowed and v["State"]["Running"]}
                b.require(network["id"] == network_ids[name] and required <= set(network["peers"]) <= allowed, "start-network-changed")
            return apps
        guard()
        operation = window._operation["id"]
        reservation = m.wire({"version": 1, "operation_id": operation, "approval_sha256": approved["approval_sha256"],
                              "old_apps": old_apps, "spec_sha256": t.sha256(m.wire(spec)), "migration_container": migration["container_id"]})
        fd = os.open(used, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(reservation); stream.flush(); os.fsync(stream.fileno())
        b.sync_directory(state)
        guard()
        with tempfile.TemporaryDirectory(prefix=".start-", dir=state) as tmp:
            # Old API must STILL be drained immediately before Compose replaces
            # it. The post-start inventory guard intentionally allows new writers.
            stage["assert_migrated"]()
            host.replace(Path(tmp), spec)
            def verified_apps(*, final=False, cutover=False):
                result = {}
                for value in guard(final=final, cutover=cutover):
                    role = value["Labels"]["com.docker.compose.service"]
                    b.require(value["Id"] != old_apps[role], "start-not-replaced")
                    detail = host.detail(value["Id"])
                    b.require(detail.get("Id") == value["Id"], "start-container-replaced")
                    result[role] = runtime(detail, role, target_images[role], config["project"], origin, api_secret_file, network_ids)
                return result
            started = verified_apps()
            host.probe()
            b.require(verified_apps() == started, "start-process-changed")
        guard()
        proof = {"version": 1, "operation_id": operation, "target_sha": target_sha, "approval_sha256": approved["approval_sha256"],
                 "apps": started, "health": {"ready": True, "v1_unauthorized": True, "legacy_unauthorized": True},
                 "traffic_authorized": False, "worker_authorized": False}
        result = {**stage["result"], "startup": proof}
    # The enclosing preparation context performs final authorization/file
    # checks on exit. Never leave success evidence if that finalization fails.
    with b.lock(state):
        with tempfile.TemporaryDirectory(prefix=".start-receipt-", dir=state) as tmp:
            host = host_factory(config, Path(tmp), ingress_directory, origin)
            b.require(verified_apps(final=True) == started, "start-process-changed")
            host.probe()
            b.require(verified_apps(final=True) == started, "start-process-changed")
        # Engine/HTTP reads and cleanup must not outlive an independently
        # revoked/expired approval. This last authorization read does no I/O
        # to Docker or the application.
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
        if authorization_check is not None: authorization_check()
        b.atomic_json(state / ("start-" + operation + ".success.json"), proof)
        # Only this live owner may continue. A saved startup receipt is evidence,
        # never permission to finish/retry an interrupted release.
        active = True
        owner = (os.getpid(), threading.get_ident())
        def recheck(*, cutover=False):
            nonlocal host
            b.require(active and owner == (os.getpid(), threading.get_ident()), "start-window-inactive")
            with tempfile.TemporaryDirectory(prefix=".finish-health-", dir=state) as tmp:
                host = host_factory(config, Path(tmp), ingress_directory, origin)
                b.require(verified_apps(final=True, cutover=cutover) == started, "start-process-changed")
                host.probe()
                b.require(verified_apps(final=True, cutover=cutover) == started, "start-process-changed")
            if not cutover: check()
        try:
            yield {"result": copy.deepcopy(result), "operation": copy.deepcopy(window._operation), "recheck": recheck}
        finally:
            active = False
