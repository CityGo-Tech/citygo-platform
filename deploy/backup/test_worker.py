"""Synthetic transport only; real Linux flock, permissions and process death."""
import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import backup as b
import worker as w
from test_backup import sample, MemoryStore


def snapshot():
    return {"Id": "a" * 64, "Name": "/fixture", "Image": "sha256:" + "b" * 64,
            "RestartCount": 0, "RestartPolicy": "no", "Init": True, "StopTimeout": 90,
            "Labels": {"com.docker.compose.project": "citygo-fixture",
                       "com.docker.compose.service": "worker", "com.docker.compose.oneoff": "True"},
            "State": {"Status": "running", "Running": True, "Paused": False,
                      "Restarting": False, "OOMKilled": False, "Error": "", "ExitCode": 0,
                      "StartedAt": "2026-09-23T12:00:00.123456789Z", "FinishedAt": "0001-01-01T00:00:00Z"}}


def exited():
    value = snapshot()
    value["State"].update(Status="exited", Running=False, FinishedAt="2026-09-23T12:00:01.123456789Z")
    return value


class Evidence(unittest.TestCase):
    def test_same_successful_process_including_fast_one_shot(self):
        w.clean_exit(snapshot(), exited(), "citygo-fixture")
        w.clean_exit(exited(), exited(), "citygo-fixture")

    def test_failure_replacement_restart_and_missing_evidence_rejected(self):
        mutations = [{"Id": "c" * 64}, {"Image": "sha256:" + "c" * 64},
                     {"RestartCount": 1}, {"Init": False}, {"StopTimeout": None},
                     {"RestartPolicy": "always"}, {"Labels": {}}]
        mutations += [{"State": {**exited()["State"], **change}} for change in (
            {"ExitCode": 1}, {"ExitCode": 137}, {"ExitCode": 143}, {"ExitCode": False},
            {"Running": True}, {"OOMKilled": True}, {"Error": "private engine text"},
            {"Paused": True}, {"Restarting": True}, {"StartedAt": "2026-09-23T12:00:00Z"},
            {"FinishedAt": "0001-01-01T00:00:00Z"}, {"FinishedAt": "invalid"},
        )]
        for change in mutations:
            with self.subTest(change=change), self.assertRaises((b.BackupError, ValueError)):
                w.clean_exit(snapshot(), {**exited(), **change}, "citygo-fixture")

    def test_transport_is_fixed_no_auto_remove_pull_or_inherited_secrets(self):
        with patch.object(b, "executable", return_value="/usr/bin/docker"), patch.dict(os.environ, {"OPENAI_API_KEY": "never"}):
            docker = w.Docker(sample(), Path("/tmp/synthetic"))
        self.assertNotIn("OPENAI_API_KEY", docker.env)
        self.assertEqual(docker.env["DOCKER_HOST"], "unix:///var/run/docker.sock")
        with patch.object(docker, "capture", return_value="a" * 64) as capture:
            docker.start("citygo-worker-fixture")
            args = capture.call_args.args[0]
            self.assertEqual(args[-1], "worker")
            self.assertNotIn("--rm", args)
            self.assertIn("--no-deps", args)
            self.assertEqual(args[args.index("--pull") + 1], "never")

    def test_cli_permission_and_platform_fail_without_config_io(self):
        with patch.object(b, "load_config") as load:
            for operation in ("pause", "open", "run"):
                self.assertEqual(w.main([operation, "--config", "/does-not-exist"]), 1)
            load.assert_not_called()


class Transport:
    def __init__(self):
        self.before, self.after = snapshot(), exited()
        self.on_start = lambda: None
        self.on_wait = lambda: None
        self.waited = False
        self.calls = []

    def start(self, name):
        self.calls.append("start")
        self.before["Name"] = self.after["Name"] = "/" + name
        self.on_start()
        return self.before["Id"]

    def inspect(self, target):
        self.calls.append("inspect")
        return copy.deepcopy(self.after if self.waited else self.before)

    def wait(self, target):
        self.calls.append("wait")
        self.on_wait()
        self.waited = True


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected files, flock and crash safety")
class Coordination(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-worker-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = sample(self.directory)
        self.state = self.directory / "state"
        self.state.mkdir(mode=0o700)
        for name in ("compose.yml", "pilot.env"):
            path = self.directory / name
            path.write_text("# synthetic configuration")
            path.chmod(0o600)
        self.docker = Transport()
        self.store = MemoryStore()
        self.pending = self.state / "operation-pending.json"

    def worker(self):
        w.perform(self.config, transport_factory=lambda *_: self.docker)

    def backup(self, encryptor=None):
        return b.perform_backup(self.config, storage_factory=lambda *_: self.store, min_free=0,
                                encryptor=encryptor or (lambda _c, p, _e: p.write_bytes(b"ciphertext-fixture" * 30)))

    def test_closed_by_default_and_explicit_open_bound_to_config(self):
        with self.assertRaisesRegex(b.BackupError, "worker-paused"):
            self.worker()
        self.assertEqual(self.docker.calls, [])
        self.assertFalse(self.pending.exists())
        w.open_admission(self.config)
        with self.assertRaisesRegex(b.BackupError, "worker-already-open"):
            w.open_admission(self.config)
        (self.directory / "pilot.env").write_text("changed-release")
        with self.assertRaisesRegex(b.BackupError, "worker-approval-changed"):
            self.worker()
        self.assertEqual(self.docker.calls, [])

    def test_success_retains_receipt_and_no_container_cleanup(self):
        w.open_admission(self.config)
        def started():
            self.assertEqual(json.loads(self.pending.read_text())["operation"], "worker")
            self.assertEqual(self.pending.stat().st_mode & 0o777, 0o600)
        self.docker.on_start = started
        self.worker()
        self.assertEqual(self.docker.calls, ["start", "inspect", "wait", "inspect"])
        self.assertFalse(self.pending.exists())
        receipt = b.read_json(self.state / "worker-last-success.json")
        self.assertEqual(receipt["container_id"], "a" * 64)
        self.assertTrue((self.state / w.ADMISSION).exists())

    def test_pause_during_active_worker_closes_only_new_admission(self):
        w.open_admission(self.config)
        def waiting():
            w.pause(self.config)
            for action in (self.worker, self.backup, lambda: w.open_admission(self.config)):
                with self.assertRaisesRegex(b.BackupError, "already-running"):
                    action()
            self.assertEqual(self.store.calls, [])
        self.docker.on_wait = waiting
        self.worker()
        with self.assertRaisesRegex(b.BackupError, "worker-paused"):
            self.worker()
        self.backup()  # Backup is allowed while admission is paused, not while busy.
        w.pause(self.config)  # Idempotent, no job is started.

    def test_backup_holds_shared_lock_and_can_be_paused_without_interruption(self):
        w.open_admission(self.config)
        def encrypt(_config, path, _env):
            self.assertEqual(b.read_json(self.pending)["operation"], "backup")
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                self.worker()
            w.pause(self.config)
            path.write_bytes(b"ciphertext-fixture" * 30)
        self.backup(encrypt)
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.docker.calls, [])

    def test_uncertain_worker_blocks_retry_open_and_backup_after_lock_release(self):
        w.open_admission(self.config)
        self.docker.after["State"]["ExitCode"] = 1
        with self.assertRaisesRegex(b.BackupError, "worker-failed"):
            self.worker()
        for action in (self.worker, self.backup, lambda: w.open_admission(self.config)):
            with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                action()
        self.assertFalse((self.state / "worker-last-success.json").exists())
        self.assertEqual(self.store.calls, [])
        w.pause(self.config)  # Closing admission remains available on a failure.

    def test_backup_failure_blocks_worker_and_retry(self):
        w.open_admission(self.config)
        self.store.fault = "readback"
        with self.assertRaisesRegex(b.BackupError, "backup-failed-readback"):
            self.backup()
        count = len(self.store.calls)
        for action in (self.worker, self.backup):
            with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                action()
        self.assertEqual(len(self.store.calls), count)
        self.assertEqual(self.docker.calls, [])

    def test_transport_or_interruption_never_clears_pending(self):
        w.open_admission(self.config)
        self.docker.on_start = Mock(side_effect=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.worker()
        self.assertTrue(self.pending.exists())
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            self.backup()

    def test_cleanup_failure_keeps_guard_after_verified_worker_or_backup(self):
        original = tempfile.TemporaryDirectory
        @contextmanager
        def broken_cleanup(*args, **kwargs):
            with original(*args, **kwargs) as path:
                yield path
                raise OSError("private cleanup detail")
        w.open_admission(self.config)
        for operation in (self.worker, self.backup):
            with self.subTest(operation=operation.__name__):
                with patch.object(tempfile, "TemporaryDirectory", broken_cleanup), self.assertRaises(Exception):
                    operation()
                self.assertTrue(self.pending.exists())
                with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                    self.worker()
                # Synthetic transport only, no live process to reconcile.
                self.pending.unlink()

    def test_corrupt_or_dangling_pending_is_not_treated_as_idle(self):
        self.pending.symlink_to(self.state / "missing")
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            self.backup()
        self.pending.unlink()
        self.pending.write_text("broken")
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            self.backup()

    def test_prior_fresh_backup_does_not_mask_unsettled_worker(self):
        self.backup()
        b.check_freshness(self.config)
        w.open_admission(self.config)
        self.docker.after["State"]["OOMKilled"] = True
        with self.assertRaises(b.BackupError):
            self.worker()
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            b.check_freshness(self.config)

    def test_marker_symlink_and_public_lock_rejected(self):
        (self.state / w.ADMISSION).symlink_to(self.directory / "pilot.env")
        for action in (self.worker, lambda: w.pause(self.config)):
            with self.assertRaises(b.BackupError): action()
        lock = self.state / "maintenance.lock"
        lock.chmod(0o644)
        with self.assertRaisesRegex(b.BackupError, "lock-permissions"):
            with b.lock(self.state): pass

    def test_sigkill_releases_flock_but_durable_pending_blocks_new_operations(self):
        child = subprocess.Popen([sys.executable, "-B", "-c",
            "import sys,time; from pathlib import Path; import backup as b; "
            "state=Path(sys.argv[1]); "
            "guard=b.lock(state); guard.__enter__(); "
            "b.begin_operation(state,'worker','a'*64,container_name='synthetic-only'); "
            "print('ready',flush=True); time.sleep(30)", str(self.state)],
            cwd=Path(b.__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                self.backup()
            child.kill()
            child.wait(timeout=5)
            with b.lock(self.state):  # Kernel lock alone is now free.
                with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                    b.assert_operation_idle(self.state)
            with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                self.backup()
        finally:
            if child.poll() is None: child.kill()
            child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
