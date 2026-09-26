"""Read-only, offline release selection gate. No downloads, execution or approval writer.

Trust comes from an independently reviewed, protected operator approval OUTSIDE
both bundles. A candidate's own JSON/labels cannot approve itself. This is not an
attestation verifier, a migration compatibility proof or a deployment permission.
"""
import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

import backup as b

REPOSITORY = "CityGo-Tech/citygo-platform"
REPOSITORY_ID = 1351070410
ORGANIZATION_ID = 248379281
ROLES = {"api", "web", "jobs"}
SERVICES = {"api", "web", "postgres", "worker", "migrator", "backup"}
HASH = r"[0-9a-f]{64}"
DIGEST = r"sha256:" + HASH
SHA = r"[0-9a-f]{40}"
LIMIT = 262144
# Keep in sync with the publisher; a test compares the two inventories exactly.
FILES = frozenset({
    "deploy/compose.pilot.yml", "deploy/pilot.env.example", "deploy/render-pilot.mjs",
    "deploy/nginx/pilot.conf.template", "deploy/postgres/postgresql.conf",
    "deploy/postgres/init.sql", "deploy/postgres/grants.sql", "deploy/postgres/dump.sh",
    "deploy/backup/backup.py", "deploy/backup/worker.py", "deploy/backup/release.py",
    "deploy/backup/control.py", "deploy/backup/recovery.py", "docs/runbooks/release-operator.md",
    "deploy/backup/prepare.py", "deploy/backup/target.py", "deploy/backup/image_gate.py", "deploy/backup/migration_job.py", "deploy/backup/migrate.py", "deploy/backup/start.py", "deploy/backup/finish.py", "deploy/backup/config.example.json",
    "deploy/backup/notify.py", "deploy/backup/schedule.py", "deploy/backup/mail.example.json",
    "deploy/backup/schedule.example.json", "deploy/backup/systemd/citygo-backup.service.template",
    "deploy/backup/systemd/citygo-backup.timer.template",
    "deploy/backup/systemd/citygo-backup-check.service.template",
    "deploy/backup/systemd/citygo-backup-check.timer.template",
    "docs/runbooks/cloudru-runtime.md", "docs/runbooks/encrypted-backup.md",
    "docs/runbooks/backup-operations.md", "docs/runbooks/worker-coordination.md",
    "docs/runbooks/release-backup-window.md", "docs/runbooks/release-preparation.md",
    "docs/runbooks/release-target.md", "docs/runbooks/release-images.md", "docs/runbooks/release-migration.md", "docs/runbooks/release-migration-job.md", "docs/runbooks/release-approved-migration.md", "docs/runbooks/release-start-health.md", "docs/runbooks/release-finish.md", "docs/runbooks/release-candidate.md",
})
# The first delivered candidate predates Worker/drain/prepare helpers. Current
# manifests may contain this baseline plus known additions, never arbitrary paths.
BASELINE = frozenset({
    "deploy/compose.pilot.yml", "deploy/pilot.env.example", "deploy/render-pilot.mjs",
    "deploy/nginx/pilot.conf.template", "deploy/postgres/postgresql.conf",
    "deploy/postgres/init.sql", "deploy/postgres/grants.sql", "deploy/postgres/dump.sh",
    "deploy/backup/backup.py", "deploy/backup/config.example.json",
    "docs/runbooks/cloudru-runtime.md", "docs/runbooks/encrypted-backup.md",
    "docs/runbooks/release-candidate.md",
})
POLICY = {"llmProvider": "disabled", "deploymentApproved": False,
          "automaticRollback": False, "schemaCompatibility": "operator-review-required"}


def matches(value, pattern):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def keys(value, expected, code):
    b.require(type(value) is dict and set(value) == set(expected), code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            b.require(key not in result, "target-json")
            result[key] = value
        return result
    def constant(_value):
        raise b.BackupError("target-json")
    b.require(type(data) is bytes and len(data) <= LIMIT, "target-json")
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise b.BackupError("target-json") from None


def manifest(data, *, current=False):
    value = strict_json(data)
    keys(value, {"version", "kind", "repository", "sourceSha", "releaseId", "platform", "run",
                 "bases", "images", "imageIds", "migrations", "runtimeFiles", "policy"}, "target-manifest")
    b.require(type(value["version"]) is int and value["version"] == 1
              and value["kind"] == "candidate-not-deployed" and value["repository"] == REPOSITORY
              and value["platform"] == "linux/amd64" and matches(value["sourceSha"], SHA), "target-manifest")
    keys(value["policy"], POLICY, "target-policy")
    b.require(value["policy"] == POLICY and value["policy"]["deploymentApproved"] is False
              and value["policy"]["automaticRollback"] is False, "target-policy")
    run = value["run"]
    keys(run, {"id", "attempt", "checks"}, "target-run")
    b.require(matches(run["id"], r"[1-9][0-9]{0,19}") and matches(run["attempt"], r"[1-9][0-9]{0,5}"), "target-run")
    b.require(value["releaseId"] == f'{value["sourceSha"]}-{run["id"]}-{run["attempt"]}', "target-run")
    checks = run["checks"]
    b.require(type(checks) is list and len(checks) == 2, "target-checks")
    for check in checks:
        keys(check, {"workflow", "id", "attempt"}, "target-checks")
        b.require(type(check["id"]) is int and 0 < check["id"] < 2**53
                  and type(check["attempt"]) is int and 0 < check["attempt"] < 10**6, "target-checks")
        b.require(check["workflow"] in ("ci.yml", "container-smoke.yml"), "target-checks")
    b.require(len({c["workflow"] for c in checks}) == 2 and len({c["id"] for c in checks}) == 2, "target-checks")
    keys(value["bases"], {"node", "postgres"}, "target-bases")
    for name, tag in (("node", "node:24-bookworm-slim"), ("postgres", "postgres:17-alpine")):
        b.require(matches(value["bases"][name], re.escape(tag) + "@" + DIGEST), "target-bases")
    keys(value["images"], ROLES, "target-images")
    keys(value["imageIds"], ROLES, "target-images")
    for role in ROLES:
        b.require(matches(value["images"][role], "ghcr\\.io/citygo-tech/citygo-platform-" + role + "@" + DIGEST)
                  and matches(value["imageIds"][role], DIGEST), "target-images")
    migrations = value["migrations"]
    b.require(type(migrations) is list and 1 <= len(migrations) <= 1000, "target-migrations")
    for entry in migrations:
        keys(entry, {"name", "sha256"}, "target-migrations")
        b.require(matches(entry["name"], r"[0-9]{4}_[a-z0-9_]+\.sql")
                  and matches(entry["sha256"], HASH), "target-migrations")
    numbers = [int(e["name"][:4]) for e in migrations]
    b.require(numbers == sorted(set(numbers)) and numbers[0] > 0, "target-migrations")
    files = value["runtimeFiles"]
    b.require(type(files) is list and len(BASELINE) <= len(files) <= len(FILES), "target-files")
    for entry in files:
        keys(entry, {"path", "sha256"}, "target-files")
        b.require(type(entry["path"]) is str and entry["path"] in FILES
                  and matches(entry["sha256"], HASH), "target-files")
    paths = {e["path"] for e in files}
    b.require(len(paths) == len(files) and (BASELINE <= paths if current else paths == FILES), "target-files")
    return value


def read_file(path, *, private=False):
    path = b.protected(path, private=private)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        b.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                  and not info.st_mode & (0o077 if private else 0o022) and info.st_size <= LIMIT, "target-file")
        data = stream.read(LIMIT + 1)
        b.require(len(data) <= LIMIT, "target-file")
        return data


def bundle(directory, expected_hash, *, current=False):
    directory = b.protected(directory, directory=True, private=False)
    data = read_file(directory / "release.json")
    b.require(sha256(data) == expected_hash, "target-manifest-hash")
    value = manifest(data, current=current)
    expected = {e["path"]: e["sha256"] for e in value["runtimeFiles"]}
    expected["release.json"] = expected_hash
    parents = {str(parent.as_posix()) for name in expected for parent in Path(name).parents if str(parent) != "."}
    # Exact tree, including empty directories: no hidden .env, archive, symlink,
    # FIFO, hardlink, or unknown executable can accompany a reviewed manifest.
    pending, found, count = [directory], set(), 0
    while pending:
        parent = pending.pop()
        with os.scandir(parent) as entries:
            for entry in entries:
                count += 1
                b.require(count <= len(expected) + len(parents), "target-tree")
                path = Path(entry.path)
                relative = path.relative_to(directory).as_posix()
                if entry.is_dir(follow_symlinks=False):
                    b.require(relative in parents, "target-tree")
                    b.protected(path, directory=True, private=False)
                    pending.append(path)
                else:
                    b.require(relative in expected, "target-tree")
                    b.require(sha256(read_file(path)) == expected[relative], "target-file-hash")
                    found.add(relative)
    b.require(found == set(expected), "target-tree")
    return value


def retained_jobs(value):
    """Exact inert process evidence, not permission to run an older image.

    Supplied only in an independent v2 preparation approval, never auto-discovered
    from receipts. Failed, running, restarted, duplicate or application/DB entries
    are never eligible. No environment, secrets, commands or wildcard selectors.
    """
    b.require(type(value) is list and len(value) <= 61, "retained-jobs")
    found = {}
    for entry in value:
        keys(entry, {"id", "image", "name", "role", "started_at", "restart_count", "init", "grace",
                     "restart_policy", "status", "exit_code", "finished_at"}, "retained-job")
        b.require(matches(entry["id"], HASH) and entry["id"] not in found and matches(entry["image"], DIGEST)
                  and matches(entry["name"], r"/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}")
                  and entry["role"] in ("worker", "migrator", "backup"), "retained-job")
        b.require(entry["status"] == "exited" and type(entry["exit_code"]) is int and entry["exit_code"] == 0
                  and type(entry["restart_count"]) is int and entry["restart_count"] == 0
                  and entry["restart_policy"] == "no", "retained-job-state")
        b.require((entry["init"] is None or type(entry["init"]) is bool)
                  and (entry["grace"] is None or type(entry["grace"]) is int and 0 <= entry["grace"] <= 3600), "retained-job-runtime")
        if entry["role"] == "worker":
            b.require(entry["init"] is True and entry["grace"] == 90, "retained-job-runtime")
        times = []
        for key in ("started_at", "finished_at"):
            b.require(type(entry[key]) is str and entry[key].endswith("Z"), "retained-job-time")
            try: parsed = datetime.fromisoformat(entry[key][:-1] + "+00:00")
            except ValueError: raise b.BackupError("retained-job-time") from None
            b.require(parsed.year > 1970, "retained-job-time")
            times.append(parsed)
        b.require(times[1] >= times[0], "retained-job-time")
        found[entry["id"]] = copy.deepcopy(entry)
    return found


def approval(data, now):
    value = strict_json(data)
    b.require(type(value) is dict and type(value.get("version")) is int and value["version"] in (1, 2), "target-approval")
    fields = {"version", "purpose", "repository_id", "organization_id", "artifact_id",
                 "current_manifest_sha256", "target_manifest_sha256", "target_release_id", "target_sha",
                 "project", "origin", "configuration_sha256", "current_images", "approved_at", "expires_at",
                 "allow_preparation", "allow_migration"}
    keys(value, fields | ({"retained_jobs"} if value["version"] == 2 else set()), "target-approval")
    if value["version"] == 2: retained_jobs(value["retained_jobs"])
    b.require(value["purpose"] == "citygo-release-preparation"
              and type(value["repository_id"]) is int and value["repository_id"] == REPOSITORY_ID
              and type(value["organization_id"]) is int and value["organization_id"] == ORGANIZATION_ID
              and matches(value["artifact_id"], r"[1-9][0-9]{0,19}"), "target-approval")
    b.require(value["allow_preparation"] is True and value["allow_migration"] is False, "target-approval")
    for key in ("current_manifest_sha256", "target_manifest_sha256", "configuration_sha256"):
        b.require(matches(value[key], HASH), "target-approval")
    b.require(matches(value["target_sha"], SHA)
              and matches(value["target_release_id"], SHA + r"-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}")
              and matches(value["project"], r"citygo-[a-z0-9][a-z0-9-]{0,62}"), "target-approval")
    b.require(type(value["origin"]) is str, "target-approval")  # Compared with the caller's validated exact origin.
    keys(value["current_images"], SERVICES, "target-approval")
    b.require(all(matches(v, DIGEST) for v in value["current_images"].values()), "target-approval")
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400, "target-expired")
    return value


class Selection:
    """Paths only; verify re-reads all evidence, never imports target bundle code.

    First successful verification pins approval bytes for this object. Mutation,
    revocation, expiry or drift observed afterwards permanently invalidates it.
    Callers must not use a returned projection as a future deployment capability.
    """
    def __init__(self, current_directory, target_directory, approval_file):
        self.current_directory = Path(current_directory)
        self.target_directory = Path(target_directory)
        self.approval_file = Path(approval_file)
        self._pin = None
        self._failed = False

    def verify(self, config, target_sha, origin, images):
        b.require(not self._failed, "target-selection-invalidated")
        try:
            b.require(sys.platform.startswith("linux"), "linux-required")
            # No self-approval from either delivered directory, including nesting.
            for path in (self.current_directory, self.target_directory, self.approval_file):
                b.require(path.is_absolute() and ".." not in path.parts, "target-path")
            b.require(self.current_directory != self.target_directory
                      and not self.current_directory.is_relative_to(self.target_directory)
                      and not self.target_directory.is_relative_to(self.current_directory), "target-path")
            b.require(all(not self.approval_file.is_relative_to(root)
                          for root in (self.current_directory, self.target_directory)), "target-self-approval")
            data = read_file(self.approval_file, private=True)
            pin = sha256(data)
            b.require(self._pin is None or self._pin == pin, "target-approval-changed")
            approved = approval(data, time.time())
            b.require(approved["project"] == config["project"] and approved["origin"] == origin
                      and approved["target_sha"] == target_sha and approved["current_images"] == images
                      and approved["configuration_sha256"] == b.configuration_fingerprint(config), "target-binding")
            current = bundle(self.current_directory, approved["current_manifest_sha256"], current=True)
            target = bundle(self.target_directory, approved["target_manifest_sha256"])
            b.require(current["sourceSha"] == config["source_sha"] and target["sourceSha"] == target_sha
                      and target["releaseId"] == approved["target_release_id"]
                      and current["sourceSha"] != target["sourceSha"], "target-binding")
            old = current["migrations"]
            b.require(target["migrations"][:len(old)] == old, "target-migration-history")
            b.require(current["bases"]["postgres"] == target["bases"]["postgres"], "target-postgres-upgrade")
            # Read again AFTER hashing the bundles; no expired/revoked approval can
            # survive a long verification. The immutable-runtime operator rule remains.
            latest = read_file(self.approval_file, private=True)
            b.require(sha256(latest) == pin, "target-approval-changed")
            approval(latest, time.time())
            self._pin = pin
            return copy.deepcopy({"approval_sha256": pin, "artifact_id": approved["artifact_id"],
                "current_manifest_sha256": approved["current_manifest_sha256"],
                "target_manifest_sha256": approved["target_manifest_sha256"], "target_sha": target_sha,
                "release_id": target["releaseId"], "run": target["run"], "images": target["images"],
                "image_ids": target["imageIds"], "new_migrations": target["migrations"][len(old):],
                "current": {"source_sha": current["sourceSha"], "images": current["images"],
                            "image_ids": current["imageIds"], "postgres": current["bases"]["postgres"]},
                "retained_jobs": approved.get("retained_jobs", []),
                "expires_at": approved["expires_at"], "migration_authorized": False})
        except Exception:
            self._failed = True
            raise
