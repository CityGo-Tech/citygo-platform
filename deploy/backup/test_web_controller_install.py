"""Root/Linux real-filesystem installer tests; no daemon or server access.

Checkpoint exceptions exercise file-only reconciliation. The separate disposable
smoke kills an actual child; these unit tests do not claim power-loss proof.
"""
import builtins
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

import web_controller_install_smoke as smoke


NAMES = ("backup.py", "web_switch.py", "web_switch_assets.py")


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def snapshot(root):
    """Ignore read atime and kernel flock state; include every file's bytes."""
    result = {}
    for path in [root, *sorted(root.rglob("*"))]:
        meta = path.lstat()
        item = {"mode": stat.S_IMODE(meta.st_mode), "uid": meta.st_uid,
                "gid": meta.st_gid, "nlink": meta.st_nlink}
        if stat.S_ISREG(meta.st_mode):
            item["bytes"] = path.read_bytes()
        elif stat.S_ISLNK(meta.st_mode):
            item["target"] = os.readlink(path)
        result[str(path.relative_to(root))] = item
    return result


class PrivateCheckpointHalt(BaseException):
    """Test-only interruption, never a public CLI/environment switch."""


class InertSmoke(unittest.TestCase):
    def test_default_and_plan_do_not_import_installer_spawn_or_create_files(self):
        with patch.object(smoke, "disposable") as disposable, \
                patch.object(smoke.subprocess, "Popen") as spawn, \
                patch.object(smoke.importlib.util, "spec_from_file_location") as load, \
                patch.object(smoke.tempfile, "TemporaryDirectory") as temporary:
            for args in ([], ["--plan"]):
                result = smoke.run(args)
                self.assertIs(result["serverAccess"], False)
                self.assertIs(result["runtimeChanged"], False)
            disposable.assert_not_called()
            spawn.assert_not_called()
            load.assert_not_called()
            temporary.assert_not_called()

    def test_smoke_mutating_override_and_duplicate_flags_are_rejected(self):
        with patch.object(smoke, "disposable") as disposable:
            for args in (["--install"], ["--apply"], ["--disposable", "--root", "/opt/citygo"],
                         ["--disposable", "--disposable"], ["--plan", "--disposable"]):
                with self.subTest(args=args), self.assertRaises(smoke.SmokeError):
                    smoke.run(args)
            disposable.assert_not_called()


@unittest.skipUnless(sys.platform.startswith("linux") and hasattr(os, "geteuid") and os.geteuid() == 0,
                     "Mandatory filesystem suite requires Linux root and a protected TMPDIR")
class RootFilesystem(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="citygo-controller-install-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        trusted = self.root / "trusted"
        trusted.mkdir(mode=0o700)
        source = Path(__file__).with_name("web_controller_install.py").read_bytes()
        module_path = trusted / "web_controller_install.py"
        module_path.write_bytes(source)
        module_path.chmod(0o644)
        name = "private_installer_unit_" + str(id(self))
        spec = importlib.util.spec_from_file_location(name, module_path)
        self.installer = importlib.util.module_from_spec(spec)
        sys.modules[name] = self.installer
        self.addCleanup(sys.modules.pop, name, None)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(self.installer)
        self.assertEqual(digest(module_path.read_bytes()), digest(source))
        self.install_root = self.root / "install"
        self.state = self.root / "state"
        self.coordination = self.root / "coordination"
        for path, mode in ((self.install_root, 0o755), (self.state, 0o700), (self.coordination, 0o700)):
            path.mkdir(mode=mode)
        for name in ("maintenance.lock", "worker-admission.lock"):
            self.write(self.coordination / name, b"", 0o600)
        self.write(self.state / "install.lock", b"", 0o600)
        # A code-only install must preserve an existing open grant verbatim.
        self.write(self.coordination / "worker-admission.json", b"synthetic grant remains open\n", 0o600)
        self.installer.INSTALL_ROOT = self.install_root
        self.installer.STATE_ROOT = self.state
        self.installer.COORDINATION_ROOT = self.coordination
        self.source = self.root / "payload"
        self.source.mkdir(mode=0o700)
        self.payload = {name: ("# synthetic " + name + "\nraise RuntimeError('PAYLOAD_MUST_NOT_RUN')\n").encode()
                        for name in NAMES}
        for name, raw in self.payload.items():
            self.write(self.source / name, raw, 0o644)
        self.manifest = {"version": 1, "purpose": "citygo-web-switch-controller-payload-v1",
                         "files": {name: {"sha256": digest(raw), "size": len(raw)}
                                   for name, raw in self.payload.items()}}
        self.manifest_raw = encoded(self.manifest)
        self.write(self.source / "manifest.json", self.manifest_raw, 0o644)
        self.manifest_sha = digest(self.manifest_raw)
        self.now = 2000000000
        self.approval = {"version": 1, "purpose": "citygo-web-switch-controller-install-v1",
                         "operation_id": "a" * 32, "manifest_sha256": self.manifest_sha,
                         "bootstrap_draft_sha256": "b" * 64, "approved_at": self.now - 1,
                         "expires_at": self.now + 600, "allow_install": True}
        self.approval_path = self.root / "install-approval.json"
        self.approval_raw = encoded(self.approval)
        self.write(self.approval_path, self.approval_raw, 0o600)
        self.destination = self.install_root / ("web-switch-controller-" + self.manifest_sha)
        self.live = self.root / "unchanged-live-sentinels"
        self.live.mkdir(mode=0o700)
        for name in ("compose.json", "backup.json", "ACTIVE", "traffic-open", "api.json", "privkey.pem", "autodeploy.json"):
            self.write(self.live / name, ("synthetic unchanged " + name + "\n").encode(), 0o600)
        self.live_before = snapshot(self.live)
        self.coordination_before = snapshot(self.coordination)

    def write(self, path, raw, mode=0o600):
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            pass
        else:
            self.assertTrue(stat.S_ISREG(metadata.st_mode), "Fixture writes require an owned regular path")
            # Simulate an owner's deliberate tamper without CAP_DAC_OVERRIDE.
            # Production immutable files are never modified by this helper.
            path.chmod(0o600)
        path.write_bytes(raw)
        path.chmod(mode)

    def install(self, **options):
        return self.installer.install_package(self.source, self.approval_path, allow_install=True,
                                              now=self.now, **options)

    def inspect(self):
        return self.installer.inspect_install(self.manifest_sha)

    def assert_live_unchanged(self):
        self.assertEqual(snapshot(self.live), self.live_before)
        self.assertEqual(snapshot(self.coordination), self.coordination_before)
        self.assertFalse((self.source / "__pycache__").exists())

    def assert_installed(self, result):
        self.assertEqual(result["status"], "installed-inactive")
        self.assertIs(result["pending"], False)
        self.assertIs(result["activation_authorized"], False)
        self.assertIs(result["runtime_changed"], False)
        self.assertEqual(result["manifest_sha256"], self.manifest_sha)
        self.assertEqual(result["bootstrap_draft_sha256"], self.approval["bootstrap_draft_sha256"])
        self.assertEqual(set(p.name for p in self.destination.iterdir()), set(NAMES) | {"manifest.json", "installed.json"})
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        for path in self.destination.iterdir():
            meta = path.lstat()
            self.assertTrue(stat.S_ISREG(meta.st_mode))
            self.assertEqual((meta.st_uid, meta.st_nlink, stat.S_IMODE(meta.st_mode)), (0, 1, 0o444))
        for name, raw in self.payload.items():
            self.assertEqual((self.destination / name).read_bytes(), raw)
        self.assertEqual((self.destination / "manifest.json").read_bytes(), self.manifest_raw)
        self.assertFalse((self.state / "pending.json").exists())
        audit = self.state / ("approval-" + self.approval["operation_id"] + ".json")
        self.assertEqual(audit.read_bytes(), self.approval_raw)
        self.assertEqual(stat.S_IMODE(audit.stat().st_mode), 0o400)
        self.assert_live_unchanged()

    def interrupted(self, point):
        seen = []
        def checkpoint(name):
            seen.append(name)
            if name == point:
                raise PrivateCheckpointHalt()
        with self.assertRaises(PrivateCheckpointHalt):
            self.install(_checkpoint=checkpoint)
        self.assertIn(point, seen)
        pending = (self.state / "pending.json").read_bytes()
        info = self.inspect()
        self.assertEqual(info["status"], "pending")
        self.assertIs(info["pending"], True)
        self.assertEqual(info["pending_sha256"], digest(pending))
        self.assertIs(info["runtime_changed"], False)
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        self.assert_live_unchanged()
        return pending, info

    def reconcile_approval(self, info, *, now=None, changes=None):
        now = self.now + 4000 if now is None else now
        value = {key: copy.deepcopy(item) for key, item in self.approval.items() if key != "allow_install"}
        value.update(purpose="citygo-web-switch-controller-reconcile-v1", approved_at=now - 1,
                     expires_at=now + 600, allow_reconcile=True, pending_sha256=info["pending_sha256"])
        value.update(changes or {})
        path = self.root / "reconcile-approval.json"
        self.write(path, encoded(value), 0o600)
        return path, now

    def recover_after(self, point):
        pending, info = self.interrupted(point)
        published = {p.name: p.stat().st_ino for p in self.destination.iterdir()
                     if p.name in NAMES and p.is_file()} if self.destination.exists() else {}
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        path, now = self.reconcile_approval(info)
        # The original install capability has expired. Its raw audit is kept;
        # reconciliation requires a new, same-operation/pending-bound capability.
        self.assertGreater(now, self.approval["expires_at"])
        result = self.installer.reconcile_package(self.source, path, allow_reconcile=True, now=now)
        self.assert_installed(result)
        for name, inode in published.items():
            self.assertEqual((self.destination / name).stat().st_ino, inode)
        self.assertEqual(result["original_approval_sha256"], digest(self.approval_raw))
        self.assertEqual(result["reconcile_approval_sha256"],
                         None if point == "receipt-durable" else digest(path.read_bytes()))

    def test_install_writes_only_inactive_exact_payload_and_immutable_receipt(self):
        original_import = builtins.__import__
        def no_payload_import(name, *args, **kwargs):
            if name in {name[:-3] for name in NAMES}:
                raise AssertionError("payload imported")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=no_payload_import), \
                patch("subprocess.run", side_effect=AssertionError("process")), \
                patch("subprocess.Popen", side_effect=AssertionError("process")), \
                patch("socket.socket", side_effect=AssertionError("network")), \
                patch("os.system", side_effect=AssertionError("shell")):
            self.assert_installed(self.install())

    def test_explicit_permission_and_root_are_required_before_payload_mutation(self):
        before = snapshot(self.root)
        for flag in (False, 0, 1, None):
            with self.subTest(flag=flag), self.assertRaises(self.installer.InstallError):
                self.installer.install_package(self.source, self.approval_path, allow_install=flag, now=self.now)
        with patch.object(self.installer.os, "geteuid", return_value=1001), \
                self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertEqual(snapshot(self.root), before)

    def test_inspect_is_read_only_before_and_after_install_and_ignores_capability_expiry(self):
        before = snapshot(self.root)
        result = self.installer.inspect_install()
        self.assertEqual(result["status"], "idle")
        self.assertEqual(self.inspect()["status"], "not-installed")
        self.assertEqual(snapshot(self.root), before)
        self.assert_installed(self.install())
        before = snapshot(self.root)
        with patch.object(self.installer.time, "time", return_value=self.now + 100000):
            result = self.inspect()
        self.assertEqual(result["status"], "installed-inactive")
        self.assertEqual(snapshot(self.root), before)

    def test_inspect_does_not_create_missing_state_roots(self):
        (self.state / "install.lock").unlink()
        self.state.rmdir()
        before = snapshot(self.root)
        self.assertEqual(self.installer.inspect_install()["status"], "idle")
        self.assertEqual(snapshot(self.root), before)

    def test_kernel_locks_cover_pending_payload_and_receipt_writes(self):
        import fcntl
        checked = []
        def checkpoint(name):
            if name not in ("pending-durable", "file-published:backup.py", "receipt-durable"):
                return
            for path in (self.coordination / "maintenance.lock", self.coordination / "worker-admission.lock",
                         self.state / "install.lock"):
                descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(descriptor)
            checked.append(name)
        self.assert_installed(self.install(_checkpoint=checkpoint))
        self.assertEqual(set(checked), {"pending-durable", "file-published:backup.py", "receipt-durable"})

    def test_each_existing_lock_refuses_concurrent_install_without_pending_or_target(self):
        import fcntl
        for path in (self.coordination / "maintenance.lock", self.coordination / "worker-admission.lock",
                     self.state / "install.lock"):
            descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.subTest(lock=path.name), self.assertRaises(self.installer.InstallError):
                    self.install()
                self.assertFalse((self.state / "pending.json").exists())
                self.assertFalse(self.destination.exists())
            finally:
                os.close(descriptor)
        self.assert_live_unchanged()

    def test_all_three_legacy_pending_names_refuse_install_without_modification(self):
        for name in ("operation-pending.json", "worker-pending.json", "pending.json"):
            path = self.coordination / name
            raw = b"synthetic unknown pending must remain\n"
            self.write(path, raw, 0o600)
            with self.subTest(pending=name), self.assertRaises(self.installer.InstallError):
                self.install()
            self.assertEqual(path.read_bytes(), raw)
            self.assertFalse(self.destination.exists())
            self.assertFalse((self.state / "pending.json").exists())
            path.unlink()
        self.assert_live_unchanged()

    def test_private_umask_does_not_weaken_or_change_exact_installed_modes(self):
        previous = os.umask(0o077)
        try:
            result = self.install()
        finally:
            os.umask(previous)
        self.assert_installed(result)

    def test_original_capability_schema_times_and_binding_are_strict(self):
        for changes in ({"version": True}, {"purpose": "citygo-web-switch-controller-reconcile-v1"},
                        {"allow_install": 1}, {"allow_install": False}, {"allow_reconcile": True},
                        {"operation_id": "../unsafe"}, {"manifest_sha256": "f" * 64},
                        {"bootstrap_draft_sha256": "main"}, {"approved_at": self.now + 1},
                        {"approved_at": True}, {"expires_at": self.now},
                        {"expires_at": self.approval["approved_at"] + 3601}, {"root": "/etc"}):
            value = {**self.approval, **changes}
            self.write(self.approval_path, encoded(value), 0o600)
            with self.subTest(changes=changes), self.assertRaises(self.installer.InstallError):
                self.install()
            self.assertFalse(self.destination.exists())
            self.assertFalse((self.state / "pending.json").exists())
        self.assert_live_unchanged()

    def test_capability_symlinks_hardlinks_permissions_and_foreign_owner_are_rejected(self):
        external = self.root / "external-approval.json"
        self.write(external, self.approval_raw, 0o600)
        self.approval_path.unlink()
        self.approval_path.symlink_to(external)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.approval_path.unlink()
        os.link(external, self.approval_path)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.approval_path.unlink()
        self.write(self.approval_path, self.approval_raw, 0o644)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.approval_path.chmod(0o600)
        os.chown(self.approval_path, 1001, 1001)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertFalse(self.destination.exists())

    def test_manifest_closed_shape_exact_source_inventory_and_pinned_bytes(self):
        for changes in ({"version": True}, {"purpose": "citygo-staged-web-switch-v2"},
                        {"files": {}}, {"files": {**self.manifest["files"], "extra.py": {"sha256": "c" * 64, "size": 1}}},
                        {"files": {**self.manifest["files"], "backup.py": {"sha256": "c" * 64, "size": True}}}):
            raw = encoded({**self.manifest, **changes})
            self.write(self.source / "manifest.json", raw, 0o644)
            self.write(self.approval_path, encoded({**self.approval, "manifest_sha256": digest(raw)}), 0o600)
            with self.subTest(changes=changes), self.assertRaises(self.installer.InstallError):
                self.install()
        self.write(self.source / "manifest.json", self.manifest_raw, 0o644)
        self.write(self.approval_path, self.approval_raw, 0o600)
        self.write(self.source / "extra.py", b"# not approved\n", 0o644)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        (self.source / "extra.py").unlink()
        self.write(self.source / "backup.py", b"changed payload\n", 0o644)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertFalse(self.destination.exists())

    def test_payload_links_foreign_owner_and_writable_source_are_rejected(self):
        path = self.source / "backup.py"
        outside = self.root / "external-payload.py"
        self.write(outside, self.payload["backup.py"], 0o644)
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        path.unlink()
        os.link(outside, path)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        path.unlink()
        self.write(path, self.payload["backup.py"], 0o644)
        for item in self.source.iterdir():
            os.chown(item, 1001, 1001)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        for item in self.source.iterdir():
            os.chown(item, 0, 0)
        path.chmod(0o666)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        path.chmod(0o644)
        self.source.chmod(0o777)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertFalse(self.destination.exists())
        self.assertFalse((self.state / "pending.json").exists())

    def test_malformed_json_and_oversized_capability_errors_are_sanitized(self):
        for raw in (b"", b"{", b"[]", b"null", b'{"version":1,"version":1}', b'{"value":NaN}',
                    b"x" * (64 * 1024 + 1), b"\xff"):
            self.write(self.approval_path, raw, 0o600)
            with self.subTest(prefix=raw[:30]), self.assertRaises(self.installer.InstallError) as error:
                self.install()
            self.assertRegex(str(error.exception), r"^[a-z][a-z0-9-]+$")
        self.assertFalse(self.destination.exists())

    def test_foreign_target_is_never_adopted_or_overwritten(self):
        self.destination.mkdir(mode=0o755)
        self.write(self.destination / "unrelated.txt", b"must remain\n", 0o444)
        before = snapshot(self.destination)
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertEqual(snapshot(self.destination), before)
        self.assert_live_unchanged()

    def test_recover_pending_before_directory(self):
        self.recover_after("pending-durable")

    def test_recover_created_directory(self):
        self.recover_after("directory-created")

    def test_recover_empty_operation_owned_temp(self):
        self.recover_after("temp-created:backup.py")

    def test_recover_written_operation_owned_temp(self):
        self.recover_after("temp-written:backup.py")

    def test_recover_linked_file_without_replacing_published_inode(self):
        self.recover_after("file-linked:backup.py")

    def test_recover_published_file_without_replacing_inode(self):
        self.recover_after("file-published:backup.py")

    def test_recover_verified_tree_before_receipt(self):
        self.recover_after("tree-verified")

    def test_recover_receipt_durable_before_pending_clear(self):
        self.recover_after("receipt-durable")

    def test_lost_stdout_after_pending_clear_is_inspectable_without_writes(self):
        seen = []
        def checkpoint(name):
            seen.append(name)
            if name == "pending-cleared":
                raise PrivateCheckpointHalt()
        with self.assertRaises(PrivateCheckpointHalt):
            self.install(_checkpoint=checkpoint)
        self.assertIn("pending-cleared", seen)
        before = snapshot(self.root)
        self.assert_installed(self.inspect())
        self.assertEqual(snapshot(self.root), before)

    def test_reconcile_requires_new_explicit_same_pending_operation_and_binding(self):
        pending, info = self.interrupted("pending-durable")
        for changes in ({"pending_sha256": "f" * 64}, {"operation_id": "c" * 32},
                        {"manifest_sha256": "f" * 64}, {"bootstrap_draft_sha256": "f" * 64},
                        {"allow_reconcile": 1}, {"allow_install": True}, {"expires_at": self.now + 4000}):
            path, now = self.reconcile_approval(info, changes=changes)
            with self.subTest(changes=changes), self.assertRaises(self.installer.InstallError):
                self.installer.reconcile_package(self.source, path, allow_reconcile=True, now=now)
            self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        path, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, path, now=now)
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        self.assert_installed(self.installer.reconcile_package(self.source, path, allow_reconcile=True, now=now))

    def test_missing_reconcile_lock_is_never_silently_skipped(self):
        import fcntl
        pending, info = self.interrupted("pending-durable")
        cap, now = self.reconcile_approval(info)
        for path in (self.coordination / "maintenance.lock", self.coordination / "worker-admission.lock",
                     self.state / "install.lock"):
            path.unlink()
            # Either fail closed, or recreate and really hold the missing lock.
            # Proceeding with no lock is forbidden even for file-only recovery.
            reached = []
            def checkpoint(name):
                if name == "directory-created":
                    reached.append(name)
                    self.assertTrue(path.exists())
                    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
                    try:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        os.close(descriptor)
                    raise PrivateCheckpointHalt()
            try:
                self.installer.reconcile_package(self.source, cap, allow_reconcile=True,
                                                  now=now, _checkpoint=checkpoint)
            except (self.installer.InstallError, PrivateCheckpointHalt):
                pass
            else:
                self.fail("Reconciliation bypassed a missing lock")
            self.assertEqual((self.state / "pending.json").read_bytes(), pending)
            if not path.exists():
                self.write(path, b"", 0o600)
            if reached:
                # The fail-closed production path currently leaves no directory;
                # a future safely recreated lock may reach this private barrier.
                self.assertTrue(self.destination.exists())
                break

    def test_readonly_bad_hash_temp_is_preserved_instead_of_repaired(self):
        pending, info = self.interrupted("temp-written:backup.py")
        temp = self.destination / (".install-" + self.approval["operation_id"] + "-backup.py.tmp")
        self.write(temp, b"foreign immutable temporary bytes\n", 0o444)
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual(temp.read_bytes(), b"foreign immutable temporary bytes\n")
        self.assertEqual(stat.S_IMODE(temp.stat().st_mode), 0o444)
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)

    def test_private_nonprefix_temp_is_not_repaired(self):
        pending, info = self.interrupted("temp-created:backup.py")
        temp = self.destination / (".install-" + self.approval["operation_id"] + "-backup.py.tmp")
        self.write(temp, b"not an approved payload prefix\n", 0o600)
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual(temp.read_bytes(), b"not an approved payload prefix\n")
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)

    def test_foreign_hardlink_is_not_mistaken_for_interrupted_own_link(self):
        pending, info = self.interrupted("file-linked:backup.py")
        linked = self.destination / (".install-" + self.approval["operation_id"] + "-backup.py.tmp")
        linked.unlink()
        foreign = self.root / "foreign.py"
        self.write(foreign, self.payload["backup.py"], 0o444)
        os.link(foreign, linked)
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual(linked.stat().st_ino, foreign.stat().st_ino)
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)

    def test_target_name_replacement_at_receipt_keeps_pending_and_foreign_directory(self):
        seen = []
        moved = self.install_root / "preserved-original-directory"
        def checkpoint(name):
            if name == "receipt-durable":
                seen.append(name)
                self.destination.rename(moved)
                self.destination.mkdir(mode=0o755)
                self.write(self.destination / "foreign.txt", b"do not touch\n", 0o444)
        with self.assertRaises(self.installer.InstallError):
            self.install(_checkpoint=checkpoint)
        self.assertEqual(seen, ["receipt-durable"])
        self.assertTrue((self.state / "pending.json").exists())
        self.assertTrue((moved / "installed.json").exists())
        self.assertEqual((self.destination / "foreign.txt").read_bytes(), b"do not touch\n")
        self.assert_live_unchanged()

    def test_coordination_root_replacement_at_receipt_keeps_pending(self):
        seen = []
        moved = self.root / "preserved-original-coordination"
        def checkpoint(name):
            if name == "receipt-durable":
                seen.append(name)
                self.coordination.rename(moved)
                self.coordination.mkdir(mode=0o700)
                self.write(self.coordination / "foreign.txt", b"replacement must remain untouched\n", 0o600)
        with self.assertRaises(self.installer.InstallError):
            self.install(_checkpoint=checkpoint)
        self.assertEqual(seen, ["receipt-durable"])
        self.assertTrue((self.state / "pending.json").exists())
        self.assertEqual(snapshot(moved), self.coordination_before)
        self.assertEqual(set(path.name for path in self.coordination.iterdir()), {"foreign.txt"})
        self.assertEqual((self.coordination / "foreign.txt").read_bytes(), b"replacement must remain untouched\n")
        self.assertEqual(snapshot(self.live), self.live_before)

    def test_existing_installed_tree_without_original_audit_is_not_adopted(self):
        self.assert_installed(self.install())
        audit = self.state / ("approval-" + self.approval["operation_id"] + ".json")
        audit.unlink()
        before = snapshot(self.root)
        with self.assertRaises(self.installer.InstallError):
            self.inspect()
        with self.assertRaises(self.installer.InstallError):
            self.install()
        self.assertEqual(snapshot(self.root), before)

    def test_receipt_authority_boolean_types_and_unknown_fields_are_not_normalized(self):
        self.assert_installed(self.install())
        path = self.destination / "installed.json"
        raw = path.read_bytes()
        original = json.loads(raw)
        for change in ({"activation_authorized": 0}, {"runtime_changed": 0}, {"version": True}, {"extra": False}):
            self.write(path, encoded({**original, **change}), 0o444)
            with self.subTest(change=change), self.assertRaises(self.installer.InstallError):
                self.inspect()
        self.write(path, raw, 0o444)

    def test_published_final_tamper_keeps_pending_and_never_repairs_it(self):
        pending, info = self.interrupted("file-published:backup.py")
        path = self.destination / "backup.py"
        self.write(path, b"unapproved final bytes\n", 0o444)
        self.assertEqual(self.inspect()["phase"], "drift")
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual(path.read_bytes(), b"unapproved final bytes\n")
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        self.assert_live_unchanged()

    def test_unexpected_partial_file_is_not_deleted_by_reconciliation(self):
        pending, info = self.interrupted("directory-created")
        foreign = self.destination / "foreign.txt"
        self.write(foreign, b"preserve this evidence\n", 0o600)
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual(foreign.read_bytes(), b"preserve this evidence\n")
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)

    def test_original_audit_tamper_prevents_reconciliation(self):
        pending, info = self.interrupted("pending-durable")
        audit = self.state / ("approval-" + self.approval["operation_id"] + ".json")
        self.write(audit, self.approval_raw + b" ", 0o400)
        cap, now = self.reconcile_approval(info)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)

    def completed_reconciliation(self):
        pending, info = self.interrupted("pending-durable")
        cap, now = self.reconcile_approval(info)
        result = self.installer.reconcile_package(self.source, cap, allow_reconcile=True, now=now)
        self.assert_installed(result)
        audit = self.state / ("reconcile-" + digest(cap.read_bytes()) + ".json")
        self.assertEqual(audit.read_bytes(), cap.read_bytes())
        self.assertEqual(stat.S_IMODE(audit.stat().st_mode), 0o400)
        transaction = self.state / ("transaction-" + self.approval["operation_id"] + ".json")
        self.assertEqual(transaction.read_bytes(), pending)
        self.assertEqual(stat.S_IMODE(transaction.stat().st_mode), 0o400)
        return audit, transaction, now

    def assert_inspection_and_fresh_replay_refuse(self, now):
        before = snapshot(self.root)
        with self.assertRaises(self.installer.InstallError):
            self.inspect()
        self.assertEqual(snapshot(self.root), before)
        fresh = {**self.approval, "approved_at": now - 1, "expires_at": now + 600}
        path = self.root / "fresh-install-replay.json"
        self.write(path, encoded(fresh), 0o600)
        before = snapshot(self.root)
        with self.assertRaises(self.installer.InstallError):
            self.installer.install_package(self.source, path, allow_install=True, now=now)
        self.assertEqual(snapshot(self.root), before)

    def test_missing_fresh_reconcile_audit_refuses_inspect_and_fresh_install_replay(self):
        audit, _, now = self.completed_reconciliation()
        audit.chmod(0o000)
        with self.assertRaises(self.installer.InstallError):
            self.inspect()
        self.assertEqual(stat.S_IMODE(audit.stat().st_mode), 0o000)
        audit.chmod(0o400)
        audit.unlink()
        self.assert_inspection_and_fresh_replay_refuse(now)

    def test_changed_fresh_audit_or_transaction_is_preserved_and_refused(self):
        audit, transaction, now = self.completed_reconciliation()
        for path in (audit, transaction):
            raw = path.read_bytes()
            self.write(path, raw + b" ", 0o400)
            with self.subTest(audit=path.name):
                self.assert_inspection_and_fresh_replay_refuse(now)
                self.assertEqual(path.read_bytes(), raw + b" ")
            self.write(path, raw, 0o400)

    def test_arbitrary_receipt_reconcile_hash_is_not_accepted_as_audit(self):
        _, _, now = self.completed_reconciliation()
        path = self.destination / "installed.json"
        value = json.loads(path.read_bytes())
        value["reconcile_approval_sha256"] = "f" * 64
        self.write(path, encoded(value), 0o444)
        self.assert_inspection_and_fresh_replay_refuse(now)

    def test_pending_fresh_audit_loss_cannot_be_repaired_by_another_reconcile(self):
        pending, info = self.interrupted("pending-durable")
        cap, now = self.reconcile_approval(info)
        def checkpoint(name):
            if name == "receipt-durable":
                raise PrivateCheckpointHalt()
        with self.assertRaises(PrivateCheckpointHalt):
            self.installer.reconcile_package(self.source, cap, allow_reconcile=True,
                                              now=now, _checkpoint=checkpoint)
        audit = self.state / ("reconcile-" + digest(cap.read_bytes()) + ".json")
        audit.unlink()
        receipt = (self.destination / "installed.json").read_bytes()
        try:
            current = self.inspect()
        except self.installer.InstallError:
            pass
        else:
            self.assertEqual((current["status"], current["phase"]), ("pending", "drift"))
        next_cap, later = self.reconcile_approval(info, now=now + 4000)
        with self.assertRaises(self.installer.InstallError):
            self.installer.reconcile_package(self.source, next_cap, allow_reconcile=True, now=later)
        self.assertFalse(audit.exists())
        self.assertEqual((self.state / "pending.json").read_bytes(), pending)
        self.assertEqual((self.destination / "installed.json").read_bytes(), receipt)
        self.assert_live_unchanged()


if __name__ == "__main__":
    unittest.main()
