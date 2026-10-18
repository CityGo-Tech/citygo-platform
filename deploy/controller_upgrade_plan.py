#!/usr/bin/env python3
"""Offline controller snapshot and INACTIVE closed-release blueprints.

No candidate import, shell, Docker, network, approval writer, installer or apply.
An operator-supplied source SHA is a label, not a Git/publication attestation.
Materialization requires a non-root POSIX user and anchored directory FDs;
the pure in-memory build() function remains portable.
"""
import argparse
import ast
from contextlib import contextmanager
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
from urllib.parse import urlsplit

MODULES = ("autodeploy", "backup", "control", "finish", "image_gate", "migrate", "migration_job",
           "prepare", "recovery", "release", "start", "target", "worker")
CONTROLLER_FILES = tuple(sorted(["deploy/backup/" + name + ".py" for name in MODULES] + ["deploy/postgres/dump.sh"]))
HASH = r"[a-f0-9]{64}"
SHA = r"[a-f0-9]{40}"
DIGEST = "sha256:" + HASH
PROFILE = "citygo-api-web-routerai-citygo-10x-v1"
METADATA = {"bytes", "gid", "mode", "path", "sha256", "uid"}
BINDINGS = {"/etc/citygo/autodeploy.json", "/etc/citygo/backup-routine.json", "/etc/citygo/backup.json",
            "/etc/sudoers.d/citygo-deploy", "/var/lib/citygo-backup/autodeploy/current.json",
            "/var/lib/citygo-deploy/.ssh/authorized_keys"}
BINDING_MODES = {path: ("0440" if path == "/etc/sudoers.d/citygo-deploy" else
                       "0644" if path == "/var/lib/citygo-deploy/.ssh/authorized_keys" else "0600") for path in BINDINGS}
UNITS = {"citygo-backup-routine.service", "citygo-backup-routine.timer",
         "citygo-backup-routine-check.service", "citygo-backup-routine-check.timer"}
OBSERVATION_FIELDS = {"bindings", "compose_file", "config_fingerprint", "controller_directory", "controller_sha256",
    "current_manifest", "database", "files", "initial_bundle", "initial_manifest_sha256", "kind", "locks",
    "observed_at", "origin", "pending", "policy_enabled", "policy_profile", "project", "secrets", "source_sha",
    "state_directory", "systemd", "version", "visudo_valid"}
AUTHORIZES = {name: False for name in ("controller_installation", "controller_activation", "stop", "upload",
                                      "migration", "start", "finish", "traffic", "worker", "restart")}


class PlanError(Exception):
    pass


def require(condition, code):
    if not condition: raise PlanError(code)


def matches(value, expression):
    return type(value) is str and re.fullmatch(expression, value) is not None


def keys(value, expected, code="observation-shape"):
    require(type(value) is dict and set(value) == set(expected), code)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")


def strict_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= 512 * 1024, "observation-size")
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "duplicate-json-key")
            value[key] = item
        return value
    def constant(_):
        raise PlanError("nonfinite-json")
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise PlanError("invalid-json") from None


def local_path(value, *, directory=False, missing=False):
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts, "local-path")
    for item in [*reversed(path.parents), path]:
        if missing and item == path:
            require(not os.path.lexists(item), "output-already-exists")
            continue
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024)), "linked-path")
        if item != path or directory:
            require(stat.S_ISDIR(info.st_mode), "directory-required")
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "regular-single-link-required")
    return path


def read_once(path, limit):
    path = local_path(path)
    before = path.lstat()
    require(0 < before.st_size <= limit, "file-size")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1
                and (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), "source-file-changed")
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    require(0 < len(raw) <= limit and len(raw) == opened.st_size and after.st_nlink == 1
            and (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "source-file-changed")
    return raw


def server_path(value):
    require(type(value) is str and value.startswith("/") and not any(ord(c) <= 32 for c in value), "server-path")
    path = PurePosixPath(value)
    require(".." not in path.parts and str(path) == value, "server-path")
    return value


def metadata(value, path, *, mode, extra=()):
    keys(value, METADATA | set(extra))
    require(value["path"] == server_path(path) and type(value["bytes"]) is int and 0 < value["bytes"] <= 512 * 1024
            and type(value["uid"]) is int and value["uid"] == 0
            and type(value["gid"]) is int and value["gid"] == 0
            and matches(value["sha256"], HASH) and value["mode"] == mode, "observation-metadata")


def migration_inventory(values, field, count):
    require(type(values) is list and len(values) == count, "migration-count")
    for number, item in enumerate(values, 1):
        keys(item, {"name", field})
        require(matches(item["name"], f"{number:04d}_" + r"[a-z0-9_]+\.sql")
                and matches(item[field], HASH), "migration-history")


def controller_digest(hashes):
    # Intentionally identical to deploy/install-autodeploy.py, not wire().
    return sha256(json.dumps(hashes, sort_keys=True).encode())


def observation(raw):
    value = strict_json(raw)
    keys(value, OBSERVATION_FIELDS)
    require(type(value["version"]) is int and value["version"] == 1
            and value["kind"] == "citygo-controller-observation"
            and matches(value["source_sha"], SHA) and value["project"] == "citygo-pilot"
            and matches(value["config_fingerprint"], HASH)
            and value["policy_enabled"] is False and value["policy_profile"] == "citygo-api-web-disabled-v1"
            and value["visudo_valid"] is True, "observation-identity")
    try:
        origin = urlsplit(value["origin"])
        observed = datetime.fromisoformat(value["observed_at"].replace("Z", "+00:00"))
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        require(origin.scheme == "https" and matches(origin.hostname, label + r"(?:\." + label + r")+")
                and len(origin.hostname) <= 253
                and origin.netloc == origin.hostname and not origin.path and not origin.query and not origin.fragment
                and observed.tzinfo is not None, "observation-origin-time")
    except (ValueError, TypeError, AttributeError):
        raise PlanError("observation-origin-time") from None
    require(matches(value["controller_sha256"], HASH), "controller-digest")
    require(value["controller_directory"] == "/opt/citygo/autodeploy-controller-" + value["controller_sha256"][:16], "controller-directory")
    keys(value["files"], CONTROLLER_FILES)
    for name, item in value["files"].items():
        metadata(item, value["controller_directory"] + "/" + name, mode="0644")
    require(controller_digest({name: item["sha256"] for name, item in value["files"].items()}) == value["controller_sha256"], "controller-digest")
    require(value["initial_bundle"] == value["controller_directory"] + "/initial-bundle"
            and matches(value["initial_manifest_sha256"], HASH)
            and value["state_directory"] == "/var/lib/citygo-backup"
            and value["compose_file"] == value["state_directory"] + "/release-" + value["source_sha"] + "/compose.json", "observation-paths")
    keys(value["bindings"], BINDINGS)
    for path, item in value["bindings"].items(): metadata(item, path, mode=BINDING_MODES[path])
    current = value["current_manifest"]
    keys(current, {"bases", "image_ids", "images", "migrations", "path", "sha256", "source_sha"})
    server_path(current["path"])
    require(matches(current["path"], "/opt/citygo/autodeploy-bundles/" + value["source_sha"]
                    + r"-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}/release\.json")
            and current["source_sha"] == value["source_sha"] and matches(current["sha256"], HASH), "current-manifest")
    migration_inventory(current["migrations"], "sha256", 12)
    keys(current["bases"], {"node", "postgres"})
    require(matches(current["bases"]["node"], r"node:24-bookworm-slim@" + DIGEST)
            and matches(current["bases"]["postgres"], r"postgres:17-alpine@" + DIGEST), "current-bases")
    for name in ("images", "image_ids"): keys(current[name], {"api", "web", "jobs"})
    for role in ("api", "web", "jobs"):
        require(matches(current["images"][role], r"ghcr\.io/citygo-tech/citygo-platform-" + role + "@" + DIGEST)
                and matches(current["image_ids"][role], DIGEST), "current-images")
    database = value["database"]
    keys(database, {"database", "migrations", "read_only", "role", "server_version"})
    require(database["database"] == "citygo_pilot" and database["read_only"] == "on"
            and database["role"] == "citygo_backup" and matches(database["server_version"], r"17\.[0-9]+"), "database-observation")
    migration_inventory(database["migrations"], "checksum", 12)
    require([entry["name"] for entry in current["migrations"]] == [entry["name"] for entry in database["migrations"]], "migration-history")
    keys(value["secrets"], {"api", "migration", "worker", "backup"})
    for role, item in value["secrets"].items():
        filename = {"api": "api.json", "migration": "migrate.json", "worker": "worker.json", "backup": "db_backup_password"}[role]
        metadata(item, "/etc/citygo/secrets/" + filename, mode="0444",
                 extra={"matches_policy_pin"} | ({"keys"} if role != "backup" else set()))
        require(item["matches_policy_pin"] is True, "secret-pin")
        if role != "backup": require(item["keys"] == ["DATABASE_URL"], "secret-metadata-only")
    keys(value["locks"], {"maintenance.lock", "worker-admission.lock"})
    require(all(state in ("busy", "free-at-observation") for state in value["locks"].values()), "lock-observation")
    keys(value["pending"], {"operation-pending.json", "autodeploy/pending.json"})
    require(all(type(item) is bool for item in value["pending"].values()), "pending-observation")
    keys(value["systemd"], UNITS)
    for unit, item in value["systemd"].items():
        keys(item, {"ActiveState", "DropInPaths", "FragmentPath", "Result", "SubState", "code_paths", "files"})
        require(item["FragmentPath"] == "/etc/systemd/system/" + unit and item["DropInPaths"] == ""
                and all(matches(item[field], r"[a-z-]{1,40}") for field in ("ActiveState", "Result", "SubState"))
                and type(item["files"]) is list and len(item["files"]) == 1
                and type(item["code_paths"]) is list, "systemd-observation")
        metadata(item["files"][0], item["FragmentPath"], mode="0644")
        if unit.endswith(".timer"):
            require(item["code_paths"] == [], "systemd-observation")
        else:
            require(len(item["code_paths"]) == 1 and matches(item["code_paths"][0],
                    r"/opt/citygo/backup-routine-[a-f0-9]{16}/routine\.py"), "systemd-observation")
    return value


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in CONTROLLER_FILES:
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.uid, info.gid, info.mtime = len(files[name]), 0o644, 0, 0, 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(files[name]))
    return output.getvalue()


def drafts(value):
    common = {"draft": True, "approved_at": None, "expires_at": None}
    preparation = {**common, "version": 2, "purpose": "citygo-release-preparation", "repository_id": 1351070410,
        "organization_id": 248379281, "artifact_id": None, "current_manifest_sha256": value["current_manifest"]["sha256"],
        "target_manifest_sha256": None, "target_release_id": None, "target_sha": None,
        "project": value["project"], "origin": value["origin"], "configuration_sha256": value["config_fingerprint"],
        "current_images": None, "retained_jobs": None, "allow_preparation": False, "allow_migration": False}
    migration = {**common, "version": 1, "purpose": "citygo-release-migration", "preparation_sha256": None,
        "target_manifest_sha256": None, "configuration_sha256": value["config_fingerprint"], "project": value["project"],
        "origin": value["origin"], "network_id": None, "allow_migration": False, "allow_start": False, "allow_traffic": False}
    startup = {**common, "version": 3, "purpose": "citygo-release-start", "profile": PROFILE,
        "migration_approval_sha256": None, "api_secret_sha256": None, "web_network_id": None,
        "allow_start": False, "allow_traffic": False}
    finish = {**common, "version": 1, "purpose": "citygo-release-finish", "profile": "citygo-closed-release-v1",
        "startup_approval_sha256": None, "config_path": "/etc/citygo/backup.json",
        "config_file_sha256": value["bindings"]["/etc/citygo/backup.json"]["sha256"], "generation_sha256": None,
        "allow_finish": False, "allow_traffic": False, "allow_worker": False, "allow_restart": False}
    return {"preparation.draft.json": preparation, "migration.draft.json": migration,
            "startup.draft.json": startup, "finish.draft.json": finish}


def build(source, observed_raw, *, source_sha=None):
    source = local_path(source, directory=True)
    require(source_sha is None or matches(source_sha, SHA), "source-label")
    value = observation(observed_raw)
    files = {name: read_once(source / name, 262144) for name in CONTROLLER_FILES}
    for name, raw in files.items():
        if name.endswith(".py"):
            try: ast.parse(raw.decode("utf-8"), filename=name)
            except (ValueError, UnicodeError, SyntaxError, RecursionError): raise PlanError("controller-syntax") from None
    hashes = {name: sha256(raw) for name, raw in files.items()}
    proposed_digest = controller_digest(hashes)
    migration_directory = local_path(source / "packages/db/migrations", directory=True)
    names = sorted(entry.name for entry in migration_directory.iterdir())
    require(len(names) == 18, "source-migration-count")
    migrations = []
    checksums = []
    for number, name in enumerate(names, 1):
        require(matches(name, f"{number:04d}_" + r"[a-z0-9_]+\.sql"), "source-migration-inventory")
        raw = read_once(migration_directory / name, 4 * 1024 * 1024)
        try: canonical = raw.decode("utf-8").replace("\r\n", "\n").encode("utf-8")
        except UnicodeError: raise PlanError("migration-encoding") from None
        migrations.append({"name": name, "sha256": sha256(raw)})
        checksums.append({"name": name, "checksum": sha256(canonical)})
    require(checksums[:12] == value["database"]["migrations"], "source-database-prefix-drift")
    require(migrations[:12] == value["current_manifest"]["migrations"], "source-manifest-prefix-drift")
    grants = read_once(source / "deploy/postgres/grants.sql", 262144)
    package = archive(files)
    inactive = drafts(value)
    blockers = ["target-main-publication-not-verified", "target-manifest-and-tested-images-unavailable",
                "controller-not-installed-or-authorized", "new-citygo-10x-api-secret-not-prepared",
                "local-image-and-runtime-inventory-not-verified", "fresh-backup-and-release-window-recheck-required",
                "independent-stage-approvals-not-issued"]
    blockers += ["observed-lock-busy:" + name for name, state in value["locks"].items() if state == "busy"]
    blockers += ["observed-pending:" + name for name, present in value["pending"].items() if present]
    for unit, item in value["systemd"].items():
        if unit.endswith(".service") and item["ActiveState"] != "inactive": blockers.append("observed-service-not-idle:" + unit)
        if item["Result"] != "success": blockers.append("observed-service-result:" + unit)
        if unit.endswith(".timer") and item["ActiveState"] != "active": blockers.append("observed-timer-not-active:" + unit)
    plan = {"version": 1, "kind": "citygo-closed-release-draft", "ready": False, "authorizes": dict(AUTHORIZES),
        "source_label": {"sha": source_sha, "provenance": "operator-provided-not-git-attested"},
        "observation_sha256": sha256(observed_raw), "observed_at": value["observed_at"],
        "project": value["project"], "origin": value["origin"], "blockers": blockers,
        "current": {"source_sha": value["source_sha"], "manifest": value["current_manifest"],
                    "database_history": value["database"], "configuration_fingerprint": value["config_fingerprint"]},
        "proposed_controller": {"sha256": proposed_digest, "files": hashes, "archive": "controller-candidate.tar",
            "archive_sha256": sha256(package), "suggested_directory": "/opt/citygo/autodeploy-controller-" + proposed_digest[:16],
            "installed": False, "entrypoints_changed": False},
        "preserve_unchanged": {key: value[key] for key in ("controller_directory", "controller_sha256", "files", "bindings",
            "initial_bundle", "initial_manifest_sha256", "compose_file", "state_directory", "secrets", "systemd")},
        "candidate_migrations": migrations, "canonical_checksums": checksums, "grants_sha256": sha256(grants),
        "target": {"source_sha": None, "manifest_sha256": None, "artifact_id": None, "release_id": None,
                   "images": None, "postgres_base_must_equal": value["current_manifest"]["bases"]["postgres"]},
        "pilot_opening_gaps": ["live-yookassa-adapter-not-implemented"],
        "payment_status": {"production_mode": "disabled", "live_adapter_implemented": False,
                           "blocks_closed_release_with_payments_disabled": False},
        "profile": {"name": PROFILE, "approval_version": 3, "AI_CREDIT_MODE": "routerai_citygo_10x",
                    "YOOKASSA_MODE": "disabled", "api_secret_sha256": None},
        "draft_hashes_not_active_approval_pins": {name: sha256(wire(data)) for name, data in inactive.items()},
        "activation_warning": "Draft hashes are not future active approval pins. Fresh independently approved bytes and times must be bound in order; this tool cannot activate or install them."}
    outputs = {name: wire(data) for name, data in inactive.items()}
    outputs.update({"plan.json": wire(plan), "controller-candidate.tar": package})
    return outputs


def require_offline_user():
    require(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() != 0,
            "posix-nonroot-offline-user-required")


@contextmanager
def directory_anchor(path):
    """Hold every ancestor FD; never write through a mutable absolute path."""
    require(path.is_absolute() and ".." not in path.parts, "local-path")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    descriptors, edges = [], []
    try:
        descriptors.append(os.open("/", flags))
        for component in path.parts[1:]:
            parent = descriptors[-1]
            descriptor = os.open(component, flags, dir_fd=parent)
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            require(stat.S_ISDIR(info.st_mode), "output-parent-directory")
            edges.append((parent, component, info.st_dev, info.st_ino))
        def recheck():
            for parent, component, device, inode in edges:
                info = os.stat(component, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (device, inode),
                        "output-parent-changed")
        recheck()
        yield descriptors[-1], recheck
    finally:
        for descriptor in reversed(descriptors): os.close(descriptor)


def create_plan(source, observation_file, output, *, source_sha=None):
    require_offline_user()
    output = Path(output)
    require(output.is_absolute() and ".." not in output.parts and output.name not in ("", ".", ".."), "local-path")
    # POSIX-only materialization. Pure build() remains portable and never writes.
    with directory_anchor(output.parent) as (parent, recheck_parent):
        try: os.stat(output.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise PlanError("output-already-exists")
        raw = read_once(observation_file, 512 * 1024)
        outputs = build(source, raw, source_sha=source_sha)
        recheck_parent()
        try: os.mkdir(output.name, mode=0o700, dir_fd=parent)
        except FileExistsError: raise PlanError("output-already-exists") from None
        descriptor = os.open(output.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                             | getattr(os, "O_CLOEXEC", 0), dir_fd=parent)
        try:
            created = os.fstat(descriptor)
            require(stat.S_ISDIR(created.st_mode) and created.st_uid == os.geteuid()
                    and stat.S_IMODE(created.st_mode) == 0o700 and not os.listdir(descriptor), "output-directory-changed")
            def recheck():
                recheck_parent()
                current = os.stat(output.name, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISDIR(current.st_mode)
                        and (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino), "output-directory-changed")
            recheck()
            # Keep partial output on error as evidence; no overwrite or delete.
            for name, content in outputs.items():
                require(name in {"plan.json", "controller-candidate.tar", "preparation.draft.json", "migration.draft.json",
                                 "startup.draft.json", "finish.draft.json"}, "output-name")
                recheck()
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                             | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=descriptor)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
                    info = os.fstat(stream.fileno())
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                            and stat.S_IMODE(info.st_mode) == 0o600, "output-file-changed")
                recheck()
            os.fsync(descriptor); recheck(); os.fsync(parent)
        finally:
            os.close(descriptor)
    return {"kind": "citygo-closed-release-draft", "ready": False,
            "files": {name: sha256(content) for name, content in outputs.items()}}


class Parser(argparse.ArgumentParser):
    def error(self, _):
        self.exit(2, "Controller plan: invalid arguments; use --help\n")


def main(argv=None):
    parser = Parser(description=__doc__, allow_abbrev=False)
    for name in ("source", "observation", "output"): parser.add_argument("--" + name, required=True)
    parser.add_argument("--source-sha")
    args = parser.parse_args(argv)
    try:
        require_offline_user()
        result = create_plan(args.source, args.observation, args.output, source_sha=args.source_sha)
        print(json.dumps(result, sort_keys=True))
        return 0
    except PlanError as error:
        print("Controller plan refused: " + str(error), file=sys.stderr)
    except Exception:
        print("Controller plan refused: details-hidden", file=sys.stderr)
    return 1


if __name__ == "__main__": sys.exit(main())
