"""No live DB/keys/cloud: synthetic evidence plus real Linux locks/durable files."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

import backup as b
import migration_job as m
import release as r
import worker as w
from test_backup import sample, MemoryStore
from test_image_gate import FakeStore, inspection

REF = "ghcr.io/citygo-tech/citygo-platform-jobs@sha256:" + "d" * 64
IMAGE = "sha256:" + "c" * 64
NETWORK = "e" * 64
OP = {"id": "1" * 32, "target_sha": "b" * 40}


def plan(operation=OP):
    first = {"name": "0001_fixture.sql", "sha256": "a" * 64}
    return {"version": 1, "kind": "citygo-release-migration", "operationId": str(uuid.UUID(operation["id"])),
            "targetSha": operation["target_sha"], "currentMigrations": [first],
            "targetMigrations": [first, {"name": "0002_fixture.sql", "sha256": "b" * 64}], "grantsSha256": "f" * 64}


def reply(value, data):
    return {"version": 1, "kind": "citygo-release-migration-result", "operationId": value["operationId"],
            "targetSha": value["targetSha"], "requestSha256": m.t.sha256(data),
            "applied": value["targetMigrations"][len(value["currentMigrations"]):], "grantsSha256": value["grantsSha256"],
            "committed": True, "trafficAuthorized": False}


def expected():
    return {"container_id": "a" * 64, "container_name": "citygo-migrate-" + OP["id"],
            "image": {"local_id": IMAGE, "config_id": IMAGE}, "network_id": NETWORK,
            "project": "citygo-fixture", "operation_id": OP["id"], "request_sha256": "f" * 64,
            "secret_snapshot": "/tmp/protected/migrate.json"}


def container(value, phase="created"):
    return {"Id": value["container_id"], "Name": "/" + value["container_name"], "Image": value["image"]["local_id"],
            "RestartCount": 0, "Config": {"Image": value["image"]["local_id"], "User": "1000:1000", "WorkingDir": "/app",
                "Entrypoint": ["node"], "Cmd": ["scripts/container-runtime.mjs", "migrate-release"],
                "OpenStdin": True, "Tty": False, "Labels": m.labels_for(value)},
            "HostConfig": {"NetworkMode": NETWORK, "ReadonlyRootfs": True, "Init": True, "Privileged": False,
                "AutoRemove": False, "Memory": m.MEMORY, "MemorySwap": m.MEMORY, "PidsLimit": 128,
                "RestartPolicy": {"Name": "no"}, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"]},
            "Mounts": [{"Type": "bind", "Source": value["secret_snapshot"], "Destination": "/run/secrets/migrate.json", "RW": False}],
            "State": {"Status": phase, "Running": phase == "running", "Paused": False, "Restarting": False,
                "OOMKilled": False, "Dead": False, "Error": "", "ExitCode": 0,
                "StartedAt": "0001-01-01T00:00:00Z" if phase == "created" else "2026-09-25T00:00:00Z",
                "FinishedAt": "2026-09-25T00:00:01Z" if phase == "exited" else "0001-01-01T00:00:00Z"}}


class Validation(unittest.TestCase):
    def test_input_matches_executor_and_normalizes_host_operation_uuid(self):
        value = plan(); data = m.request(value, OP)
        self.assertEqual(json.loads(data), value)
        self.assertNotIn(b" ", data)
        for changed in ({"version": True}, {"operationId": "2" * 32}, {"targetSha": "a" * 40},
                        {"currentMigrations": []}, {"grantsSha256": "secret"}, {"extra": 1},
                        {"targetMigrations": list(reversed(value["targetMigrations"]))}):
            with self.subTest(changed=changed), self.assertRaises(b.BackupError): m.request({**value, **changed}, OP)

    def test_result_requires_exact_typed_receipt_no_extra_output_or_duplicate_keys(self):
        value = plan(); data = m.request(value, OP); valid = reply(value, data)
        self.assertEqual(m.result(m.wire(valid) + b"\n", value, data), valid)
        for change in ({"version": True}, {"committed": 1}, {"trafficAuthorized": 0}, {"trafficAuthorized": True},
                       {"operationId": str(uuid.uuid4())}, {"requestSha256": "a" * 64}, {"applied": []},
                       {"targetSha": "a" * 40}, {"grantsSha256": "b" * 64}, {"sql": "secret"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): m.result(m.wire({**valid, **change}), value, data)
        for raw in (b"", b"x" * 262145, m.wire(valid) + b"{}", m.wire(valid).replace(b'"version":1', b'"version":1,"version":1')):
            with self.assertRaises(b.BackupError): m.result(raw, value, data)

    def test_container_created_running_and_fast_exited_evidence(self):
        e = expected()
        for phase in ("created", "running", "exited"): m.container(container(e, phase), e, phase=phase)

    def test_refuses_substitution_failure_or_weaker_runtime(self):
        e = expected()
        changes = [("Image", "sha256:" + "f" * 64), ("Id", "b" * 64), ("RestartCount", 1),
            ("State.ExitCode", 137), ("State.ExitCode", True), ("State.OOMKilled", True), ("State.Error", "hidden"),
            ("State.Running", True), ("State.Dead", True), ("Config.Cmd", ["migrate"]), ("Config.User", "root"),
            ("Config.Image", "latest"), ("HostConfig.AutoRemove", True), ("HostConfig.Memory", 0),
            ("HostConfig.NetworkMode", "host"), ("HostConfig.Privileged", True), ("Mounts", [])]
        for key, change in changes:
            value = container(e, "exited"); parts = key.split("."); obj = value
            for part in parts[:-1]: obj = obj[part]
            obj[parts[-1]] = change
            with self.subTest(key=key), self.assertRaises(b.BackupError): m.container(value, e, phase="exited")

    def test_transport_uses_fixed_local_image_stdin_no_remove_pull_shell_or_host_credentials(self):
        with patch.object(b, "executable", return_value="/usr/bin/docker"):
            transport = m.Docker(sample(), Path("/tmp/fixture"))
        with patch.object(transport, "capture", return_value="a" * 64) as capture:
            transport.create(expected())
        args = capture.call_args.args[0]
        self.assertEqual(args[0], "create")
        self.assertEqual(args[args.index("--pull") + 1], "never")
        self.assertEqual(args[-3:], [IMAGE, "scripts/container-runtime.mjs", "migrate-release"])
        self.assertNotIn("--rm", args); self.assertNotIn("--privileged", args)
        self.assertEqual(args[args.index("--network") + 1], NETWORK)
        self.assertEqual(transport.env, b.clean_env(Path("/tmp/fixture")))

    def test_no_permission_or_live_window_cannot_touch_docker(self):
        with patch.object(m.g, "verify_image") as verify:
            for kwargs in ({}, {"allow_migration": True}, {"allow_migration": True, "guard": lambda: None}):
                with self.assertRaises(b.BackupError): m._execute_in_window(None, plan(), REF, IMAGE, NETWORK, "/unused", **kwargs)
            verify.assert_not_called()

    def test_only_migrator_secret_for_the_fixed_database_is_accepted(self):
        valid = b'{"DATABASE_URL":"postgresql://citygo_migrator:synthetic@postgres:5432/citygo_pilot"}'
        with patch.object(m.t, "read_file", return_value=valid): self.assertEqual(m.secret_bytes("/unused"), valid)
        bad = [b"{}", valid.replace(b"citygo_migrator", b"postgres"), valid.replace(b"@postgres:", b"@other:"),
               valid.replace(b"5432", b"1234"), valid.replace(b"citygo_pilot", b"other"),
               valid.replace(b"citygo_pilot", b"citygo_pilot?sslmode=disable"), b"x" * 16385,
               valid[:-1] + b',"API_KEY":"synthetic"}']
        for data in bad:
            with patch.object(m.t, "read_file", return_value=data), self.assertRaises(b.BackupError): m.secret_bytes("/unused")


class FakeDocker:
    def __init__(self):
        self.events = []; self.phase = "created"; self.expected = None
        self.on_create = lambda: None; self.on_execute = lambda: None; self.alter_after = lambda value: None
        self.raw_change = lambda data: data

    def create(self, expected):
        self.events.append("create"); self.expected = copy.deepcopy(expected)
        self.expected["container_id"] = "a" * 64
        self.on_create()
        return "a" * 64

    def inspect(self, ident):
        value = container(self.expected, self.phase)
        if self.phase == "exited": self.alter_after(value)
        return value

    def execute(self, expected, data, output):
        self.events.append("execute"); self.on_execute(); self.phase = "exited"
        started = container(expected, "running")
        return self.raw_change(m.wire(reply(json.loads(data), data))), started


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux release lock and protected files")
class Execution(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="citygo-migration-test-"); self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name); self.config = sample(self.directory)
        self.state = self.directory / "state"; self.state.mkdir(mode=0o700)
        for name in ("compose.yml", "pilot.env"):
            path = self.directory / name; path.write_bytes(b"# fixture\n"); path.chmod(0o600)
        self.secret = self.directory / "migrate.json"
        self.secret.write_text(json.dumps({"DATABASE_URL": "postgresql://citygo_migrator:synthetic@postgres:5432/citygo_pilot"}))
        self.secret.chmod(0o600)
        self.store = FakeStore(); self.store.values[REF] = inspection(REF, IMAGE, "b" * 40)
        self.transport = FakeDocker(); self.guard_calls = 0

    def backup(self, window):
        window.backup(storage_factory=lambda *_: MemoryStore(), encryptor=lambda _c, path, _e: path.write_bytes(b"encrypted-fixture" * 30), min_free=0)

    def guard(self):
        self.guard_calls += 1
        with self.assertRaisesRegex(b.BackupError, "already-running"):
            with b.lock(self.state): pass

    def run_job(self, window, **changes):
        values = dict(allow_migration=True, guard=self.guard, transport_factory=lambda *_: self.transport,
                      image_store_factory=lambda _: self.store)
        values.update(changes)
        return m._execute_in_window(window, plan(window._operation), REF, IMAGE, NETWORK, self.secret, **values)

    def test_success_keeps_pending_container_intent_and_blocks_replay(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            def assert_intent():
                self.assertEqual(len(list(self.state.glob("*.intent.json"))), 1)
                self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)
            self.transport.on_create = assert_intent
            proof = self.run_job(window)
            self.assertFalse(proof["traffic_authorized"])
            self.assertTrue(proof["result"]["committed"])
            self.assertEqual(self.transport.events, ["create", "execute"])
            self.assertGreaterEqual(self.guard_calls, 4)
            with self.assertRaisesRegex(b.BackupError, "migration-already-attempted"): self.run_job(window)
        self.assertTrue((self.state / "operation-pending.json").exists())
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 1)
        self.assertNotIn("synthetic", next(self.state.glob("*.success.json")).read_text())
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): w.open_admission(self.config)
        with self.assertRaisesRegex(b.BackupError, "release-window-inactive"): self.run_job(window)

    def test_no_backup_never_launches_and_cannot_be_repaired_into_a_retry(self):
        with r.release_window(self.config, "b" * 40) as window:
            with self.assertRaisesRegex(b.BackupError, "fresh-backup"): self.run_job(window)
            self.backup(window)
            with self.assertRaisesRegex(b.BackupError, "already-attempted"): self.run_job(window)
        self.assertEqual(self.transport.events, [])

    def test_expired_backup_never_creates_a_container(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window); window._checkpoint["verified_at"] -= 901
            with self.assertRaisesRegex(b.BackupError, "fresh-backup"): self.run_job(window)
        self.assertEqual(self.transport.events, [])

    def test_observed_configuration_drift_is_not_repairable_into_retry(self):
        path = self.directory / "pilot.env"; original = path.read_bytes()
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window); path.write_bytes(b"changed\n")
            with self.assertRaisesRegex(b.BackupError, "configuration-changed"): self.run_job(window)
            path.write_bytes(original)
            with self.assertRaisesRegex(b.BackupError, "already-attempted"): self.run_job(window)
        self.assertEqual(self.transport.events, [])

    def test_changed_intent_after_create_cannot_start(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            self.transport.on_create = lambda: next(self.state.glob("*.intent.json")).write_bytes(b"{}")
            with self.assertRaisesRegex(b.BackupError, "intent-changed"): self.run_job(window)
        self.assertEqual(self.transport.events, ["create"])
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_guard_failure_after_commit_remains_pending(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            def failed_guard():
                self.guard()
                if "execute" in self.transport.events: raise b.BackupError("synthetic-revoked")
            with self.assertRaisesRegex(b.BackupError, "synthetic-revoked"): self.run_job(window, guard=failed_guard)
            with self.assertRaisesRegex(b.BackupError, "already-attempted"): self.run_job(window)
        self.assertTrue((self.state / "operation-pending.json").exists())
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_preexisting_intent_cannot_be_overwritten(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            intent = self.state / ("migration-" + window._operation["id"] + ".intent.json")
            intent.write_bytes(b"prior-attempt"); intent.chmod(0o600)
            with self.assertRaises(FileExistsError): self.run_job(window)
            self.assertEqual(intent.read_bytes(), b"prior-attempt")
        self.assertEqual(self.transport.events, [])

    def test_failed_guard_or_changed_secret_before_start_poison_attempt(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            self.transport.on_create = lambda: self.secret.write_bytes(b"{}")
            with self.assertRaises(b.BackupError): self.run_job(window)
            with self.assertRaisesRegex(b.BackupError, "already-attempted"): self.run_job(window)
        self.assertEqual(self.transport.events, ["create"])
        self.assertEqual(len(list(self.state.glob("*.intent.json"))), 1)
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_uncertain_start_transport_or_receipt_keeps_durable_intent(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            self.transport.on_execute = lambda: (_ for _ in ()).throw(subprocess.TimeoutExpired("synthetic", 180))
            with self.assertRaises(subprocess.TimeoutExpired): self.run_job(window)
            with self.assertRaisesRegex(b.BackupError, "already-attempted"): self.run_job(window)
        self.assertTrue((self.state / "operation-pending.json").exists())
        self.assertEqual(len(list(self.state.glob("*.container.json"))), 1)
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_same_id_restarted_process_is_not_success(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            self.transport.alter_after = lambda value: value["State"].update(StartedAt="2026-09-25T00:00:00.500Z")
            with self.assertRaisesRegex(b.BackupError, "container-replaced"): self.run_job(window)
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_wrong_receipt_after_clean_exit_is_not_success(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window); self.transport.raw_change = lambda raw: raw.replace(b'"committed":true', b'"committed":1')
            with self.assertRaisesRegex(b.BackupError, "migration-result"): self.run_job(window)
        self.assertEqual(len(list(self.state.glob("*.success.json"))), 0)

    def test_cross_thread_and_completed_windows_cannot_execute(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.backup(window)
            owner = window._owner; window._owner = (os.getpid(), -1)
            with self.assertRaisesRegex(b.BackupError, "window-inactive"): self.run_job(window)
            window._owner = owner
        with self.assertRaisesRegex(b.BackupError, "window-inactive"): self.run_job(window)
        self.assertEqual(self.transport.events, [])
