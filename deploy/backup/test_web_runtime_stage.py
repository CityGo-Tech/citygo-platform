"""Synthetic Host + protected filesystem tests; never Docker or server access.

Accepted-command failures are deliberately ambiguous. Re-executing a stage or
adopting a partial topology must never issue another Docker mutation.
"""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_web_bootstrap as compiler_fixture
import web_bootstrap as compiler
import web_switch as switch


INTENTS = ("api-term", "api-remove", "api-create", "api-start", "web-create", "web-start")
MIB = 1024 ** 2


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def semantic_fingerprint(item):
    """Independent definition of the operator-pinned original runtime view."""
    config = copy.deepcopy(item["Config"])
    config.pop("Hostname", None)
    config.pop("Labels", None)
    config["Env"] = dict(value.split("=", 1) for value in config.get("Env", []))
    host = copy.deepcopy(item["HostConfig"])
    if "OomKillDisable" in host and (host["OomKillDisable"] is None or host["OomKillDisable"] is False):
        host["OomKillDisable"] = False
    value = {"Config": config, "HostConfig": host, "Mounts": item.get("Mounts", [])}
    return digest((json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode())


def write(path, raw, mode=0o600):
    path = Path(path)
    if path.exists():
        path.chmod(0o600)
    path.write_bytes(raw)
    path.chmod(mode)


def snapshot(root):
    result = {}
    for path in [root, *sorted(root.rglob("*"))]:
        meta = path.lstat()
        item = (stat.S_IMODE(meta.st_mode), meta.st_uid, meta.st_gid, meta.st_nlink)
        if stat.S_ISREG(meta.st_mode):
            item += (path.read_bytes(),)
        elif stat.S_ISLNK(meta.st_mode):
            item += (os.readlink(path),)
        result[str(path.relative_to(root))] = item
    return result


def runtime_record(spec, role, ident, project, source, networks, secrets, *, running=True, operation=None):
    """Independent Docker-inspect example constructed from a strict Compose service."""
    service = spec["services"][role]
    labels = {"com.docker.compose.project": project, "com.docker.compose.service": role,
              "com.docker.compose.oneoff": "False", "com.docker.compose.container-number": "1",
              "org.opencontainers.image.revision": source}
    if operation:
        labels["citygo.web-runtime-stage"] = operation
    env = [f"{key}={value}" for key, value in service.get("environment", {}).items()]
    tmpfs = {}
    for item in service.get("tmpfs", []):
        destination, options = item.split(":", 1)
        tmpfs[destination] = options
    ports = {}
    for item in service.get("ports", []):
        host, port, target = item.split(":")
        ports[target + "/tcp"] = [{"HostIp": host, "HostPort": port}]
    mounts = []
    for secret in service.get("secrets", []):
        name = secret if isinstance(secret, str) else secret["source"]
        target = name if isinstance(secret, str) else secret.get("target", name)
        mounts.append({"Type": "bind", "Source": secrets[name]["file"],
                       "Destination": "/run/secrets/" + target, "Mode": "ro", "RW": False,
                       "Propagation": "rprivate"})
    for mount in service.get("volumes", []):
        mounts.append({"Type": mount["type"], "Source": mount["source"],
                       "Destination": mount["target"], "Mode": "ro", "RW": not mount["read_only"],
                       "Propagation": "rprivate"})
    service_networks = service.get("networks", {})
    if isinstance(service_networks, list):
        service_networks = {key: {} for key in service_networks}
    endpoints = {}
    for key, settings in service_networks.items():
        net = networks[key]
        ip = settings.get("ipv4_address", "172.30.93.12" if role == "api" else "172.30.93.13")
        endpoints[net["name"]] = {"NetworkID": net["id"], "IPAddress": ip if running else "",
                                  "Aliases": [role, project + "-" + role + "-1"],
                                  "IPAMConfig": {"IPv4Address": settings["ipv4_address"]}
                                  if "ipv4_address" in settings else None}
    health = service.get("healthcheck")
    config = {"Image": service["image"], "Labels": labels, "Env": env,
              "User": service.get("user", ""), "WorkingDir": service.get("working_dir", ""),
              "Entrypoint": service.get("entrypoint"), "Cmd": service.get("command"),
              "Hostname": ident[:12], "StopTimeout": int(service.get("stop_grace_period", "30s")[:-1]),
              "OpenStdin": False, "Tty": False}
    if health:
        config["Healthcheck"] = {"Test": health["test"], "Interval": 5_000_000_000,
                                 "Timeout": 5_000_000_000, "StartPeriod": 15_000_000_000,
                                 "Retries": health["retries"]}
    state = {"Status": "running" if running else "exited", "Running": running, "Paused": False,
             "Restarting": False, "OOMKilled": False, "Dead": False, "Error": "", "ExitCode": 0,
             "StartedAt": "2026-11-09T00:00:00.000000000Z", "FinishedAt": "2026-11-09T00:01:00.000000000Z"}
    if health:
        state["Health"] = {"Status": "healthy"}
    return {"Id": ident, "Name": "/" + project + "-" + role + "-1", "Image": service["image"],
            "Created": "2026-11-09T00:00:00.000000000Z", "Config": config,
            "HostConfig": {"Memory": service.get("mem_limit", 1024 * MIB),
                           "MemorySwap": service.get("memswap_limit", 1024 * MIB),
                           "ReadonlyRootfs": service.get("read_only", True), "Privileged": False,
                           "OomKillDisable": None,
                           "Init": service.get("init", True), "CapDrop": service.get("cap_drop", ["ALL"]),
                           "SecurityOpt": service.get("security_opt", ["no-new-privileges:true"]),
                           "PidsLimit": service.get("pids_limit", 128), "Tmpfs": tmpfs,
                           "LogConfig": {"Type": service.get("logging", {}).get("driver", "json-file"),
                                         "Config": service.get("logging", {}).get("options", {})},
                           "RestartPolicy": {"Name": service.get("restart", "no"), "MaximumRetryCount": 0},
                           "PortBindings": ports}, "Mounts": mounts, "RestartCount": 0,
            "NetworkSettings": {"Networks": endpoints, "Ports": copy.deepcopy(ports) if running else {}},
            "State": state}


class FakeHost:
    """All external effects are in-memory and can fail after being accepted."""
    def __init__(self, module, plan, records, images):
        self.module, self.plan = module, plan
        self.records, self.images = records, images
        self.calls, self.mutations = [], []
        self.fail_after = None
        self.closed_ok = True
        self.probe_ok = True
        self.stop_exit = 0
        self.stop_hangs = False
        self.ready_after = 0
        self.health_reads = {}
        self.created_oom_kill_disable = False
        self.resource = {"total_bytes": 4096 * MIB, "available_bytes": 1024 * MIB,
                         "swap_used_bytes": 0, "pressure_full_avg10": 0.0, "free_bytes": 10 * 1024 ** 3}

    def event(self, name):
        self.calls.append(name)

    def mutated(self, name):
        self.mutations.append(name)
        if self.fail_after == name:
            raise self.module.StageError("synthetic-command-uncertain")

    def inventory(self, projects):
        self.event("inventory")
        return {ident for ident, item in self.records.items()
                if item["Config"]["Labels"]["com.docker.compose.project"] in projects}

    def inspect(self, ident):
        self.event("inspect:" + ident)
        if ident not in self.records:
            raise self.module.StageError("container-unavailable")
        if ident in self.health_reads:
            self.health_reads[ident] += 1
            if self.health_reads[ident] >= self.ready_after:
                self.records[ident]["State"]["Health"]["Status"] = "healthy"
        return copy.deepcopy(self.records[ident])

    def image(self, ident):
        self.event("image:" + ident)
        return copy.deepcopy(self.images[ident])

    def network(self, ident):
        self.event("network:" + ident)
        net = next(value for value in self.plan["networks"].values() if value["id"] == ident)
        peers = {}
        for cid, item in self.records.items():
            if not item["State"]["Running"]:
                continue
            for endpoint in item["NetworkSettings"]["Networks"].values():
                if endpoint["NetworkID"] == ident:
                    peers[cid] = endpoint["IPAddress"]
        return {"id": ident, "name": net["name"], "peers": peers}

    def closed(self, origin):
        self.event("closed")
        if not self.closed_ok:
            raise self.module.StageError("ingress-not-closed")

    def probe(self, port, origin):
        self.event("probe:" + str(port))
        if not self.probe_ok:
            raise self.module.StageError("probe-failed")

    def resources(self):
        self.event("resources")
        return copy.deepcopy(self.resource)

    def sigterm(self, ident):
        self.event("sigterm:" + ident)
        if not self.stop_hangs:
            self.records[ident]["State"].update(Status="exited", Running=False, ExitCode=self.stop_exit)
            for endpoint in self.records[ident]["NetworkSettings"]["Networks"].values():
                endpoint["IPAddress"] = ""
            self.records[ident]["NetworkSettings"]["Ports"] = {}
        self.mutated("api-term")

    def wait_exit(self, ident, started_at, timeout=330):
        self.event("wait-exit:" + ident)
        if self.stop_hangs:
            raise self.module.StageError("api-drain-timeout")
        return self.inspect(ident)

    def remove(self, ident):
        self.event("remove:" + ident)
        if self.records[ident]["State"]["Running"]:
            raise AssertionError("The fake refuses removing a running API")
        del self.records[ident]
        self.mutated("api-remove")

    def create(self, spec_path, project, role):
        self.event("create:" + role)
        spec = json.loads(Path(spec_path).read_bytes())
        if spec["services"][role].get("labels", {}).get("citygo.web-runtime-stage") != self.plan["operation_id"]:
            raise AssertionError("The admitted Compose spec must carry the ownership label")
        ident = ("c" if role == "api" else "d") * 64
        networks = {"web_api": self.plan["networks"]["web"], "database": self.plan["networks"]["database"]}
        item = runtime_record(spec, role, ident, project, self.plan["baseline"][role if role == "api" else "web"]["source_sha"],
                              networks, spec.get("secrets", {}), running=False,
                              operation=self.plan["operation_id"])
        item["State"].update(Status="created", StartedAt="0001-01-01T00:00:00Z", FinishedAt="0001-01-01T00:00:00Z")
        if self.created_oom_kill_disable == "__missing__":
            del item["HostConfig"]["OomKillDisable"]
        else:
            item["HostConfig"]["OomKillDisable"] = self.created_oom_kill_disable
        self.records[ident] = item
        self.mutated(role + "-create")
        return ident

    def start(self, ident):
        role = self.records[ident]["Config"]["Labels"]["com.docker.compose.service"]
        self.event("start:" + ident)
        item = self.records[ident]
        item["State"].update(Status="running", Running=True, StartedAt="2026-11-09T01:00:00.000000000Z")
        if self.ready_after:
            item["State"]["Health"]["Status"] = "starting"
            self.health_reads[ident] = 0
        for endpoint in item["NetworkSettings"]["Networks"].values():
            desired = (endpoint.get("IPAMConfig") or {}).get("IPv4Address")
            endpoint["IPAddress"] = desired or "172.30.93.12"
        item["NetworkSettings"]["Ports"] = copy.deepcopy(item["HostConfig"]["PortBindings"])
        self.mutated(role + "-start")

    def find(self, project, role, opid):
        self.event("find:" + role)
        return [ident for ident, item in self.records.items()
                if item["Config"]["Labels"].get("com.docker.compose.project") == project
                and item["Config"]["Labels"].get("com.docker.compose.service") == role
                and item["Config"]["Labels"].get("citygo.web-runtime-stage") == opid]


def fixture(root, module, *, empty_env=False):
    """Synthetic public fixture for CLI/rehearsal users, not live evidence."""
    root = Path(root)
    source = root / "originals"
    source.mkdir(mode=0o700)
    canonical_raw, request, now = compiler_fixture.fixture()
    canonical = json.loads(canonical_raw)
    for name in canonical["secrets"]:
        path = source / (name + ".fixture")
        write(path, b"synthetic-private-config-never-executed\n")
        canonical["secrets"][name]["file"] = str(path)
    canonical["services"]["backup"]["volumes"][0]["source"] = str(source / "dump.sh")
    write(source / "dump.sh", b"# inert synthetic dump\n")
    canonical_raw = encoded(canonical)
    for name, pin in request["originals"].items():
        path = source / ("compose.json" if name == "compose" else name + ".fixture")
        raw = canonical_raw if name == "compose" else b"synthetic-original-" + name.encode() + b"\n"
        if name == "env" and empty_env:
            raw = b""
        write(path, raw)
        pin.update(path=str(path), sha256=digest(raw))
    request["secret_pins"] = [{"path": value["file"], "sha256": digest(Path(value["file"]).read_bytes())}
                              for value in canonical["secrets"].values()]
    bundle = root / "draft"
    bundle.mkdir(mode=0o700)
    outputs = compiler.compile_draft(canonical_raw, encoded(request), now)
    for name, raw in outputs.items():
        write(bundle / name, raw)
    networks = {"web": {"id": "9" * 64, "name": "citygo-pilot_web_api"},
                "database": {"id": "e" * 64, "name": "citygo-pilot_database"}}
    logical = {"web_api": networks["web"], "database": networks["database"]}
    records = {}
    for role, ident in (("api", "5" * 64), ("web", "6" * 64)):
        records[ident] = runtime_record(canonical, role, ident, "citygo-pilot", request["source_sha"],
                                        logical, canonical["secrets"])
    postgres_id = "7" * 64
    pg_spec = {"services": {"postgres": {"image": "sha256:" + "4" * 64, "user": "postgres",
               "restart": "unless-stopped", "networks": ["database"], "mem_limit": 1024 * MIB,
               "memswap_limit": 1024 * MIB}}}
    records[postgres_id] = runtime_record(pg_spec, "postgres", postgres_id, "citygo-pilot",
                                          request["source_sha"], logical, {})
    records[postgres_id]["State"]["Health"] = {"Status": "healthy"}
    records[postgres_id]["NetworkSettings"]["Networks"][networks["database"]["name"]]["IPAddress"] = "172.30.93.10"
    def cp(role):
        ident = {"api": "5", "web": "6", "postgres": "7"}[role] * 64
        item = records[ident]
        return {"id": ident, "image": item["Image"], "source_sha": request["source_sha"],
                "project": "citygo-pilot", "service": role, "started_at": item["State"]["StartedAt"],
                "runtime_sha256": switch.runtime_fingerprint(item)}
    backup, restore = source / "backup-evidence.json", source / "restore-evidence.json"
    for path in (backup, restore):
        write(path, b"synthetic-operator-attestation-not-live-proof\n")
    def pin(path):
        return {"path": str(path), "sha256": digest(path.read_bytes())}
    plan = {"version": 1, "purpose": "citygo-web-runtime-stage-v1", "operation_id": request["operation_id"],
            "origin": request["origin"], "observed_at": now - 5, "expires_at": now + 600,
            "draft_dir": str(bundle), "draft_sha256": digest(outputs["draft.json"]),
            "baseline": {"api": cp("api"), "web": cp("web"), "postgres": cp("postgres"), "jobs": []},
            "networks": networks, "files": [*copy.deepcopy(list(request["originals"].values())),
                                             *copy.deepcopy(request["secret_pins"]), pin(backup), pin(restore)],
            "attestation": {"drained": True, "backup": pin(backup), "restore": pin(restore), "observed_at": now - 5}}
    plan["runtime_semantics"] = {role: semantic_fingerprint(records[plan["baseline"][role]["id"]])
                                 for role in ("api", "web")}
    plan_path = root / "stage-plan.json"
    write(plan_path, encoded(plan))
    approval = {"version": 1, "purpose": "citygo-web-runtime-stage-approval-v1", "operation_id": plan["operation_id"],
                "plan_sha256": digest(plan_path.read_bytes()), "approved_at": now - 1,
                "expires_at": now + 600, "allow_stage": True}
    approval_path = root / "stage-approval.json"
    write(approval_path, encoded(approval))
    images = {item["Image"]: {"Id": item["Image"], "Config": {
        "Labels": {"org.opencontainers.image.revision": request["source_sha"]}}} for item in records.values()}
    return plan_path, approval_path, FakeHost(module, plan, records, images), now


class Halt(BaseException):
    """Private checkpoint only; not a user controlled recovery hook."""


class InertImport(unittest.TestCase):
    def test_import_does_not_spawn_query_network_or_write_files(self):
        path = Path(__file__).with_name("web_runtime_stage.py")
        code = compile(path.read_bytes(), str(path), "exec")
        namespace = {"__name__": "private_inert_runtime_stage", "__file__": str(path)}
        with patch.object(subprocess, "run") as run, patch.object(subprocess, "Popen") as popen, \
                patch.object(Path, "write_bytes") as write_bytes, patch.object(Path, "mkdir") as mkdir, \
                patch.object(switch._TLS, "connect") as tls:
            exec(code, namespace)
        run.assert_not_called()
        popen.assert_not_called()
        write_bytes.assert_not_called()
        mkdir.assert_not_called()
        tls.assert_not_called()


@unittest.skipUnless(sys.platform.startswith("linux") and hasattr(os, "geteuid") and os.geteuid() == 0,
                     "Mandatory protected-filesystem suite requires Linux root")
class Stage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-runtime-stage-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        trusted = self.root / "trusted"
        trusted.mkdir(mode=0o700)
        # CI checkout ownership is deliberately NOT a trusted execution root.
        # Copy each unchanged dependency and import it under its real name only
        # while building this private graph. Restore the caller's module cache.
        dependency_names = ("backup", "web_switch_assets", "web_switch", "web_bootstrap")
        sources = {}
        for module_name in (*dependency_names, "web_runtime_stage"):
            filename = module_name + ".py"
            raw = Path(__file__).with_name(filename).read_bytes()
            target = trusted / filename
            write(target, raw, 0o644)
            self.assertEqual(target.read_bytes(), raw)
            self.assertEqual(target.stat().st_uid, 0)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            sources[module_name] = raw
        path = trusted / "web_runtime_stage.py"
        name = "private_runtime_stage_" + str(id(self))
        saved = {key: sys.modules.get(key) for key in dependency_names}
        try:
            with patch.object(sys, "dont_write_bytecode", True):
                for module_name in (*dependency_names, name):
                    target = trusted / (("web_runtime_stage" if module_name == name else module_name) + ".py")
                    spec = importlib.util.spec_from_file_location(module_name, target)
                    loaded = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = loaded
                    spec.loader.exec_module(loaded)
                    if module_name == name:
                        self.module = loaded
        finally:
            for module_name, original in saved.items():
                if original is None:
                    sys.modules.pop(module_name, None)
                else:
                    sys.modules[module_name] = original
        self.addCleanup(sys.modules.pop, name, None)
        self.assertEqual(path.read_bytes(), sources["web_runtime_stage"])
        self.assertEqual(self.module.w.__file__, str(trusted / "web_switch.py"))
        self.assertEqual(self.module.w.b.__file__, str(trusted / "backup.py"))
        self.assertEqual(self.module.w.assets.__file__, str(trusted / "web_switch_assets.py"))
        self.assertEqual(self.module.compiler.__file__, str(trusted / "web_bootstrap.py"))
        self.state, self.coordination = self.root / "state", self.root / "coordination"
        self.ingress = self.root / "ingress"
        for directory in (self.state, self.coordination, self.ingress):
            directory.mkdir(mode=0o700)
        self.module.STATE_ROOT = self.state
        self.module.COORDINATION_ROOT = self.coordination
        self.module.TRAFFIC_MARKER = self.ingress / "traffic-open"
        for name in ("maintenance.lock", "worker-admission.lock"):
            write(self.coordination / name, b"")
        self.plan_path, self.cap_path, self.host, self.now = fixture(self.root, self.module)
        self.plan = json.loads(self.plan_path.read_bytes())
        self.originals_before = snapshot(self.root / "originals")

    def stage(self, **kwargs):
        return self.module.stage(self.plan_path, self.cap_path, allow_stage=True, now=self.now,
                                 _host=self.host, **kwargs)

    def inspect(self):
        return self.module.inspect_stage(self.plan_path, _host=self.host)

    def rewrite_plan(self, mutate):
        value = json.loads(self.plan_path.read_bytes())
        mutate(value)
        write(self.plan_path, encoded(value))
        self.plan = value
        self.host.plan = value
        cap = json.loads(self.cap_path.read_bytes())
        cap["plan_sha256"] = digest(self.plan_path.read_bytes())
        write(self.cap_path, encoded(cap))

    def assert_unchanged_originals(self):
        self.assertEqual(snapshot(self.root / "originals"), self.originals_before)
        self.assertFalse(self.module.TRAFFIC_MARKER.exists())

    def assert_rejected_without_mutation(self, operation=None):
        before = list(self.host.mutations)
        with self.assertRaises(self.module.StageError):
            (operation or self.stage)()
        self.assertEqual(self.host.mutations, before)

    @contextmanager
    def isolated(self, name, **fixture_options):
        root = self.root / name
        root.mkdir(mode=0o700)
        plan_path, cap_path, host, now = fixture(root, self.module, **fixture_options)
        state, coordination = root / "state", root / "coordination"
        state.mkdir(mode=0o700)
        coordination.mkdir(mode=0o700)
        with patch.object(self.module, "STATE_ROOT", state), \
                patch.object(self.module, "COORDINATION_ROOT", coordination):
            yield root, plan_path, cap_path, host, now, state, coordination

    def adopt_cap(self, plan_path=None, *, now=None):
        plan_path = plan_path or self.plan_path
        now = self.now + 601 if now is None else now
        observed = self.module.inspect_stage(plan_path, _host=self.host)
        value = {"version": 1, "purpose": "citygo-web-runtime-stage-adopt-v1",
                 "operation_id": json.loads(plan_path.read_bytes())["operation_id"],
                 "plan_sha256": digest(plan_path.read_bytes()), "pending_sha256": observed["pending_sha256"],
                 "approved_at": now - 1, "expires_at": now + 600, "allow_adopt": True}
        path = plan_path.with_name("adopt-approval.json")
        write(path, encoded(value))
        return path, now

    def test_stage_exact_six_mutations_preserves_old_web_postgres_and_files(self):
        old = {key: copy.deepcopy(self.host.records[self.plan["baseline"][key]["id"]])
               for key in ("web", "postgres")}
        result = self.stage()
        self.assertEqual(self.host.mutations, list(INTENTS))
        self.assertEqual(result["status"], "prepared-closed")
        self.assertIs(result["legacy_barrier_retained"], True)
        self.assertIs(result["traffic_opened"], False)
        self.assertIs(result["nginx_changed"], False)
        self.assertTrue((self.coordination / "operation-pending.json").is_file())
        for key, expected in old.items():
            self.assertEqual(self.host.records[self.plan["baseline"][key]["id"]], expected)
        self.assert_unchanged_originals()
        self.assert_rejected_without_mutation()

    def test_explicitly_pinned_empty_canonical_environment_runs_exact_six_commands(self):
        with self.isolated("approved-empty-environment", empty_env=True) as (root, plan_path, cap_path, host, now, _, coordination):
            plan = json.loads(plan_path.read_bytes())
            request = json.loads((Path(plan["draft_dir"]) / "request.original.json").read_bytes())
            pin = request["originals"]["env"]
            self.assertEqual(Path(pin["path"]).read_bytes(), b"")
            self.assertEqual(pin["sha256"], digest(b""))
            self.assertIn(pin, plan["files"])
            before = snapshot(root / "originals")
            result = self.module.stage(plan_path, cap_path, allow_stage=True, now=now, _host=host)
            self.assertEqual(result["status"], "prepared-closed")
            self.assertEqual(host.mutations, list(INTENTS))
            self.assertEqual(snapshot(root / "originals"), before)
            self.assertTrue((coordination / "operation-pending.json").is_file())
            self.assertFalse(self.module.TRAFFIC_MARKER.exists())

    def test_null_oom_kill_disable_baseline_and_false_created_target_have_same_semantics(self):
        old_api = self.host.records[self.plan["baseline"]["api"]["id"]]
        self.assertIsNone(old_api["HostConfig"]["OomKillDisable"])
        alternative = copy.deepcopy(old_api)
        alternative["HostConfig"]["OomKillDisable"] = False
        self.assertEqual(semantic_fingerprint(old_api), semantic_fingerprint(alternative))
        result = self.stage()
        self.assertEqual(result["status"], "prepared-closed")
        self.assertEqual(self.host.mutations, list(INTENTS))
        self.assertIs(self.host.records["c" * 64]["HostConfig"]["OomKillDisable"], False)
        self.assertIs(self.host.records["d" * 64]["HostConfig"]["OomKillDisable"], False)

    def test_true_missing_or_nonboolean_oom_kill_disable_refused_before_new_api_start(self):
        for index, value in enumerate((True, 0, 1, "false", "__missing__")):
            with self.subTest(value=value):
                with self.isolated("invalid-created-oom-" + str(index)) as (_, plan_path, cap_path, host, now, _, coordination):
                    host.created_oom_kill_disable = value
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now, _host=host)
                    self.assertEqual(host.mutations, ["api-term", "api-remove", "api-create"])
                    self.assertIs(host.records["c" * 64]["State"]["Running"], False)
                    self.assertTrue((coordination / "operation-pending.json").is_file())

    def test_explicit_stage_boolean_required_before_any_mutation(self):
        for flag in (False, None, 1, "true"):
            with self.subTest(flag=flag):
                self.assert_rejected_without_mutation(lambda: self.module.stage(
                    self.plan_path, self.cap_path, allow_stage=flag, now=self.now, _host=self.host))

    def test_inspect_is_read_only_without_creating_state(self):
        before = snapshot(self.root)
        self.inspect()
        self.inspect()
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual(self.host.mutations, [])

    def test_expired_or_unbound_capability_rejected(self):
        original = self.cap_path.read_bytes()
        for key, bad in (("expires_at", self.now), ("plan_sha256", "f" * 64),
                         ("operation_id", "0" * 32), ("allow_stage", 1), ("unknown", False)):
            with self.subTest(key=key):
                value = json.loads(original)
                value[key] = bad
                write(self.cap_path, encoded(value))
                self.assert_rejected_without_mutation()
        write(self.cap_path, original)

    def test_plan_requires_drained_fresh_attestation_and_exact_schema(self):
        for mutate in (lambda p: p["attestation"].update(drained=False),
                       lambda p: p["attestation"].update(drained=1),
                       lambda p: p.update(expires_at=self.now),
                       lambda p: p["runtime_semantics"].update(api="f" * 64),
                       lambda p: p.update(unknown=True)):
            with self.subTest(mutate=mutate):
                original, cap = self.plan_path.read_bytes(), self.cap_path.read_bytes()
                self.rewrite_plan(mutate)
                self.assert_rejected_without_mutation()
                write(self.plan_path, original)
                write(self.cap_path, cap)
                self.host.plan = json.loads(original)

    def test_open_ingress_or_worker_admission_and_legacy_pending_refused(self):
        for path, raw in ((self.module.TRAFFIC_MARKER, b"open\n"),
                          (self.coordination / "worker-admission.json", b"{}\n"),
                          (self.coordination / "operation-pending.json", b"{}\n")):
            with self.subTest(path=path.name):
                write(path, raw)
                self.assert_rejected_without_mutation()
                path.unlink()

    def test_failed_closed_probe_and_insufficient_resources_refused(self):
        self.host.closed_ok = False
        self.assert_rejected_without_mutation()
        self.host.closed_ok = True
        for key, value in (("total_bytes", 3000 * MIB), ("available_bytes", 100 * MIB),
                           ("swap_used_bytes", MIB), ("pressure_full_avg10", 2.0), ("free_bytes", MIB)):
            with self.subTest(key=key):
                before = self.host.resource[key]
                self.host.resource[key] = value
                self.assert_rejected_without_mutation()
                self.host.resource[key] = before

    def test_changed_original_secret_and_image_revision_refused(self):
        path = Path(self.plan["files"][0]["path"])
        raw = path.read_bytes()
        write(path, raw + b"tampered\n")
        self.assert_rejected_without_mutation()
        write(path, raw)
        image = self.host.images[self.plan["baseline"]["api"]["image"]]
        image["Config"]["Labels"]["org.opencontainers.image.revision"] = "f" * 40
        self.assert_rejected_without_mutation()

    def test_runtime_drift_restart_and_foreign_network_peer_refused(self):
        ident = self.plan["baseline"]["api"]["id"]
        original = copy.deepcopy(self.host.records[ident])
        for mutate in (lambda i: i.update(RestartCount=1),
                       lambda i: i["State"].update(StartedAt="2026-11-09T02:00:00Z"),
                       lambda i: i["HostConfig"].update(Privileged=True),
                       lambda i: i["Config"]["Env"].append("UNKNOWN=unsafe")):
            with self.subTest(mutate=mutate):
                mutate(self.host.records[ident])
                self.assert_rejected_without_mutation()
                self.host.records[ident] = copy.deepcopy(original)
        foreign = copy.deepcopy(original)
        foreign["Id"] = "f" * 64
        foreign["Config"]["Labels"]["com.docker.compose.project"] = "unmanaged-project"
        self.host.records[foreign["Id"]] = foreign
        self.assert_rejected_without_mutation()

    def test_active_jobs_rejected_even_if_pinned(self):
        job = copy.deepcopy(self.host.records[self.plan["baseline"]["api"]["id"]])
        job["Id"] = "f" * 64
        job["Config"]["Labels"]["com.docker.compose.service"] = "worker"
        self.host.records[job["Id"]] = job
        pin = copy.deepcopy(self.plan["baseline"]["api"])
        pin.update(id=job["Id"], service="worker", runtime_sha256=switch.runtime_fingerprint(job))
        self.rewrite_plan(lambda p: p["baseline"]["jobs"].append(pin))
        self.assert_rejected_without_mutation()

    def test_bad_drain_never_removes_api(self):
        for hanging, exitcode in ((True, 0), (False, 1)):
            with self.subTest(hanging=hanging):
                with self.isolated("drain-" + str(hanging)) as (_, plan_path, cap_path, host, now, _, coordination):
                    host.stop_hangs, host.stop_exit = hanging, exitcode
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now, _host=host)
                    self.assertEqual(host.mutations, ["api-term"])
                    self.assertTrue((coordination / "operation-pending.json").exists())
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now, _host=host)
                    self.assertEqual(host.mutations, ["api-term"])

    def test_intents_are_durable_before_each_command_and_accepted_failures_never_replay(self):
        # A fresh isolated fixture per intent keeps previous uncertainty intact.
        for intent in INTENTS:
            with self.subTest(intent=intent):
                with self.isolated("case-" + intent) as (_, plan_path, cap_path, host, now, state, coordination):
                    observed = []
                    def checkpoint(name):
                        observed.append(name)
                        if name == "intent:" + intent:
                            self.assertTrue((coordination / "operation-pending.json").is_file())
                            self.assertTrue(any(p.name.endswith("pending.json") for p in state.iterdir()))
                    host.fail_after = intent
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now,
                                          _host=host, _checkpoint=checkpoint)
                    self.assertIn("intent:" + intent, observed)
                    self.assertEqual(host.mutations, list(INTENTS[:INTENTS.index(intent) + 1]))
                    prior = list(host.mutations)
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now, _host=host)
                    self.assertEqual(host.mutations, prior)

    def test_checkpoint_after_durable_intent_but_before_command_never_reissues(self):
        def halt(name):
            if name == "intent:api-term":
                raise Halt()
        with self.assertRaises(Halt):
            self.stage(_checkpoint=halt)
        self.assertEqual(self.host.mutations, [])
        self.assertTrue((self.coordination / "operation-pending.json").is_file())
        self.assert_rejected_without_mutation()
        before = snapshot(self.root)
        self.inspect()
        self.assertEqual(snapshot(self.root), before)

    def test_pending_inspect_does_not_recreate_missing_coordination_lock(self):
        def halt(name):
            if name == "intent:api-term":
                raise Halt()
        with self.assertRaises(Halt):
            self.stage(_checkpoint=halt)
        (self.coordination / "maintenance.lock").unlink()
        before = snapshot(self.root)
        with self.assertRaises(self.module.StageError):
            self.inspect()
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual(self.host.mutations, [])

    def test_missing_pending_with_remaining_evidence_cannot_claim_unchanged_runtime(self):
        for case in ("orphaned-own-state", "legacy-barrier"):
            with self.subTest(case=case):
                with self.isolated("missing-pending-" + case) as (root, plan_path, cap_path, host, now, state, coordination):
                    if case == "orphaned-own-state":
                        def halt(name):
                            if name == "intent:api-term":
                                raise Halt()
                        with self.assertRaises(Halt):
                            self.module.stage(plan_path, cap_path, allow_stage=True, now=now,
                                              _host=host, _checkpoint=halt)
                        (state / "pending.json").unlink()
                        # Isolate own orphaned evidence from the global-barrier
                        # case. Neither removal is a production recovery step.
                        (coordination / "operation-pending.json").unlink()
                    else:
                        write(coordination / "operation-pending.json", b'{"operation":"synthetic-unsettled"}\n')
                    before = snapshot(root)
                    with self.assertRaisesRegex(self.module.StageError, "^stage-state-indeterminate$"):
                        self.module.inspect_stage(plan_path, _host=host)
                    self.assertEqual(snapshot(root), before)
                    self.assertEqual(host.mutations, [])

    def test_last_command_boundary_refuses_changed_own_files_journal_or_old_api_epoch(self):
        for case in ("spec", "environment", "journal", "api-epoch"):
            with self.subTest(case=case):
                with self.isolated("boundary-" + case) as (_, plan_path, cap_path, host, now, state, coordination):
                    changed = {}
                    def checkpoint(name):
                        if name != "intent:api-term":
                            return
                        if case == "api-epoch":
                            host.records[host.plan["baseline"]["api"]["id"]]["State"]["StartedAt"] = "2026-11-09T03:00:00Z"
                            return
                        filename = {"spec": "api-" + host.plan["operation_id"] + ".json",
                                    "environment": "empty.env", "journal": "pending.json"}[case]
                        path = state / filename
                        raw = path.read_bytes()
                        if case == "journal":
                            value = json.loads(raw)
                            value["completed"] = ["api-term"]
                            raw = encoded(value)
                        else:
                            raw += b"\n"
                        write(path, raw, 0o600 if case == "journal" else 0o400)
                        changed[path] = raw
                    with self.assertRaises(self.module.StageError):
                        self.module.stage(plan_path, cap_path, allow_stage=True, now=now,
                                          _host=host, _checkpoint=checkpoint)
                    self.assertEqual(host.mutations, [])
                    self.assertTrue((coordination / "operation-pending.json").exists())
                    for path, raw in changed.items():
                        self.assertEqual(path.read_bytes(), raw, "Refusal must preserve conflicting evidence")

    def test_start_waits_read_only_for_health_without_restarting_or_recreating(self):
        self.host.ready_after = 3
        with patch.object(self.module.time, "sleep") as sleep:
            result = self.stage()
        self.assertEqual(result["status"], "prepared-closed")
        self.assertEqual(self.host.mutations, list(INTENTS))
        self.assertGreaterEqual(self.host.health_reads["c" * 64], 3)
        self.assertGreaterEqual(self.host.health_reads["d" * 64], 3)
        self.assertGreaterEqual(sleep.call_count, 4)

    def test_fresh_adopt_only_accepts_whole_prepared_topology_without_docker_mutation(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        self.assertEqual(self.host.mutations, list(INTENTS))
        cap, now = self.adopt_cap()
        prior = list(self.host.mutations)
        result = self.module.adopt_prepared(self.plan_path, cap, allow_adopt=True,
                                            now=now, _host=self.host)
        self.assertEqual(self.host.mutations, prior)
        self.assertEqual(result["status"], "prepared-closed")
        self.assertIs(result["legacy_barrier_retained"], True)
        self.assertTrue((self.coordination / "operation-pending.json").is_file())
        self.assert_unchanged_originals()
        before = snapshot(self.root)
        self.inspect()
        self.assertEqual(snapshot(self.root), before)

    def test_adopt_refuses_partial_topology_and_never_finishes_commands(self):
        self.host.fail_after = "api-create"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        prior = list(self.host.mutations)
        with self.assertRaises(self.module.StageError):
            self.module.adopt_prepared(self.plan_path, cap, allow_adopt=True, now=now, _host=self.host)
        self.assertEqual(self.host.mutations, prior)
        self.assertTrue((self.coordination / "operation-pending.json").exists())

    def test_adopt_requires_exact_fresh_capability_and_does_not_reuse_stage_permission(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        raw = cap.read_bytes()
        for mutate in (lambda c: c.update(pending_sha256="f" * 64),
                       lambda c: c.update(expires_at=now), lambda c: c.update(allow_adopt=1),
                       lambda c: c.update(allow_stage=True)):
            with self.subTest(mutate=mutate):
                value = json.loads(raw)
                mutate(value)
                write(cap, encoded(value))
                self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
                    self.plan_path, cap, allow_adopt=True, now=now, _host=self.host))
        write(cap, raw)
        for flag in (False, None, 1, "true"):
            self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
                self.plan_path, cap, allow_adopt=flag, now=now, _host=self.host))

    def test_ready_adoption_refuses_new_runtime_drift_and_reopened_gate(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        api = self.host.records["c" * 64]
        api["Config"]["Env"].append("CITYGO_UNAPPROVED=1")
        self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
            self.plan_path, cap, allow_adopt=True, now=now, _host=self.host))
        api["Config"]["Env"].pop()
        write(self.module.TRAFFIC_MARKER, b"open\n")
        self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
            self.plan_path, cap, allow_adopt=True, now=now, _host=self.host))

    def test_forged_runtime_cache_cannot_reauthorize_drift_against_pinned_plan(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        pending_before = (self.state / "pending.json").read_bytes()
        api = self.host.records["c" * 64]
        api["Config"]["Env"].append("CITYGO_UNAPPROVED=1")
        undone = copy.deepcopy(api)
        undone["Config"]["Env"] = ["TRUSTED_PROXY_CIDRS=172.30.92.10/32" if value.startswith("TRUSTED_PROXY_CIDRS=")
                                      else value for value in undone["Config"]["Env"]]
        undone["HostConfig"]["RestartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}
        cache = self.state / ("runtime-" + self.plan["operation_id"] + ".json")
        forged = json.loads(cache.read_bytes())
        forged["api"] = semantic_fingerprint(undone)
        forged_raw = encoded(forged)
        write(cache, forged_raw, 0o400)
        try:
            result = self.inspect()
        except self.module.StageError:
            pass
        else:
            self.assertIs(result["desired_ready"], False)
        self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
            self.plan_path, cap, allow_adopt=True, now=now, _host=self.host))
        self.assertEqual((self.state / "pending.json").read_bytes(), pending_before)
        self.assertEqual(cache.read_bytes(), forged_raw)

    def test_prepared_receipt_authority_fields_and_adopt_audit_are_bound(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        original_adopt_raw = cap.read_bytes()
        self.module.adopt_prepared(self.plan_path, cap, allow_adopt=True, now=now, _host=self.host)
        fresh_cap, fresh_now = self.adopt_cap(now=now + 1)
        pending_before = (self.state / "pending.json").read_bytes()
        receipt_path = self.state / ("prepared-" + self.plan["operation_id"] + ".json")
        receipt_raw = receipt_path.read_bytes()
        for field, value in (("traffic_opened", True), ("nginx_changed", 0),
                             ("legacy_barrier_retained", False)):
            with self.subTest(field=field):
                forged = json.loads(receipt_raw)
                forged[field] = value
                forged_raw = encoded(forged)
                write(receipt_path, forged_raw, 0o400)
                with self.assertRaises(self.module.StageError):
                    self.inspect()
                self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
                    self.plan_path, fresh_cap, allow_adopt=True, now=fresh_now, _host=self.host))
                self.assertEqual(receipt_path.read_bytes(), forged_raw)
                self.assertEqual((self.state / "pending.json").read_bytes(), pending_before)
                write(receipt_path, receipt_raw, 0o400)
        audit_path = self.state / ("adopt-" + digest(original_adopt_raw) + ".json")
        self.assertEqual(audit_path.read_bytes(), original_adopt_raw)
        for mutation in ("changed", "missing"):
            with self.subTest(audit=mutation):
                if mutation == "changed":
                    write(audit_path, original_adopt_raw + b"\n", 0o400)
                else:
                    audit_path.unlink()
                with self.assertRaises(self.module.StageError):
                    self.inspect()
                self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
                    self.plan_path, fresh_cap, allow_adopt=True, now=fresh_now, _host=self.host))
                self.assertEqual((self.state / "pending.json").read_bytes(), pending_before)
                write(audit_path, original_adopt_raw, 0o400)

    def test_adoption_does_not_normalize_unapproved_restart_source_or_extra_network(self):
        self.host.fail_after = "web-start"
        with self.assertRaises(self.module.StageError):
            self.stage()
        cap, now = self.adopt_cap()
        api = self.host.records["c" * 64]
        original = copy.deepcopy(api)
        cases = (lambda item: item["HostConfig"].update(RestartPolicy={"Name": "always", "MaximumRetryCount": 0}),
                 lambda item: item["HostConfig"].update(OomKillDisable=True),
                 lambda item: item["Config"]["Labels"].update({"org.opencontainers.image.revision": "f" * 40}),
                 lambda item: item["NetworkSettings"]["Networks"].update({"foreign-network": {
                     "NetworkID": "f" * 64, "IPAddress": "172.31.0.10", "Aliases": ["api"]}}))
        for mutate in cases:
            with self.subTest(mutate=mutate):
                mutate(self.host.records["c" * 64])
                self.assert_rejected_without_mutation(lambda: self.module.adopt_prepared(
                    self.plan_path, cap, allow_adopt=True, now=now, _host=self.host))
                self.host.records["c" * 64] = copy.deepcopy(original)

    def test_source_symlink_or_writable_source_refused_without_mutation(self):
        raw = self.plan_path.read_bytes()
        self.plan_path.chmod(0o666)
        self.assert_rejected_without_mutation()
        self.plan_path.chmod(0o600)
        alternate = self.root / "plan-original.json"
        self.plan_path.rename(alternate)
        self.plan_path.symlink_to(alternate)
        self.assert_rejected_without_mutation()
        self.assertEqual(alternate.read_bytes(), raw)

    def test_conflicting_maintenance_lock_is_not_bypassed(self):
        import fcntl
        descriptor = os.open(self.coordination / "maintenance.lock", os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_rejected_without_mutation()
        finally:
            os.close(descriptor)


if __name__ == "__main__":
    unittest.main()
