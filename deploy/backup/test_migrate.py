"""Synthetic independently approved continuation; no cloud, DB or real keys."""
import copy
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import backup as b
import migrate as c
import migration_job as m
import prepare as p
import target as t
import worker as w
import test_prepare as preparation_fixture
from test_prepare import IMAGES, ORIGIN
from test_migration_job import FakeDocker
from test_target import encoded


def synthetic_authorization(directory, selection, config, network):
    # Test writer only, never shipped in runtimeFiles. No actual approval.
    prepared = t.strict_json(selection.approval_file.read_bytes())
    now = int(time.time())
    value = {"version": 1, "purpose": "citygo-release-migration",
             "preparation_sha256": t.sha256(selection.approval_file.read_bytes()),
             "target_manifest_sha256": prepared["target_manifest_sha256"],
             "configuration_sha256": b.configuration_fingerprint(config), "project": config["project"],
             "origin": ORIGIN, "network_id": network, "approved_at": now - 1, "expires_at": now + 3600,
             "allow_migration": True, "allow_start": False, "allow_traffic": False}
    path = directory / "migration-approval.json"
    path.write_bytes(encoded(value)); path.chmod(0o600)
    return c.Approval(path)


class Validation(unittest.TestCase):
    def test_separate_scope_strict_types_dates_and_closed_capabilities(self):
        now = 2000000000
        value = {"version": 1, "purpose": "citygo-release-migration", "preparation_sha256": "a" * 64,
                 "target_manifest_sha256": "b" * 64, "configuration_sha256": "c" * 64,
                 "project": "citygo-fixture", "origin": ORIGIN, "network_id": "e" * 64,
                 "approved_at": now - 1, "expires_at": now + 1000,
                 "allow_migration": True, "allow_start": False, "allow_traffic": False}
        self.assertEqual(c.approval(encoded(value), now), value)
        for change in ({"version": True}, {"purpose": "citygo-release-preparation"}, {"allow_migration": 1},
                       {"allow_start": True}, {"allow_traffic": 0}, {"network_id": "database"},
                       {"approved_at": now + 1}, {"expires_at": now}, {"expires_at": now + 86400},
                       {"expires_at": float(now + 1)}, {"extra": 1}, {"origin": "http://localhost"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): c.approval(encoded({**value, **change}), now)

    def test_permissions_required_before_io_and_preparation_cannot_inject_continuation(self):
        with patch.object(b, "validate") as validate:
            with self.assertRaisesRegex(b.BackupError, "explicit-migration"):
                c.migrate({}, "b" * 40, ORIGIN, "/unused", IMAGES, "/unused")
            validate.assert_not_called()
        with self.assertRaisesRegex(b.BackupError, "prepare-only"):
            p.prepare({}, "b" * 40, ORIGIN, "/unused", IMAGES, authorization_check=lambda: None)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux real lock/protected files")
class Continuation(unittest.TestCase):
    def setUp(self):
        preparation_fixture.Preparation.setUp(self)
        self.authorization = synthetic_authorization(self.directory, self.selection, self.config, self.host.network_id)
        self.secret = self.directory / "migrate.json"
        self.secret.write_bytes(b'{"DATABASE_URL":"postgresql://citygo_migrator:synthetic@postgres:5432/citygo_pilot"}')
        self.secret.chmod(0o600)
        self.transport = FakeDocker()
        original = self.host.inventory
        def inventory():
            values = original()
            if self.transport.expected:
                v = self.transport.inspect("a" * 64)
                values.append({**v, "Labels": v["Config"]["Labels"], "RestartPolicy": "no"})
            return values
        self.host.inventory = inventory

    def migrate(self):
        return c.migrate(self.config, "b" * 40, ORIGIN, self.ingress, IMAGES, self.secret,
            allow_stop=True, allow_upload=True, allow_migration=True, selection=self.selection,
            authorization=self.authorization, image_store_factory=lambda _: self.image_store,
            host_factory=lambda *_: self.host, storage_factory=lambda *_: self.store,
            encryptor=self.encrypt, min_free=0, transport_factory=lambda *_: self.transport)

    def verify(self):
        return self.authorization.verify(self.selection, self.config, "b" * 40, ORIGIN, IMAGES)

    def rewrite(self, change):
        value = json.loads(self.authorization.path.read_bytes())
        value.update(change); self.authorization.path.write_bytes(encoded(value))

    def assert_not_started(self):
        self.assertNotIn("execute", self.transport.events)
        self.assertFalse(list(self.state.glob("*.success.json")))

    def test_success_connects_drain_backup_migration_under_one_lock_but_never_reopens(self):
        w.open_admission(self.config)
        def started():
            self.assertTrue(self.pending.exists())
            self.assertEqual(len(self.store.objects), 2)
            self.assertEqual(self.host.events, ["close", "stop:api", "stop:worker"])
            self.assertFalse((self.state / w.ADMISSION).exists())
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                with b.lock(self.state): pass
        self.transport.on_execute = started
        proof = self.migrate()
        self.assertEqual(self.transport.events, ["create", "execute"])
        self.assertTrue(proof["migration"]["result"]["committed"])
        self.assertFalse(proof["traffic_authorized"])
        self.assertFalse(proof["preparation"]["migration_authorized"])
        self.assertEqual(proof["preparation"]["operation_id"], proof["migration"]["operation_id"])
        self.assertTrue(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertEqual(len(list(self.state.glob("migration-approval-*.used.json"))), 1)
        with self.assertRaisesRegex(b.BackupError, "migration-approval-already-used"): self.migrate()

    def test_same_approval_cannot_be_reused_even_if_pending_is_manually_removed(self):
        self.migrate()
        self.pending.unlink()  # ONLY this disposable test; NOT a recovery instruction.
        self.authorization = c.Approval(self.authorization.path)
        with self.assertRaisesRegex(b.BackupError, "migration-approval-already-used"): self.migrate()

    def test_preparation_permission_alone_does_not_grant_migration(self):
        self.authorization.path.write_bytes(self.selection.approval_file.read_bytes())
        with self.assertRaises(b.BackupError): self.migrate()
        self.assertEqual(self.host.events, []); self.assertEqual(self.store.calls, [])
        self.assertFalse(self.pending.exists()); self.assert_not_started()

    def test_wrong_binding_fails_before_downtime(self):
        for key in ("preparation_sha256", "target_manifest_sha256", "configuration_sha256"):
            data = self.authorization.path.read_bytes()
            self.rewrite({key: "f" * 64})
            with self.subTest(key=key), self.assertRaisesRegex(b.BackupError, "migration-approval-binding"): self.migrate()
            self.authorization.path.write_bytes(data); self.authorization = c.Approval(self.authorization.path)
        self.assertEqual(self.host.events, []); self.assertFalse(self.pending.exists())

    def test_self_approval_and_shared_preparation_file_are_refused(self):
        self.authorization = c.Approval(self.selection.approval_file)
        with self.assertRaisesRegex(b.BackupError, "migration-self-approval"): self.verify()
        self.authorization = c.Approval(self.selection.target_directory / "approval.json")
        with self.assertRaisesRegex(b.BackupError, "migration-self-approval"): self.verify()

    def test_observed_revocation_cannot_be_repaired(self):
        self.verify(); data = self.authorization.path.read_bytes()
        self.authorization.path.unlink()
        with self.assertRaises(OSError): self.verify()
        self.authorization.path.write_bytes(data); self.authorization.path.chmod(0o600)
        with self.assertRaisesRegex(b.BackupError, "migration-approval-invalidated"): self.verify()

    def test_expiry_during_bundle_read_is_rechecked(self):
        value = json.loads(self.authorization.path.read_bytes())
        with patch.object(c.time, "time", side_effect=[value["approved_at"] + 1, value["expires_at"]] * 20):
            with self.assertRaises(b.BackupError): self.verify()

    def test_wrong_network_refuses_before_any_writer_stop(self):
        self.rewrite({"network_id": "d" * 64})
        with self.assertRaisesRegex(b.BackupError, "approved-network-changed"): self.migrate()
        self.assertEqual(self.host.events, ["close"]); self.assertEqual(self.store.calls, [])
        self.assertTrue(self.pending.exists()); self.assert_not_started()

    def test_revocation_during_drain_stops_before_backup(self):
        self.host.on_stop = lambda: self.authorization.path.unlink()
        with self.assertRaises(OSError): self.migrate()
        self.assertEqual(self.store.calls, []); self.assertTrue(self.pending.exists()); self.assert_not_started()

    def test_revocation_after_backup_stops_before_create(self):
        original = self.encrypt
        def encrypt(*args):
            original(*args); self.authorization.path.unlink()
        self.encrypt = encrypt
        with self.assertRaises(OSError): self.migrate()
        self.assertEqual(self.transport.events, []); self.assertTrue(self.pending.exists())

    def test_guard_rejects_restarted_api_after_job_create(self):
        self.transport.on_create = lambda: self.host.values[2]["State"].update(Status="running", Running=True)
        with self.assertRaisesRegex(b.BackupError, "writer-active"): self.migrate()
        self.assert_not_started(); self.assertTrue(self.pending.exists())

    def test_guard_rejects_extra_network_peer_after_create(self):
        self.transport.on_create = lambda: self.host.extra_peers.append("f" * 64)
        with self.assertRaisesRegex(b.BackupError, "database-network-unexpected-peer"): self.migrate()
        self.assert_not_started()

    def test_guard_rejects_ingress_reopening_after_create(self):
        self.transport.on_create = lambda: setattr(self.host, "closed", False)
        with self.assertRaisesRegex(b.BackupError, "ingress-not-closed"): self.migrate()
        self.assert_not_started()

    def test_guard_rejects_secret_change_after_create(self):
        self.transport.on_create = lambda: self.secret.write_bytes(self.secret.read_bytes().replace(b"synthetic", b"changed"))
        with self.assertRaisesRegex(b.BackupError, "migration-secret-changed"): self.migrate()
        self.assert_not_started()

    def test_job_failure_keeps_spent_approval_pending_and_no_prepared_receipt(self):
        def fail(): raise b.BackupError("synthetic-uncertain-commit")
        self.transport.on_execute = fail
        with self.assertRaisesRegex(b.BackupError, "synthetic-uncertain-commit"): self.migrate()
        self.assertTrue(self.pending.exists())
        self.assertTrue(list(self.state.glob("migration-approval-*.used.json")))
        self.assertFalse((self.state / "release-prepared.json").exists())
        self.assertFalse(list(self.state.glob("*.success.json")))

    def test_post_commit_guard_failure_never_reports_whole_operation_success(self):
        self.transport.on_execute = lambda: self.authorization.path.unlink()
        with self.assertRaises(OSError): self.migrate()
        self.assertEqual(self.transport.phase, "exited")
        self.assertTrue(self.pending.exists()); self.assertFalse(list(self.state.glob("*.success.json")))


if __name__ == "__main__": unittest.main()
