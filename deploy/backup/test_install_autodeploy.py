"""Enrollment file safety; no accounts, sudo rules or real credentials are changed."""
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import start as s


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux enrollment imports pwd")
class ProfileSelection(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("citygo_install_profile_fixture", Path(__file__).resolve().parents[1] / "install-autodeploy.py")
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def test_exact_modes_never_silently_downgrade_new_profile_to_legacy(self):
        self.assertEqual(self.installer.api_profile({"DATABASE_URL": "synthetic"}, s), s.PROFILE)
        for mode, expected in (("routerai_at_cost", s.ROUTERAI_PROFILE), ("routerai_citygo_10x", s.CITYGO_10X_PROFILE)):
            self.assertEqual(self.installer.api_profile({"ROUTERAI_API_KEY": "synthetic-not-live", "AI_CREDIT_MODE": mode}, s), expected)
        for value in (None, [], {"AI_CREDIT_MODE": "routerai_citygo_10x"}, {"YOOKASSA_MODE": "test"},
                      {"ROUTERAI_API_KEY": "synthetic-not-live"},
                      {"ROUTERAI_API_KEY": "synthetic-not-live", "AI_CREDIT_MODE": []},
                      {"ROUTERAI_API_KEY": "synthetic-not-live", "AI_CREDIT_MODE": "disabled"},
                      {"ROUTERAI_API_KEY": "synthetic-not-live", "AI_CREDIT_MODE": "unknown"}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "ai-profile-mismatch"):
                self.installer.api_profile(value, s)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux enrollment permissions")
class EnrollmentFiles(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("citygo_install_fixture", Path(__file__).resolve().parents[1] / "install-autodeploy.py")
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)
        temporary = tempfile.TemporaryDirectory(prefix="citygo-enrollment-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_requested_modes_survive_private_umask(self):
        previous = os.umask(0o077)
        try:
            for mode in (0o600, 0o644, 0o440):
                path = self.directory / str(mode)
                self.installer.write_once(path, b"synthetic", mode)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
        finally:
            os.umask(previous)

    def test_same_root_owned_staging_can_be_resumed(self):
        path = self.directory / "staged"
        path.write_bytes(b"synthetic"); path.chmod(0o600)
        root_info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1)
        with patch.object(Path, "lstat", return_value=root_info):
            self.installer.write_once(path, b"synthetic", 0o644)
        self.assertEqual(path.read_bytes(), b"synthetic")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    def test_changed_bytes_owner_modes_or_links_are_not_overwritten(self):
        path = self.directory / "staged"
        path.write_bytes(b"original"); path.chmod(0o600)
        for owner, mode, links, data in ((0, 0o600, 1, b"changed"), (1000, 0o600, 1, b"original"),
                                         (0, 0o666, 1, b"original"), (0, 0o600, 2, b"original")):
            info = SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=owner, st_nlink=links)
            with self.subTest(owner=owner, mode=mode, links=links), patch.object(Path, "lstat", return_value=info):
                with self.assertRaisesRegex(RuntimeError, "staged-file-changed"):
                    self.installer.write_once(path, data, 0o644)
            self.assertEqual(path.read_bytes(), b"original")

    def test_symlink_is_never_followed(self):
        original = self.directory / "original"
        original.write_bytes(b"unchanged")
        link = self.directory / "link"
        link.symlink_to(original)
        with self.assertRaisesRegex(RuntimeError, "staged-file-changed"):
            self.installer.write_once(link, b"new", 0o644)
        self.assertEqual(original.read_bytes(), b"unchanged")


if __name__ == "__main__":
    unittest.main()
