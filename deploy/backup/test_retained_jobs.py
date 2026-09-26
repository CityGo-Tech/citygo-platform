"""Exact inert old jobs are retained, never implicitly trusted or restarted."""
import copy
import sys
import unittest

import backup as b
import prepare as p
import target as t
import test_finish as fixture
from test_prepare import container, inventory, IMAGES, ORIGIN
from test_target import approval_fixture, encoded
from test_migrate import synthetic_authorization
from test_start import synthetic_start_approval


def old_job():
    value = container("worker", exited=True)
    value.update(Id="f" * 64, Name="/prior-worker", Image="sha256:" + "9" * 64)
    return value


class Validation(unittest.TestCase):
    def test_v1_has_no_implicit_retention_and_v2_is_strict(self):
        base = approval_fixture(2000000000)
        self.assertEqual(t.approval(encoded(base), 2000000000), base)
        entries = [p.evidence(old_job())]
        good = {**base, "version": 2, "retained_jobs": entries}
        self.assertEqual(t.approval(encoded(good), 2000000000), good)
        for change in ({"version": 1}, {"version": True}, {"version": 3}, {"retained_jobs": None},
                       {"retained_jobs": entries * 2}, {"retained_jobs": entries * 62}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): t.approval(encoded({**good, **change}), 2000000000)
        with self.assertRaises(b.BackupError): t.approval(encoded({**base, "version": 2}), 2000000000)

    def test_only_successful_exact_oneoffs_can_be_declared(self):
        value = p.evidence(old_job())
        for change in ({"role": "api"}, {"role": "web"}, {"role": "postgres"}, {"status": "running"},
                       {"exit_code": 1}, {"exit_code": True}, {"restart_count": 1}, {"restart_count": False},
                       {"init": False}, {"grace": 30}, {"grace": True}, {"restart_policy": "always"},
                       {"id": "*"}, {"image": "latest"}, {"name": "*"}, {"finished_at": "not-time"},
                       {"finished_at": "2026-09-23T00:00:00Z"}, {"command": "do-not-run"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): t.retained_jobs([{**value, **change}])

    def test_unapproved_old_image_fails_but_exact_exited_process_is_retained(self):
        old = old_job(); values = inventory() + [old]
        with self.assertRaisesRegex(b.BackupError, "container-image"): p.validate_inventory(values, "citygo-fixture", IMAGES, initial=True)
        entries = [p.evidence(old)]
        verified = p.validate_inventory(values, "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)
        self.assertEqual(verified[old["Id"]], old)
        with self.assertRaisesRegex(b.BackupError, "retained-job-missing"):
            p.validate_inventory(inventory(), "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)

    def test_replacement_failed_restart_wrong_project_and_replica_are_not_exempt(self):
        old = old_job(); entries = [p.evidence(old)]
        for change in ({"Id": "e" * 64}, {"Image": IMAGES["worker"]}, {"Name": "/other"}, {"RestartCount": 1},
                       {"Labels": {**old["Labels"], "com.docker.compose.project": "citygo-other"}},
                       {"Labels": {**old["Labels"], "com.docker.compose.oneoff": "false"}},
                       {"State": {**old["State"], "Running": True}},
                       {"State": {**old["State"], "Dead": True}},
                       {"State": {**old["State"], "Error": "private"}},
                       {"State": {**old["State"], "ExitCode": 137}},
                       {"State": {**old["State"], "StartedAt": "2026-09-24T00:00:00.1Z"}}):
            with self.subTest(change=change), self.assertRaises(b.BackupError):
                p.validate_inventory(inventory() + [{**old, **change}], "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)
        with self.assertRaises(b.BackupError):
            p.validate_inventory(inventory() + [old, {**old, "Id": "e" * 64}], "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)

    def test_network_refresh_preserves_retained_job_constraints(self):
        from test_prepare import FakeHost
        host = FakeHost(); old = old_job(); host.values.append(old)
        entries = [p.evidence(old)]
        initial = p.validate_inventory(host.inventory(), "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)
        # Force the existing bounded Worker exit refresh. Old jobs are not lost
        # from validation just because Docker cleans an endpoint between reads.
        host.excluded_peers.add("4" * 64)
        def exited(): host.values[3]["State"].update(Status="exited", Running=False, FinishedAt="2026-09-24T00:00:01Z")
        host.on_inventory = exited
        refreshed, _ = p.network_snapshot(host, initial, "citygo-fixture", IMAGES, initial=True, retained_jobs=entries)
        self.assertIn(old["Id"], refreshed)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux independently approved retained jobs")
class ClosedRelease(unittest.TestCase):
    def setUp(self):
        fixture.Cutover.setUp(self)
        self.old = old_job(); self.host.values.append(self.old)

    def authorize_old(self):
        raw = t.strict_json(self.selection.approval_file.read_bytes())
        self.selection.approval_file.write_bytes(encoded({**raw, "version": 2, "retained_jobs": [p.evidence(self.old)]}))
        self.selection = t.Selection(self.selection.current_directory, self.selection.target_directory, self.selection.approval_file)
        self.authorization = synthetic_authorization(self.directory, self.selection, self.config, self.host.network_id)
        self.start_approval = synthetic_start_approval(self.directory, self.authorization, self.api)
        self.finish_approval = fixture.synthetic_finish_approval(self.directory, self.config, self.start_approval, self.plan)

    def test_unapproved_job_fails_before_pause_or_backup(self):
        with self.assertRaisesRegex(b.BackupError, "container-image"): fixture.Cutover.finish(self)
        self.assertEqual(self.host.events, []); self.assertEqual(self.store.calls, []); self.assertFalse(self.pending.exists())

    def test_approved_job_survives_entire_closed_chain_without_start_stop_or_removal(self):
        self.authorize_old(); before = copy.deepcopy(self.old)
        result = fixture.Cutover.finish(self)
        self.assertEqual(next(v for v in self.host.values if v["Id"] == before["Id"]), before)
        self.assertEqual(result["preparation"]["target"]["retained_jobs"], [p.evidence(before)])
        self.assertEqual(self.host.events.count("stop:worker"), 1)  # only the CURRENT running Worker
        self.assertFalse(self.pending.exists()); self.assertTrue(self.host.closed)

    def test_old_job_restarted_during_migration_blocks_start_and_commit(self):
        self.authorize_old()
        self.transport.on_execute = lambda: self.old["State"].update(Status="running", Running=True)
        with self.assertRaises(b.BackupError): fixture.Cutover.finish(self)
        self.assertTrue(self.pending.exists()); self.assertEqual(self.start_events, [])
        self.assertEqual(self.config_path.read_bytes(), self.original_raw)

    def test_retention_approval_changed_during_drain_is_not_reauthorized(self):
        self.authorize_old()
        def change(): self.selection.approval_file.write_bytes(self.selection.approval_file.read_bytes() + b"\n")
        self.host.on_stop = change
        with self.assertRaises(b.BackupError): fixture.Cutover.finish(self)
        self.assertEqual(self.transport.events, []); self.assertEqual(self.store.calls, [])
        self.assertTrue(self.pending.exists())

    def test_old_job_failure_flag_during_health_cannot_complete_release(self):
        self.authorize_old()
        self.on_probe = lambda: self.old["State"].update(OOMKilled=True)
        with self.assertRaises(b.BackupError): fixture.Cutover.finish(self)
        self.assertTrue(self.pending.exists()); self.assertEqual(self.config_path.read_bytes(), self.original_raw)


if __name__ == "__main__": unittest.main()
