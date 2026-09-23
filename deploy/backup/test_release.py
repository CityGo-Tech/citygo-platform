"""Release checkpoint tests: no cloud, no deployment, real Linux locks/crash."""
import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import backup as b
import release as r
import worker as w
from test_backup import sample, MemoryStore


class Validation(unittest.TestCase):
    def test_target_and_disabled_config_fail_before_file_access(self):
        with patch.object(b, "protected") as protected:
            for target in (None, "main", "-option", "A" * 40, "a" * 39, "a" * 40 + "\n"):
                with self.subTest(target=target), self.assertRaises(b.BackupError):
                    with r.release_window(sample(), target): pass
            with self.assertRaisesRegex(b.BackupError, "upload-disabled"):
                with r.release_window({**sample(), "upload_enabled": False}, "b" * 40): pass
            protected.assert_not_called()


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux release window")
class ReleaseWindow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = sample(self.directory)
        self.state = self.directory / "state"
        self.state.mkdir(mode=0o700)
        for name in ("compose.yml", "pilot.env"):
            path = self.directory / name
            path.write_bytes(b"# synthetic release\n")
            path.chmod(0o600)
        self.store = MemoryStore()
        self.encrypt = lambda _c, p, _e: p.write_bytes(b"synthetic-ciphertext" * 30)
        self.pending = self.state / "operation-pending.json"

    def backup(self, window, **kwargs):
        return window.backup(storage_factory=lambda *_: self.store,
                             encryptor=kwargs.pop("encryptor", self.encrypt), min_free=0, **kwargs)

    def assert_locked(self):
        for action in (lambda: b.perform_backup(self.config), lambda: w.perform(self.config),
                       lambda: w.open_admission(self.config)):
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                action()
        with self.assertRaisesRegex(b.BackupError, "already-running"):
            with r.release_window(self.config, "c" * 40): pass

    def assert_pending_blocks(self):
        for action in (lambda: b.perform_backup(self.config), lambda: w.perform(self.config),
                       lambda: w.open_admission(self.config)):
            with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
                action()
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            with r.release_window(self.config, "c" * 40): pass

    def test_one_continuous_lock_before_during_after_backup_and_pending_after_exit(self):
        with r.release_window(self.config, "b" * 40) as window:
            self.assert_locked()
            operation = b.read_json(self.pending)
            self.assertEqual(operation["operation"], "release")
            self.assertEqual(self.pending.stat().st_mode & 0o777, 0o600)
            def encrypt(config, path, env):
                self.assert_locked()
                self.encrypt(config, path, env)
            checkpoint = self.backup(window, encryptor=encrypt)
            self.assert_locked()
            self.assertEqual(b.read_json(self.pending), operation)
            self.assertEqual(checkpoint["operation_id"], operation["id"])
            self.assertEqual(checkpoint["backup"]["operation_id"], operation["id"])
            self.assertEqual(checkpoint["target_sha"], "b" * 40)
            self.assertFalse(checkpoint["migration_authorized"])
            self.assertEqual(b.read_json(self.state / "release-backup.json"), checkpoint)
            self.assertEqual((self.state / "release-backup.json").stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(b.BackupError, "release-backup-already-attempted"):
                self.backup(window)
            w.pause(self.config)  # Short admission lock remains usable.
        self.assert_pending_blocks()
        with self.assertRaisesRegex(b.BackupError, "release-window-inactive"):
            self.backup(window)
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            b.check_freshness(self.config)
        self.assertEqual([x[0] for x in self.store.calls], ["put", "get", "put", "get"])

    def test_paused_admission_required_before_any_pending_or_upload(self):
        w.open_admission(self.config)
        with self.assertRaisesRegex(b.BackupError, "worker-not-paused"):
            with r.release_window(self.config, "b" * 40): pass
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.store.calls, [])

    def test_existing_pending_and_dangling_admission_fail_closed(self):
        (self.state / w.ADMISSION).symlink_to(self.state / "missing")
        with self.assertRaisesRegex(b.BackupError, "worker-not-paused"):
            with r.release_window(self.config, "b" * 40): pass
        (self.state / w.ADMISSION).unlink()
        self.pending.write_text("corrupt")
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"):
            with r.release_window(self.config, "b" * 40): pass

    def test_external_failure_before_or_after_backup_never_clears_pending(self):
        for after in (False, True):
            with self.subTest(after=after), self.assertRaisesRegex(RuntimeError, "fixture"):
                with r.release_window(self.config, "b" * 40) as window:
                    if after: self.backup(window)
                    raise RuntimeError("fixture")
            self.assert_pending_blocks()
            self.pending.unlink()  # Synthetic fixture only; independent fault cases.

    def test_no_backup_on_normal_exit_does_not_pretend_success(self):
        with r.release_window(self.config, "b" * 40): pass
        self.assert_pending_blocks()
        self.assertFalse((self.state / "release-backup.json").exists())

    def test_failures_no_checkpoint_no_retry_even_when_caught(self):
        for fault in ("put", "readback", "manifest", "marker-readback"):
            self.store.fault = fault
            with self.subTest(fault=fault), r.release_window(self.config, "b" * 40) as window:
                with self.assertRaises(b.BackupError): self.backup(window)
                count = len(self.store.calls)
                with self.assertRaisesRegex(b.BackupError, "release-backup-already-attempted"):
                    self.backup(window)
                self.assertEqual(len(self.store.calls), count)
                self.assertFalse((self.state / "release-backup.json").exists())
            self.assert_pending_blocks()
            self.pending.unlink()

    def test_partial_dump_never_uploads_and_keyboard_interrupt_keeps_pending(self):
        def interrupted(_c, path, _e):
            path.write_bytes(b"partial")
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            with r.release_window(self.config, "b" * 40) as window:
                self.backup(window, encryptor=interrupted)
        self.assertEqual(self.store.calls, [])
        self.assert_pending_blocks()

    def test_caller_config_mutation_does_not_retarget_window(self):
        mutable = copy.deepcopy(self.config)
        with r.release_window(mutable, "b" * 40) as window:
            mutable["bucket"] = "different-bucket"
            checkpoint = self.backup(window)
            self.assertEqual(checkpoint["backup"]["configuration_sha256"], b.configuration_fingerprint(self.config))

    def test_file_drift_after_open_refuses_backup_without_io(self):
        with r.release_window(self.config, "b" * 40) as window:
            Path(self.config["compose_env"]).write_bytes(b"different")
            with self.assertRaisesRegex(b.BackupError, "configuration-changed"):
                self.backup(window)
        self.assertEqual(self.store.calls, [])
        self.assert_pending_blocks()

    def test_restoring_preflight_inputs_never_resurrects_failed_attempt(self):
        for changed in ("configuration", "pending", "admission"):
            with self.subTest(changed=changed), r.release_window(self.config, "b" * 40) as window:
                env = Path(self.config["compose_env"])
                original_env = env.read_bytes()
                original_operation = b.read_json(self.pending)
                if changed == "configuration":
                    env.write_bytes(b"changed configuration")
                elif changed == "pending":
                    b.atomic_json(self.pending, {**original_operation, "id": "f" * 32})
                else:
                    b.atomic_json(self.state / w.ADMISSION, {"unexpected": True})
                with self.assertRaises(b.BackupError): self.backup(window)
                # Revert ONLY this synthetic mutation; the failed attempt stays poisoned.
                env.write_bytes(original_env)
                b.atomic_json(self.pending, original_operation)
                if changed == "admission": (self.state / w.ADMISSION).unlink()
                with self.assertRaisesRegex(b.BackupError, "release-backup-already-attempted"):
                    self.backup(window)
                self.assertEqual(self.store.calls, [])
                self.assertFalse((self.state / "release-backup.json").exists())
            self.assert_pending_blocks()
            self.pending.unlink()  # Independent synthetic fault cases, no live operations.

    def test_dump_uses_snapshot_and_detects_live_drift_before_success(self):
        captured = []
        def encrypt(config, path, env):
            for key in ("compose_env", "compose_file"):
                captured.append(Path(config[key]))
                self.assertNotEqual(config[key], self.config[key])
                self.assertEqual(Path(config[key]).read_bytes(), b"# synthetic release\n")
                self.assertEqual(Path(config[key]).stat().st_mode & 0o777, 0o600)
                Path(self.config[key]).write_bytes(b"replacement after snapshot")
                self.assertEqual(Path(config[key]).read_bytes(), b"# synthetic release\n")
            self.assertEqual(config["_compose_project_directory"], str(self.directory))
            self.encrypt(config, path, env)
        with r.release_window(self.config, "b" * 40) as window:
            with self.assertRaisesRegex(b.BackupError, "backup-failed-status"):
                self.backup(window, encryptor=encrypt)
        self.assertTrue(all(not p.exists() for p in captured))
        self.assertFalse((self.state / "last-success.json").exists())
        self.assertFalse((self.state / "release-backup.json").exists())
        self.assert_pending_blocks()

    def test_replaced_operation_refuses_backup(self):
        with r.release_window(self.config, "b" * 40) as window:
            changed = b.read_json(self.pending)
            changed["id"] = "c" * 32
            b.atomic_json(self.pending, changed)
            with self.assertRaisesRegex(b.BackupError, "operation-changed"):
                self.backup(window)
        self.assertEqual(self.store.calls, [])

    def test_window_not_transferable_to_another_thread(self):
        errors = []
        with r.release_window(self.config, "b" * 40) as window:
            def attempt():
                try: self.backup(window)
                except b.BackupError as error: errors.append(str(error))
            thread = threading.Thread(target=attempt)
            thread.start()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, ["release-window-inactive"])
            self.assertEqual(self.store.calls, [])
            self.backup(window)  # A rejected foreign thread cannot poison the owner's attempt.

    def test_cleanup_failure_cannot_create_success_checkpoint(self):
        original = tempfile.TemporaryDirectory
        @contextmanager
        def failing_cleanup(*args, **kwargs):
            with original(*args, **kwargs) as path:
                yield path
                raise OSError("fixture cleanup")
        with r.release_window(self.config, "b" * 40) as window:
            with patch.object(tempfile, "TemporaryDirectory", failing_cleanup), self.assertRaises(b.BackupError):
                self.backup(window)
        self.assertFalse((self.state / "last-success.json").exists())
        self.assertFalse((self.state / "release-backup.json").exists())
        self.assert_pending_blocks()

    def test_sigkill_after_verified_backup_cannot_reopen_admission(self):
        config_path = self.directory / "backup.json"
        config_path.write_text(json.dumps(self.config))
        config_path.chmod(0o600)
        code = (
            "import sys,time; import backup as b,release as r; from test_backup import MemoryStore; "
            "config=b.load_config(sys.argv[1]); guard=r.release_window(config,'b'*40); window=guard.__enter__(); "
            "window.backup(storage_factory=lambda *_:MemoryStore(),encryptor=lambda c,p,e:p.write_bytes(b'x'*200),min_free=0); "
            "print('ready',flush=True); time.sleep(30)"
        )
        child = subprocess.Popen([sys.executable, "-B", "-c", code, str(config_path)],
            cwd=Path(b.__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            self.assert_locked()
            child.kill()
            child.wait(timeout=5)
            with b.lock(self.state): pass  # Kernel lock is free, persistent guard is not.
            self.assert_pending_blocks()
            self.assertFalse(b.read_json(self.state / "release-backup.json")["migration_authorized"])
        finally:
            if child.poll() is None: child.kill()
            child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
