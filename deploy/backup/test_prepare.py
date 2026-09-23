"""Synthetic project/HTTPS; Linux tests exercise the real release lock/backup."""
import copy
import json
import os
from pathlib import Path
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch

import backup as b
import prepare as p
import worker as w
from test_backup import sample, MemoryStore

ROLES = ["postgres", "web", "api", "worker", "migrator", "backup"]
IMAGES = {role: "sha256:" + str(i + 1) * 64 for i, role in enumerate(ROLES)}
ORIGIN = "https://pilot.example.test"


def container(role, *, exited=False):
    index = ROLES.index(role) + 1
    return {"Id": str(index) * 64, "Name": "/fixture-" + role, "Image": IMAGES[role],
            "RestartCount": 0, "RestartPolicy": "no", "Init": role != "postgres",
            "StopTimeout": p.GRACE.get(role, 30),
            "Labels": {"com.docker.compose.project": "citygo-fixture", "com.docker.compose.service": role,
                       "com.docker.compose.oneoff": "True" if role in ("worker", "migrator", "backup") else "False"},
            "State": {"Status": "exited" if exited else "running", "Running": not exited,
                      "Paused": False, "Restarting": False, "OOMKilled": False, "Error": "", "ExitCode": 0,
                      "StartedAt": "2026-09-24T00:00:00Z", "FinishedAt": "2026-09-24T00:00:01Z" if exited else "0001-01-01T00:00:00Z",
                      "Health": {"Status": "healthy", "Log": [{"Output": "must not enter receipt"}]}}}


def inventory():
    return [container(role) for role in ("postgres", "web", "api", "worker")]


class Evidence(unittest.TestCase):
    def test_origin_and_images_are_closed(self):
        self.assertEqual(p.hostname(ORIGIN), "pilot.example.test")
        self.assertEqual(p.expected_images(IMAGES), IMAGES)
        for origin in ("http://pilot.example.test", ORIGIN + "/", ORIGIN + ":443", "https://user@pilot.example.test",
                       "https://127.0.0.1", "https://a\n.invalid", "https://pilot.example.test.evil/path"):
            with self.subTest(origin=origin), self.assertRaises(b.BackupError): p.hostname(origin)
        with self.assertRaises(b.BackupError): p.expected_images({**IMAGES, "other": IMAGES["api"]})

    def test_refuses_without_permissions_before_any_mutation(self):
        with patch.object(w, "pause") as pause:
            with self.assertRaisesRegex(b.BackupError, "explicit-prepare"):
                p.prepare(sample(), "b" * 40, ORIGIN, "/tmp/not-read", IMAGES)
            pause.assert_not_called()

    def test_every_replica_oneoff_and_failure_is_accounted_for(self):
        good = inventory() + [container("migrator", exited=True), container("backup", exited=True)]
        self.assertEqual(len(p.validate_inventory(good, "citygo-fixture", IMAGES, initial=True)), 6)
        bad_values = []
        for state in ({"Status": "paused", "Running": False}, {"OOMKilled": True}, {"Error": "private"},
                      {"StartedAt": "0001-01-01T00:00:00Z"}, {"Health": {"Status": "unhealthy"}}):
            bad = copy.deepcopy(good); bad[2]["State"].update(state); bad_values.append(bad)
        for change in ({"RestartCount": 1}, {"Image": "sha256:" + "f" * 64}, {"StopTimeout": 1},
                       {"Init": False}, {"Labels": {}}, {"RestartPolicy": "always"}, {"Name": None}):
            bad = copy.deepcopy(good); bad[2].update(change); bad_values.append(bad)
        bad_values += [good[:-1] + [container("backup")], good[:4] + [container("migrator")], good[:2], good + [good[2]]]
        replica = container("api"); replica["Id"] = "f" * 64
        bad_values.append(good + [replica])
        unknown = container("worker"); unknown["Labels"]["com.docker.compose.service"] = "other"
        bad_values.append(good[:3] + [unknown])
        failed = container("worker", exited=True); failed["State"]["ExitCode"] = 137
        bad_values.append(good[:3] + [failed])
        for bad in bad_values:
            with self.subTest(bad=bad), self.assertRaises(b.BackupError):
                p.validate_inventory(bad, "citygo-fixture", IMAGES, initial=True)

    def test_same_process_clean_exit_required(self):
        before = p.validate_inventory(inventory(), "citygo-fixture", IMAGES, initial=True)
        after = inventory()
        after[2], after[3] = container("api", exited=True), container("worker", exited=True)
        # Web readiness depends on the stopped API; it must remain running, not healthy.
        after[1]["State"]["Health"]["Status"] = "unhealthy"
        after = p.validate_inventory(after, "citygo-fixture", IMAGES, initial=False)
        p.same_inventory(before, after)
        for value in after.values():
            if value["Labels"]["com.docker.compose.service"] in p.GRACE: p.stopped_cleanly(value)
        for code in (1, 137, 143, False):
            bad = container("api", exited=True); bad["State"]["ExitCode"] = code
            with self.assertRaises(b.BackupError): p.stopped_cleanly(bad)
        changed = copy.deepcopy(after); changed["3" * 64]["State"]["StartedAt"] = "2026-09-24T00:00:00.1Z"
        with self.assertRaisesRegex(b.BackupError, "container-replaced"): p.same_inventory(before, changed)

    def test_only_exact_maintenance_response_passes(self):
        headers = {"cache-control": "no-store", "x-citygo-contract-version": "1", "content-type": "application/json; charset=utf-8", "x-request-id": "a" * 32}
        body = json.dumps({"code": "SERVICE_UNAVAILABLE", "contractVersion": "1", "retryable": False, "requestId": "a" * 32}).encode()
        p.maintenance_response(503, headers, body)
        for status, h, data in ((200, headers, body), (302, headers, body), (503, {}, body), (503, headers, b"x" * 4097),
                                (503, headers, body.replace(b"false", b"true")), (503, headers, b"[]"),
                                (503, headers, b"invalid")):
            with self.assertRaises(b.BackupError): p.maintenance_response(status, h, data)

    def test_transport_can_only_stop_declared_writer_with_fixed_grace(self):
        host = object.__new__(p.Host)
        with patch.object(host, "capture") as capture:
            host.stop_writer(container("api"))
            self.assertEqual(capture.call_args.args[0], ["stop", "--signal", "SIGTERM", "--timeout", "330", "3" * 64])
            with self.assertRaises(b.BackupError): host.stop_writer(container("postgres"))
            self.assertEqual(capture.call_count, 1)

    def test_tls_pins_loopback_but_validates_origin_without_insecure_retry(self):
        context = ssl.create_default_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        connection = p._LoopbackTLS("pilot.example.test", timeout=10, context=context)
        with patch.object(p.socket, "create_connection") as connect, patch.object(context, "wrap_socket") as wrap:
            connection.connect()
            connect.assert_called_once_with(("127.0.0.1", 443), 10)
            wrap.assert_called_once_with(connect.return_value, server_hostname="pilot.example.test")
            connection.close()
        with patch.object(p.socket, "create_connection") as connect, patch.object(context, "wrap_socket", side_effect=ssl.SSLError):
            with self.assertRaises(ssl.SSLError): connection.connect()
            connect.assert_called_once_with(("127.0.0.1", 443), 10)
            connect.return_value.close.assert_called_once()


class FakeHost:
    def __init__(self):
        self.values = inventory()
        self.events = []
        self.closed = False
        self.exit_code = 0
        self.network_id = "e" * 64
        self.extra_peers = []
        self.on_inventory = lambda: None
        self.on_stop = lambda: None

    def close_ingress(self):
        self.closed = True
        self.events.append("close")

    def assert_closed(self):
        b.require(self.closed, "ingress-not-closed")

    def inventory(self):
        self.on_inventory()
        return copy.deepcopy(self.values)

    def inspect(self, ident):
        return copy.deepcopy(next(v for v in self.values if v["Id"] == ident))

    def database_network(self):
        return {"id": self.network_id, "peers": sorted([v["Id"] for v in self.values
                if v["Labels"]["com.docker.compose.service"] != "web"] + self.extra_peers)}

    def stop_writer(self, value):
        self.events.append("stop:" + value["Labels"]["com.docker.compose.service"])
        current = next(v for v in self.values if v["Id"] == value["Id"])
        current["State"].update(Status="exited", Running=False, ExitCode=self.exit_code, FinishedAt="2026-09-24T00:00:01Z")
        self.on_stop()


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux controller locks and protected paths")
class Preparation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-prepare-test-"); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = sample(self.directory)
        self.state = self.directory / "state"; self.state.mkdir(mode=0o700)
        self.ingress = self.directory / "ingress"; self.ingress.mkdir(mode=0o755)
        for name in ("compose.yml", "pilot.env"):
            path = self.directory / name; path.write_text("# fixture"); path.chmod(0o600)
        self.host, self.store = FakeHost(), MemoryStore()
        self.pending = self.state / "operation-pending.json"
        self.encrypt = lambda _c, dest, _e: dest.write_bytes(b"synthetic-encrypted" * 30)

    def prepare(self, **kwargs):
        return p.prepare(self.config, "b" * 40, ORIGIN, self.ingress, IMAGES, allow_stop=True, allow_upload=True,
                         host_factory=lambda *_: self.host, storage_factory=lambda *_: self.store,
                         encryptor=kwargs.pop("encryptor", self.encrypt), min_free=0, **kwargs)

    def test_success_order_under_one_lock_with_retained_pending_and_closed_admission(self):
        w.open_admission(self.config)
        def encrypt(c, dest, env):
            self.assertEqual(self.host.events, ["close", "stop:api", "stop:worker"])
            self.assertTrue(self.pending.exists())
            self.assertFalse((self.state / w.ADMISSION).exists())
            with self.assertRaisesRegex(b.BackupError, "already-running"): w.open_admission(self.config)
            self.encrypt(c, dest, env)
        proof = self.prepare(encryptor=encrypt)
        self.assertEqual(b.read_json(self.state / "release-prepared.json"), proof)
        self.assertEqual(proof["operation_id"], proof["backup"]["operation_id"])
        self.assertFalse(proof["migration_authorized"])
        self.assertNotIn("must not enter receipt", json.dumps(proof))
        self.assertEqual([c["status"] for c in proof["containers"]], ["running", "running", "exited", "exited"])
        self.assertTrue(self.host.closed)
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): self.prepare()

    def test_active_managed_operation_is_not_interrupted(self):
        w.open_admission(self.config)
        with b.lock(self.state), self.assertRaisesRegex(b.BackupError, "already-running"): self.prepare()
        self.assertFalse((self.state / w.ADMISSION).exists())
        self.assertEqual(self.host.events, [])
        self.assertFalse(self.pending.exists())

    def test_wrong_inventory_refuses_before_any_stop_or_upload(self):
        self.host.values[2]["Image"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(b.BackupError, "container-image"): self.prepare()
        self.assertEqual(self.host.events, ["close"])
        self.assertEqual(self.store.calls, [])
        self.assertTrue(self.pending.exists())

    def test_unclean_api_exit_refuses_backup(self):
        self.host.exit_code = 137
        with self.assertRaisesRegex(b.BackupError, "unclean-exit"): self.prepare()
        self.assertEqual(self.store.calls, [])
        self.assertFalse((self.state / "release-prepared.json").exists())

    def test_unlabelled_database_network_peer_refuses_before_stop(self):
        self.host.extra_peers = ["f" * 64]
        with self.assertRaisesRegex(b.BackupError, "database-network-peers"): self.prepare()
        self.assertEqual(self.host.events, ["close"])
        self.assertEqual(self.store.calls, [])

    def test_new_oneoff_after_stop_refuses_before_backup(self):
        self.host.on_stop = lambda: self.host.values.append(container("migrator"))
        with self.assertRaises(b.BackupError): self.prepare()
        self.assertEqual(self.store.calls, [])

    def test_replacement_or_reopen_during_backup_cannot_create_prepared_receipt(self):
        for fault in ("replacement", "reopen", "exit", "removed", "network", "peer"):
            self.host = FakeHost()
            def encrypt(c, dest, env):
                self.encrypt(c, dest, env)
                if fault == "replacement": self.host.values[2]["State"]["StartedAt"] = "2026-09-24T00:00:00.1Z"
                elif fault == "reopen": self.host.closed = False
                elif fault == "exit": self.host.values[3]["State"]["ExitCode"] = 1
                elif fault == "network": self.host.network_id = "f" * 64
                elif fault == "peer": self.host.extra_peers = ["f" * 64]
                else: self.host.values.pop()
            with self.subTest(fault=fault), self.assertRaises(b.BackupError): self.prepare(encryptor=encrypt)
            self.assertFalse((self.state / "release-prepared.json").exists())
            self.assertTrue(self.pending.exists())
            self.pending.unlink()  # Independent synthetic cases only.

    def test_upload_failure_keeps_closed_stopped_and_pending(self):
        self.store.fault = "readback"
        with self.assertRaises(b.BackupError): self.prepare()
        self.assertTrue(self.host.closed)
        self.assertFalse(self.host.values[2]["State"]["Running"])
        self.assertTrue(self.pending.exists())
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): self.prepare()

    def test_host_gate_rejects_symlink_and_closes_only_exact_marker(self):
        with patch.object(b, "executable", return_value="/usr/bin/docker"):
            host = p.Host(self.config, self.directory, self.ingress, ORIGIN)
        marker = self.ingress / "traffic-open"
        marker.symlink_to(self.directory / "pilot.env")
        with self.assertRaises(b.BackupError): host.close_ingress()
        marker.unlink(); marker.write_text(""); marker.chmod(0o644)
        with patch.object(host, "assert_closed") as probe:
            host.close_ingress()
            probe.assert_called_once()
        self.assertFalse(marker.exists())
        self.assertTrue((self.directory / "pilot.env").exists())


if __name__ == "__main__": unittest.main()
