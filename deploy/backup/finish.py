"""Internal closed-release commit. No CLI, traffic, Worker admission or recovery.

One canonical backup.json is replaced under the live startup continuation lock.
Pending is the transaction barrier: a crash never makes a half-commit admissible.
Operator approval is independent of all bundles and previous-stage approvals.
"""
import copy
import os
from pathlib import Path, PurePosixPath
import time

import backup as b
import image_gate as g
import migration_job as m
import start as s
import target as t
import worker as w

PROFILE = "citygo-closed-release-v1"
ACTIVE = "active-release.json"


def path_string(path):
    value = str(path)
    b.require(PurePosixPath(value).is_absolute() and ".." not in PurePosixPath(value).parts
              and not any(ch in value for ch in "$\r\n\0"), "finish-path")
    return value


def worker_secret(path):
    raw = t.read_file(path)
    value = t.strict_json(raw)
    t.keys(value, {"DATABASE_URL"}, "finish-worker-secret")
    # Reuse the strict endpoint/role parser without exposing any secret values.
    url = value["DATABASE_URL"]
    b.require(type(url) is str and not any(ord(ch) <= 32 for ch in url), "finish-worker-secret")
    try:
        parsed = s.urlsplit(url)
        valid = (parsed.scheme in ("postgres", "postgresql") and parsed.username == "citygo_worker"
                 and bool(parsed.password) and parsed.hostname == "postgres" and parsed.port == 5432
                 and parsed.path == "/citygo_pilot" and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    b.require(valid and len(raw) <= 16384, "finish-worker-secret")
    return raw


def generation(config, target_sha, origin, local_images, api_file, worker_file, backup_file, profile=s.PROFILE):
    """Pure construction from verified local image IDs; no candidate Compose.

    Explicit paths/hashes are reviewed before any writer is stopped. Secrets are
    referenced, never copied into generation files or receipts.
    """
    b.require(t.matches(target_sha, t.SHA), "finish-target")
    directory = Path(config["state_dir"]) / ("release-" + target_sha)
    for path in (directory, api_file, worker_file, backup_file): path_string(path)
    secret_hashes = {str(api_file): t.sha256(s.api_secret(api_file, profile)),
                     str(worker_file): t.sha256(worker_secret(worker_file))}
    password = t.read_file(backup_file)
    b.require(0 < len(password) <= 4096 and b"\0" not in password, "finish-backup-secret")
    secret_hashes[str(backup_file)] = t.sha256(password)
    b.require(len(secret_hashes) == 3, "finish-secret-paths")
    spec = s.compose_spec(config["project"], origin, local_images["target"], api_file, profile)
    shared = {"init": True, "read_only": True, "restart": "no", "profiles": ["ops"],
              "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "pids_limit": 128,
              "mem_limit": 256 * 1024 * 1024, "memswap_limit": 256 * 1024 * 1024,
              "tmpfs": ["/tmp:size=64m,mode=1777"], "networks": ["database"],
              "logging": copy.deepcopy(spec["services"]["api"]["logging"])}
    spec["services"]["worker"] = {**copy.deepcopy(shared), "user": "1000:1000", "stop_grace_period": "90s",
        "image": local_images["target"]["jobs"]["local_id"], "entrypoint": ["node", "scripts/container-runtime.mjs"],
        "working_dir": "/app", "command": ["worker"], "environment": {"CITYGO_MOUNTED_CONFIG": "1"},
        "secrets": [{"source": "worker_config", "target": "worker.json"}]}
    spec["services"]["backup"] = {**copy.deepcopy(shared), "user": "postgres", "stop_grace_period": "30s",
        "image": local_images["postgres"]["local_id"], "entrypoint": ["sh", "/opt/citygo/dump.sh"],
        "volumes": [{"type": "bind", "source": str(directory / "dump.sh"), "target": "/opt/citygo/dump.sh", "read_only": True}],
        "secrets": ["db_backup_password"]}
    spec["secrets"].update(worker_config={"file": str(worker_file)}, db_backup_password={"file": str(backup_file)})
    # This is the installed/trusted controller's producer, NOT a candidate hook.
    dump = t.read_file(Path(__file__).resolve().parent.parent / "postgres" / "dump.sh")
    files = {"compose.json": m.wire(spec), "empty.env": b"# no inherited environment\n", "dump.sh": dump}
    # Intentional new configuration, not an unbound copy for executing old work.
    next_config = dict(config, source_sha=target_sha, compose_file=str(directory / "compose.json"),
                       compose_env=str(directory / "empty.env"))
    b.validate(next_config)
    projection = {"config": next_config, "files": {k: t.sha256(v) for k, v in files.items()}, "secrets": secret_hashes}
    return {"directory": directory, "files": files, "config": next_config, "secrets": secret_hashes,
            "sha256": t.sha256(m.wire(projection)), "configuration_sha256": b.configuration_fingerprint(next_config,
                inputs={"compose_file": files["compose.json"], "compose_env": files["empty.env"]})}


def approval(raw, now):
    value = t.strict_json(raw)
    t.keys(value, {"version", "purpose", "profile", "startup_approval_sha256", "config_path",
                   "config_file_sha256", "generation_sha256", "approved_at", "expires_at", "allow_finish",
                   "allow_traffic", "allow_worker", "allow_restart"}, "finish-approval")
    b.require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == "citygo-release-finish"
              and value["profile"] == PROFILE and value["allow_finish"] is True
              and all(value[k] is False for k in ("allow_traffic", "allow_worker", "allow_restart")), "finish-approval")
    for key in ("startup_approval_sha256", "config_file_sha256", "generation_sha256"):
        b.require(t.matches(value[key], t.HASH), "finish-approval")
    b.require(type(value["config_path"]) is str, "finish-path")
    path_string(value["config_path"])
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400, "finish-expired")
    return value


class Approval:
    def __init__(self, path):
        self.path = Path(path)
        self._pin, self._failed = None, False

    def verify(self, selection, migration, startup, config_path, config_raw, plan):
        b.require(not self._failed, "finish-approval-invalidated")
        try:
            b.require(self.path.is_absolute() and ".." not in self.path.parts
                      and self.path not in (selection.approval_file, migration.path, startup.path, config_path)
                      and all(not self.path.is_relative_to(root) for root in
                              (selection.current_directory, selection.target_directory, plan["directory"])), "finish-self-approval")
            raw = t.read_file(self.path, private=True)
            value = approval(raw, time.time())
            b.require(self._pin is None or self._pin == raw, "finish-approval-changed")
            b.require(value["startup_approval_sha256"] == t.sha256(t.read_file(startup.path, private=True))
                      and value["config_path"] == str(config_path) and value["config_file_sha256"] == t.sha256(config_raw)
                      and value["generation_sha256"] == plan["sha256"], "finish-binding")
            b.require(t.read_file(self.path, private=True) == raw, "finish-approval-changed")
            approval(raw, time.time())
            self._pin = raw
            return t.sha256(raw)
        except Exception:
            self._failed = True
            raise


def write_new(path, raw, *, public_script=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw); stream.flush()
        if public_script: os.fchmod(stream.fileno(), 0o444)  # non-secret bind, readable by container's postgres UID
        os.fsync(stream.fileno())
    b.sync_directory(path.parent)


def verify_generation(plan):
    directory = b.protected(plan["directory"], directory=True)
    b.require(set(p.name for p in directory.iterdir()) == set(plan["files"]), "finish-generation-files")
    for name, data in plan["files"].items():
        b.require(t.read_file(directory / name, private=name != "dump.sh") == data, "finish-generation-changed")
    for path, digest in plan["secrets"].items():
        b.require(t.sha256(t.read_file(path)) == digest, "finish-secret-changed")


def finish(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file, worker_secret_file,
           backup_secret_file, *, finish_authorization=None, allow_finish=False, **options):
    b.require(allow_finish is True and type(finish_authorization) is Approval, "explicit-finish-permission-required")
    b.require("authorization_check" not in options, "finish-only")
    # Only load_config gives us the authoritative, protected source to replace.
    b.require(type(config) is b._LoadedConfig, "finish-canonical-config-required")
    b.assert_current_config(config)
    config_path = config._binding.path
    config_raw = b._config_bytes(config_path)
    selected, migration, startup = options.get("selection"), options.get("authorization"), options.get("startup_authorization")
    b.require(type(selected) is t.Selection and type(migration) is s.c.Approval and type(startup) is s.Approval, "finish-authorizations")
    verified = selected.verify(config, target_sha, origin, images)
    state = b.protected(config["state_dir"], directory=True)
    b.require(not config_path.is_relative_to(state), "finish-config-location")
    store_factory = options.get("image_store_factory", g.Store)
    local_images = g.verify(store_factory(state), verified, images)
    started = startup.verify(selected, migration, config, target_sha, origin, images, api_secret_file)
    plan = generation(config, target_sha, origin, local_images, api_secret_file, worker_secret_file, backup_secret_file, started["profile"])
    b.require(not os.path.lexists(plan["directory"]), "finish-generation-exists")
    approved = finish_authorization.verify(selected, migration, startup, config_path, config_raw, plan)
    used = state / ("finish-approval-" + approved + ".used.json")
    b.require(not os.path.lexists(used), "finish-approval-used")
    # Immutable approval bytes, re-read even AFTER intentional config cutover.
    pins = [(obj.path if hasattr(obj, "path") else obj.approval_file, parser) for obj, parser in
            ((selected, t.approval), (migration, s.c.approval), (startup, s.approval), (finish_authorization, approval))]
    pins = [(path, parser, t.read_file(path, private=True)) for path, parser in pins]
    reservation = None
    created = False

    def check(*, cutover=False):
        for path, parser, raw in pins:
            b.require(t.read_file(path, private=True) == raw, "finish-authorization-changed")
            parser(raw, time.time())
        if reservation is None: b.require(not os.path.lexists(used), "finish-approval-used")
        else: b.require(t.read_file(used, private=True) == reservation, "finish-reservation-changed")
        if created: verify_generation(plan)
        else: b.require(not os.path.lexists(plan["directory"]), "finish-generation-exists")
        for path, digest in plan["secrets"].items():
            b.require(t.sha256(t.read_file(path)) == digest, "finish-secret-changed")
        if not cutover:
            b.assert_current_config(config)
            b.require(b._config_bytes(config_path) == config_raw, "finish-config-changed")
            b.require(finish_authorization.verify(selected, migration, startup, config_path, config_raw, plan) == approved, "finish-approval-changed")
        else:
            current = b.load_config(config_path)
            b.require(current == plan["config"] and b.configuration_fingerprint(current) == plan["configuration_sha256"], "finish-config-changed")
        # No long I/O may outlive any stage's approval deadline.
        for path, parser, raw in pins:
            b.require(t.read_file(path, private=True) == raw, "finish-authorization-changed")
        now = time.time()
        for _path, parser, raw in pins: parser(raw, now)

    check()  # Missing finish authority must fail BEFORE downtime/backup/DDL.
    with s._started_window(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file,
                           authorization_check=check, **options) as stage:
        operation = stage["operation"]
        with b.lock(state, "worker-admission.lock"):
            stage["recheck"](); check()
            reservation = m.wire({"version": 1, "operation_id": operation["id"], "approval_sha256": approved,
                                  "old_config_sha256": t.sha256(config_raw), "generation_sha256": plan["sha256"]})
            write_new(used, reservation)
            plan["directory"].mkdir(mode=0o700)
            b.sync_directory(state)
            for name, raw in plan["files"].items(): write_new(plan["directory"] / name, raw, public_script=name == "dump.sh")
            created = True
            # Preserve exact pre-cutover configuration as private evidence, not a
            # restart/rollback capability. Never delete partial generations.
            write_new(state / ("finish-" + operation["id"] + ".previous.json"), config_raw)
            stage["recheck"](); check()
            b.atomic_json(config_path, plan["config"])
            # From here only the NEW configuration is valid. Old approvals are
            # checked by their pinned bytes/time, not against the new fingerprint.
            check(cutover=True)
            stage["recheck"](cutover=True)
            check(cutover=True)
            proof = {"version": 1, "kind": "closed-release", "operation_id": operation["id"], "source_sha": target_sha,
                     "configuration_sha256": plan["configuration_sha256"], "generation_sha256": plan["sha256"],
                     "approval_sha256": approved, "startup": stage["result"]["startup"],
                     "traffic_authorized": False, "worker_authorized": False, "restart_authorized": False}
            b.atomic_json(state / ACTIVE, proof)
            check(cutover=True)
            b.require(t.strict_json(t.read_file(state / ACTIVE, private=True)) == proof, "finish-record-changed")
            b.require(not os.path.lexists(state / w.ADMISSION), "worker-not-paused")
            result = {**copy.deepcopy(stage["result"]), "finish": copy.deepcopy(proof)}
            # Final transaction barrier. No fallible work or side effects after
            # this unlink beyond lock release. Crash/fsync ambiguity => inspect,
            # never rerun approvals or roll back migrations automatically.
            b.complete_operation(state, operation, before_clear=lambda: check(cutover=True))
    return result


def active_release(config):
    """Read-only committed status; JSON alone never proves a completed cutover."""
    b.assert_current_config(config)
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state):
        b.assert_operation_idle(state)
        value = t.strict_json(t.read_file(state / ACTIVE, private=True))
        b.require(value.get("version") == 1 and value.get("kind") == "closed-release"
                  and value.get("source_sha") == config["source_sha"]
                  and value.get("configuration_sha256") == b.configuration_fingerprint(config), "finish-not-active")
        return value
