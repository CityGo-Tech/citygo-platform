"""Fresh authority + unchanged live evidence; NEVER fake resume of migration."""
import copy
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import backup as b
import finish as f
import recovery as r
import target as t
import worker as w
import test_finish as fixture
from test_control import synthetic_request
from test_target import encoded


def synthetic_recovery_approval(directory, report):
    now = int(time.time())
    value = {"version": 1, "purpose": "citygo-recovery-closed-commit", "config_path": report["config_path"],
             "operation_id": report["operation_id"], "observation_sha256": report["observation_sha256"],
             "approved_at": now - 1, "expires_at": now + 1800, "allow_settle": True,
             "allow_migration": False, "allow_start": False, "allow_traffic": False, "allow_worker": False}
    path = directory / "recovery-approval.json"
    path.write_bytes(encoded(value)); path.chmod(0o600)
    return path


class Validation(unittest.TestCase):
    def test_scope_cannot_authorize_migration_start_or_traffic(self):
        now = 2000000000
        good = {"version": 1, "purpose": "citygo-recovery-closed-commit", "config_path": "/etc/citygo/backup.json",
                "operation_id": "a" * 32, "observation_sha256": "b" * 64, "approved_at": now - 1,
                "expires_at": now + 100, "allow_settle": True, "allow_migration": False,
                "allow_start": False, "allow_traffic": False, "allow_worker": False}
        self.assertEqual(r.approval(encoded(good), now), good)
        for change in ({"version": True}, {"allow_settle": 1}, {"allow_start": True}, {"allow_migration": True},
                       {"allow_worker": True}, {"allow_traffic": 0}, {"operation_id": "../../other"},
                       {"expires_at": now}, {"expires_at": now + 3600}, {"approved_at": now + 1}, {"extra": 1}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): r.approval(encoded({**good, **change}), now)
        with self.assertRaisesRegex(b.BackupError, "explicit-recovery"):
            r.settle("/unused", "/unused")


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux real barrier recovery")
class Recovery(unittest.TestCase):
    def setUp(self):
        setup = (fixture.CityGo10xCutover if getattr(self, "citygo_10x_profile", False) else
                 fixture.RouterAiCutover if getattr(self, "routerai_profile", False) else fixture.Cutover)
        if setup is not fixture.Cutover: self.profile = setup.profile
        setup.setUp(self)
        self.request = synthetic_request(self)
        # Interrupt only the FINAL barrier removal, after real in-process startup
        # gates and configuration/active writes. No production monkeypatch exists.
        with patch.object(b, "complete_operation", side_effect=OSError("synthetic-crash-before-unlink")), self.assertRaises(OSError):
            fixture.Cutover.finish(self)
        self.options = {"host_factory": lambda *_: self.host, "image_store_factory": lambda _: self.image_store}

    def inspect(self): return r.inspect(self.request, **self.options)

    def authorize(self):
        self.report = self.inspect()
        self.approval = synthetic_recovery_approval(self.directory, self.report)

    def settle(self): return r.settle(self.request, self.approval, allow_settle=True, **self.options)

    def test_fresh_approval_settles_only_same_closed_commit_without_repeating_work(self):
        original = copy.deepcopy(self.host.values)
        calls = (list(self.transport.events), list(self.host.events), list(self.store.calls))
        self.authorize()
        self.assertTrue(self.pending.exists())
        self.assertEqual(self.inspect(), self.report)
        result = self.settle()
        self.assertEqual(result["status"], "closed-commit-recovered")
        self.assertFalse(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        self.assertEqual(self.host.values, original)
        self.assertEqual(calls, (self.transport.events, self.host.events, self.store.calls))
        self.assertEqual(f.active_release(b.load_config(self.config_path))["source_sha"], "b" * 40)
        with self.assertRaises(b.BackupError): self.settle()

    def test_old_finish_or_start_approval_cannot_grant_recovery(self):
        for path in (self.finish_approval.path, self.start_approval.path):
            with self.subTest(path=path), self.assertRaises(b.BackupError):
                r.settle(self.request, path, allow_settle=True, **self.options)
        self.assertTrue(self.pending.exists()); self.assertFalse(list(self.state.glob("recovery-*.json")))

    def test_expired_original_approvals_are_only_history_new_permission_is_required(self):
        later = time.time() + 7200
        with patch.object(r.time, "time", return_value=later):
            self.authorize()
            self.assertEqual(self.settle()["status"], "closed-commit-recovered")

    def test_wrong_migration_result_and_changed_original_config_inputs_refuse(self):
        receipt = next(self.state.glob("migration-*.success.json"))
        raw = receipt.read_bytes(); value = t.strict_json(raw)
        value["result"]["applied"] = []
        receipt.write_bytes(encoded(value))
        with self.assertRaisesRegex(b.BackupError, "migration-result"): self.inspect()
        receipt.write_bytes(raw)
        Path(self.config["compose_file"]).write_bytes(b"# changed original compose")
        with self.assertRaises(b.BackupError): self.inspect()
        self.assertTrue(self.pending.exists())

    def test_no_active_or_partial_generation_is_not_a_recoverable_commit(self):
        active = self.state / f.ACTIVE; raw = active.read_bytes(); active.unlink()
        with self.assertRaises(OSError): self.inspect()
        active.write_bytes(raw); active.chmod(0o600)
        (self.plan["directory"] / "compose.json").write_bytes(b"{}")
        with self.assertRaises(b.BackupError): self.inspect()
        self.assertTrue(self.pending.exists())

    def test_new_secret_or_config_does_not_match_approved_observation(self):
        self.authorize()
        self.worker.write_bytes(self.worker.read_bytes().replace(b"synthetic", b"changed"))
        with self.assertRaises(b.BackupError): self.settle()
        self.assertTrue(self.pending.exists())

    def test_restarted_app_or_postgres_and_new_containers_are_rejected(self):
        self.authorize()
        baseline = copy.deepcopy(self.host.values)
        for mutate in (lambda: self.host.values[2]["State"].update(StartedAt="2026-09-26T00:00:02Z"),
                       lambda: self.host.values[0]["State"].update(StartedAt="2026-09-26T00:00:02Z"),
                       lambda: self.host.values.append({**copy.deepcopy(self.host.values[3]), "Id": "f" * 64})):
            self.host.values = copy.deepcopy(baseline); mutate()
            with self.assertRaises(b.BackupError): self.settle()
            self.assertTrue(self.pending.exists())

    def test_worker_or_ingress_open_refuses_without_closing_it(self):
        self.authorize()
        (self.state / w.ADMISSION).write_bytes(b"{}"); (self.state / w.ADMISSION).chmod(0o600)
        with self.assertRaisesRegex(b.BackupError, "worker-not-paused"): self.settle()
        self.assertTrue((self.state / w.ADMISSION).exists())
        (self.state / w.ADMISSION).unlink()
        self.host.closed = False
        with self.assertRaisesRegex(b.BackupError, "ingress-not-closed"): self.settle()
        self.assertFalse(self.host.closed); self.assertTrue(self.pending.exists())

    def test_wrong_snapshot_or_expired_permission_is_not_consumed(self):
        self.authorize()
        base = t.strict_json(self.approval.read_bytes())
        for change in ({"observation_sha256": "f" * 64}, {"expires_at": base["approved_at"]}):
            self.approval.write_bytes(encoded({**base, **change}))
            with self.assertRaises(b.BackupError): self.settle()
            self.assertTrue(self.pending.exists()); self.assertFalse(list(self.state.glob("recovery-approval-*.json")))

    def test_revoke_during_final_probe_keeps_pending_and_spent_attempt(self):
        self.authorize()
        def revoke():
            if list(self.state.glob("recovery-approval-*.used.json")): self.approval.unlink(missing_ok=True)
        self.on_probe = revoke
        with self.assertRaises(OSError): self.settle()
        self.assertTrue(self.pending.exists()); self.assertTrue(list(self.state.glob("recovery-approval-*.used.json")))

    def test_expiry_during_final_probe_keeps_pending(self):
        self.authorize()
        expires = t.strict_json(self.approval.read_bytes())["expires_at"]
        clock = [time.time()]
        self.on_probe = lambda: clock.__setitem__(0, expires) if list(self.state.glob("recovery-approval-*.used.json")) else None
        with patch.object(r.time, "time", side_effect=lambda: clock[0]), self.assertRaisesRegex(b.BackupError, "recovery-expired"):
            self.settle()
        self.assertTrue(self.pending.exists())

    def test_both_locks_held_through_last_validation(self):
        self.authorize()
        original = b.complete_operation
        def locked(state, operation, **kwargs):
            for name in ("maintenance.lock", "worker-admission.lock"):
                with self.assertRaisesRegex(b.BackupError, "already-running"):
                    with b.lock(state, name): pass
            original(state, operation, **kwargs)
        with patch.object(b, "complete_operation", side_effect=locked): self.settle()

    def test_rogue_network_peer_invalidates_recovery(self):
        self.authorize()
        self.host.extra_peers.append("f" * 64)
        with self.assertRaises(b.BackupError): self.settle()
        self.assertTrue(self.pending.exists())

    def test_changed_request_does_not_match_new_permission(self):
        self.authorize()
        self.request.write_bytes(self.request.read_bytes() + b"\n")
        with self.assertRaisesRegex(b.BackupError, "recovery-approval-binding"): self.settle()
        self.assertTrue(self.pending.exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux real barrier recovery")
class RouterAiRecovery(Recovery):
    routerai_profile = True


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux real barrier recovery")
class CityGo10xRecovery(Recovery):
    citygo_10x_profile = True


if __name__ == "__main__": unittest.main()
