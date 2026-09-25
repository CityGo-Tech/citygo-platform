"""Synthetic approvals/bundles only. No trusted user approval is created by tests."""
import copy
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import backup as b
import target as t
from test_backup import sample

ORIGIN = "https://pilot.example.test"
IMAGES = {role: "sha256:" + "c" * 64 for role in t.SERVICES}


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def manifest_fixture(sha="b" * 40, *, current=False):
    files = t.BASELINE if current else t.FILES
    return {"version": 1, "kind": "candidate-not-deployed", "repository": t.REPOSITORY,
            "sourceSha": sha, "releaseId": sha + "-123-1", "platform": "linux/amd64",
            "run": {"id": "123", "attempt": "1", "checks": [
                {"workflow": "ci.yml", "id": 101, "attempt": 1},
                {"workflow": "container-smoke.yml", "id": 102, "attempt": 1}]},
            "bases": {"node": "node:24-bookworm-slim@sha256:" + "c" * 64,
                      "postgres": "postgres:17-alpine@sha256:" + "d" * 64},
            "images": {role: f"ghcr.io/citygo-tech/citygo-platform-{role}@sha256:" + ("d" if current else "e") * 64 for role in t.ROLES},
            "imageIds": {role: "sha256:" + "c" * 64 for role in t.ROLES},
            "migrations": [{"name": "0001_fixture.sql", "sha256": "f" * 64}],
            "runtimeFiles": [{"path": p, "sha256": t.sha256(b"# synthetic fixture, never executed\n")} for p in sorted(files)],
            "policy": dict(t.POLICY)}


def approval_fixture(now=None):
    now = int(time.time()) if now is None else now
    return {"version": 1, "purpose": "citygo-release-preparation", "repository_id": t.REPOSITORY_ID,
            "organization_id": t.ORGANIZATION_ID, "artifact_id": "456", "project": "citygo-fixture", "origin": ORIGIN,
            "current_manifest_sha256": "a" * 64, "target_manifest_sha256": "b" * 64,
            "target_release_id": "b" * 40 + "-123-1", "target_sha": "b" * 40,
            "configuration_sha256": "c" * 64, "current_images": dict(IMAGES),
            "approved_at": now - 1, "expires_at": now + 3600, "allow_preparation": True, "allow_migration": False}


def synthetic_selection(directory, config, images, origin=ORIGIN):
    """Only disposable tests import this writer; it is absent from runtime bundle."""
    current, target = directory / "current-bundle", directory / "target-bundle"
    values = [manifest_fixture(config["source_sha"], current=True), manifest_fixture()]
    values[0]["imageIds"] = {"api": images["api"], "web": images["web"], "jobs": images["worker"]}
    values[1]["migrations"].append({"name": "0002_fixture.sql", "sha256": "e" * 64})
    for root, value in zip((current, target), values):
        root.mkdir(mode=0o700)
        for entry in value["runtimeFiles"]:
            path = root / entry["path"]
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(b"# synthetic fixture, never executed\n"); path.chmod(0o600)
        (root / "release.json").write_bytes(encoded(value)); (root / "release.json").chmod(0o600)
    approved = approval_fixture()
    approved.update(current_manifest_sha256=t.sha256(encoded(values[0])), target_manifest_sha256=t.sha256(encoded(values[1])),
                    configuration_sha256=b.configuration_fingerprint(config), current_images=copy.deepcopy(images),
                    project=config["project"], origin=origin)
    path = directory / "approval.json"
    path.write_bytes(encoded(approved)); path.chmod(0o600)
    return t.Selection(current, target, path)


class Validation(unittest.TestCase):
    def test_strict_json_rejects_duplicate_keys_constants_and_unbounded_input(self):
        for data in (b'{"version":1,"version":1}', b'{"nested":{"a":1,"a":2}}', b'{"x":NaN}', b'{"x":Infinity}',
                     b"[" * 2000, b"x" * (t.LIMIT + 1), b"\xff", b"not json"):
            with self.subTest(data=data[:30]), self.assertRaises(b.BackupError): t.strict_json(data)

    def test_candidate_identity_policy_images_and_closed_paths(self):
        good = manifest_fixture()
        self.assertEqual(t.manifest(encoded(good)), good)
        self.assertEqual(t.manifest(encoded(manifest_fixture(current=True)), current=True)["sourceSha"], "b" * 40)
        changes = [{"version": True}, {"repository": "other/project"}, {"kind": "deployed"}, {"platform": "linux/arm64"},
                   {"releaseId": "main"}, {"run": {**good["run"], "attempt": "2"}}, {"policy": {**t.POLICY, "deploymentApproved": True}},
                   {"policy": {**t.POLICY, "automaticRollback": 0}}, {"extra": "not allowed"},
                   {"images": {**good["images"], "api": "ghcr.io/citygo-tech/citygo-platform-api:latest"}},
                   {"imageIds": {**good["imageIds"], "jobs": "bad"}},
                   {"bases": {**good["bases"], "postgres": "postgres:18@sha256:" + "d" * 64}},
                   {"runtimeFiles": good["runtimeFiles"][:-1]}, {"runtimeFiles": [*good["runtimeFiles"][:-1], good["runtimeFiles"][0]]}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(b.BackupError): t.manifest(encoded({**good, **change}))
        for path in ("../secret", "/etc/passwd", "deploy\\evil", "deploy/unknown.py", "deploy/.env"):
            bad = copy.deepcopy(good); bad["runtimeFiles"][0]["path"] = path
            with self.assertRaises(b.BackupError): t.manifest(encoded(bad))

    def test_migrations_checks_reject_reordering_duplicates_and_ambiguous_versions(self):
        good = manifest_fixture()
        for entries in ([], [{"name": "0000_invalid.sql", "sha256": "f" * 64}],
                        good["migrations"] * 2, [*good["migrations"], {"name": "0001_other.sql", "sha256": "e" * 64}],
                        [{"name": "0002_later.sql", "sha256": "e" * 64}, *good["migrations"]]):
            with self.assertRaises(b.BackupError): t.manifest(encoded({**good, "migrations": entries}))
        bad = copy.deepcopy(good); bad["run"]["checks"][1] = bad["run"]["checks"][0]
        with self.assertRaises(b.BackupError): t.manifest(encoded(bad))

    def test_approval_requires_explicit_scope_fixed_repo_fresh_bounded_time(self):
        good = approval_fixture(2000000000)
        t.approval(encoded(good), 2000000000)
        for change in ({"allow_preparation": False}, {"allow_preparation": 1}, {"allow_migration": True},
                       {"purpose": "deploy"}, {"repository_id": 1}, {"organization_id": 1},
                       {"expires_at": 2000000000}, {"approved_at": 2000000001}, {"expires_at": 2000100000},
                       {"expires_at": 2000000001.0}, {"target_sha": "main"}, {"current_images": {}}, {"artifact_id": ""}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): t.approval(encoded({**good, **change}), 2000000000)

    def test_publisher_inventory_matches_trusted_gate_and_excludes_test_writers(self):
        publisher = (Path(__file__).resolve().parents[2] / "scripts/release-candidate.mjs").read_text(encoding="utf-8")
        block = publisher.split("export const runtimeFiles = [", 1)[1].split("];", 1)[0]
        self.assertEqual(set(re.findall(r'"([^"\n]+)"', block)), t.FILES)
        self.assertTrue(t.BASELINE < t.FILES)
        self.assertFalse(any("test_" in name or "smoke" in name or "approval.json" in name for name in t.FILES))


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected runtime bundles")
class Files(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="citygo-target-test-"); self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.config = sample(self.directory)
        for name in ("compose.yml", "pilot.env"):
            path = self.directory / name; path.write_text("# fixture"); path.chmod(0o600)
        self.selection = synthetic_selection(self.directory, self.config, IMAGES)

    def verify(self):
        return self.selection.verify(self.config, "b" * 40, ORIGIN, IMAGES)

    def rewrite(self, path, change):
        value = json.loads(path.read_bytes()); change(value); path.write_bytes(encoded(value))

    def approve_target_bytes(self):
        digest = t.sha256((self.selection.target_directory / "release.json").read_bytes())
        self.rewrite(self.selection.approval_file, lambda v: v.update(target_manifest_sha256=digest))

    def test_success_is_read_only_and_returns_no_deploy_capability(self):
        before = {str(p): p.read_bytes() for p in self.directory.rglob("*") if p.is_file()}
        proof = self.verify()
        self.assertEqual(len(proof["new_migrations"]), 1)
        self.assertFalse(proof["migration_authorized"])
        self.assertEqual(self.verify(), proof)
        proof["images"]["api"] = "changed"
        self.assertNotEqual(self.verify()["images"]["api"], "changed")
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.directory.rglob("*") if p.is_file()})

    def test_tampered_runtime_poison_cannot_be_repaired_for_same_selection(self):
        self.verify()
        path = self.selection.target_directory / "deploy/compose.pilot.yml"
        previous = path.read_bytes(); path.write_bytes(b"altered")
        with self.assertRaisesRegex(b.BackupError, "target-file-hash"): self.verify()
        path.write_bytes(previous)
        with self.assertRaisesRegex(b.BackupError, "target-selection-invalidated"): self.verify()

    def test_manifest_hash_checked_before_schema_or_any_execution(self):
        path = self.selection.target_directory / "release.json"
        path.write_bytes(b"not valid, sensitive diagnostic must not be shown")
        with self.assertRaisesRegex(b.BackupError, "^target-manifest-hash$"): self.verify()

    def test_new_approval_after_first_verification_cannot_rebind_target(self):
        self.verify()
        self.rewrite(self.selection.approval_file, lambda v: v.update(artifact_id="457"))
        with self.assertRaisesRegex(b.BackupError, "target-approval-changed"): self.verify()

    def test_expiry_is_checked_again_after_reading_bundle(self):
        now = int(time.time())
        with patch.object(t.time, "time", side_effect=[now, now + 90000]):
            with self.assertRaisesRegex(b.BackupError, "target-expired"): self.verify()

    def test_configuration_and_inventory_binding_fail_closed(self):
        (self.directory / "pilot.env").write_text("# changed")
        with self.assertRaisesRegex(b.BackupError, "target-binding"): self.verify()

    def test_rewritten_migration_history_cannot_be_approved_by_manifest_hash(self):
        path = self.selection.target_directory / "release.json"
        self.rewrite(path, lambda v: v["migrations"][0].update(sha256="1" * 64))
        self.approve_target_bytes()
        with self.assertRaisesRegex(b.BackupError, "target-migration-history"): self.verify()

    def test_postgres_image_change_needs_a_separate_upgrade_path(self):
        path = self.selection.target_directory / "release.json"
        self.rewrite(path, lambda v: v["bases"].update(postgres="postgres:17-alpine@sha256:" + "1" * 64))
        self.approve_target_bytes()
        with self.assertRaisesRegex(b.BackupError, "target-postgres-upgrade"): self.verify()

    def test_unknown_file_and_empty_directory_are_rejected(self):
        for directory in (True, False):
            path = self.selection.target_directory / "extra"
            path.mkdir() if directory else path.write_text("private")
            with self.assertRaisesRegex(b.BackupError, "target-tree"):
                t.bundle(self.selection.target_directory, json.loads(self.selection.approval_file.read_bytes())["target_manifest_sha256"])
            path.rmdir() if directory else path.unlink()

    def test_symlink_hardlink_and_writable_runtime_are_rejected(self):
        path = self.selection.target_directory / "deploy/compose.pilot.yml"
        data = path.read_bytes(); path.unlink()
        source = self.directory / "outside"; source.write_bytes(data); source.chmod(0o600)
        expected = json.loads(self.selection.approval_file.read_bytes())["target_manifest_sha256"]
        path.symlink_to(source)
        with self.assertRaises(b.BackupError): t.bundle(self.selection.target_directory, expected)
        path.unlink(); os.link(source, path)
        with self.assertRaises(b.BackupError): t.bundle(self.selection.target_directory, expected)
        path.unlink(); path.write_bytes(data); path.chmod(0o666)
        with self.assertRaises(b.BackupError): t.bundle(self.selection.target_directory, expected)

    def test_self_approval_and_readable_approval_are_rejected(self):
        self.selection.approval_file.chmod(0o644)
        with self.assertRaises(b.BackupError): self.verify()
        selection = t.Selection(self.selection.current_directory, self.selection.target_directory,
                                self.selection.target_directory / "approval.json")
        with self.assertRaisesRegex(b.BackupError, "target-self-approval"):
            selection.verify(self.config, "b" * 40, ORIGIN, IMAGES)


if __name__ == "__main__": unittest.main()
