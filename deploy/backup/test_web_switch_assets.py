"""Synthetic in-memory tar and disposable local filesystem tests; no Docker/network."""
import copy
import hashlib
import io
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import backup as b
import web_switch_assets as a


def manifest(files):
    return {path: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
            for path, data in files.items()}


def archive(files=(), *, entries=(), prefix=""):
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode="w", format=tarfile.USTAR_FORMAT) as stream:
        if prefix:
            entry = tarfile.TarInfo(prefix)
            entry.type = tarfile.DIRTYPE
            stream.addfile(entry)
        for path, data in dict(files).items():
            entry = tarfile.TarInfo(prefix + "/" + path if prefix else path)
            entry.size = len(data)
            stream.addfile(entry, io.BytesIO(data))
        for entry, data in entries:
            stream.addfile(entry, io.BytesIO(data) if data is not None else None)
    return target.getvalue()


class Manifest(unittest.TestCase):
    def test_digest_is_canonical_and_does_not_mutate_input(self):
        files = {"chunks/b.js": b"second", "chunks/a.js": b"first"}
        value = manifest(files)
        before = copy.deepcopy(value)
        reverse = dict(reversed(list(value.items())))
        self.assertEqual(a.digest_manifest(value), a.digest_manifest(reverse))
        self.assertEqual(value, before)
        self.assertNotEqual(a.digest_manifest(value), a.digest_manifest(manifest({"chunks/a.js": b"other"})))

    def test_closed_entry_schema_and_integer_size(self):
        good = manifest({"chunks/a.js": b"one"})
        for entry in ({"size": 3}, {**good["chunks/a.js"], "path": "another"},
                      {"sha256": "a" * 64, "size": True}, {"sha256": "A" * 64, "size": 3},
                      {"sha256": "a" * 64, "size": -1}):
            with self.subTest(entry=entry), self.assertRaises(b.BackupError):
                a.digest_manifest({"chunks/a.js": entry})

    def test_path_traversal_encoded_private_and_ambiguous_names_rejected(self):
        for path in ("../a.js", "/a.js", "chunks/../a.js", "chunks//a.js", "chunks/./a.js",
                     "chunks\\a.js", "a.js\n", ".env", "chunks/.secret", "chunks/%2e%2e/a.js",
                     "x?key.js", "x#hash.js", "\ud800", "a/" + "x" * 129):
            with self.subTest(path=repr(path)), self.assertRaises(b.BackupError):
                a.digest_manifest(manifest({path: b"x"}))

    def test_next_dynamic_paths_are_valid_but_file_directory_conflicts_are_not(self):
        self.assertTrue(a.digest_manifest(manifest({"chunks/app/[id]/(group)/page-a.js": b"x",
                                                  "build-id/_buildManifest.js": b"y"})))
        with self.assertRaisesRegex(b.BackupError, "assets-path-conflict"):
            a.digest_manifest(manifest({"chunks": b"x", "chunks/a.js": b"y"}))

    def test_bounded_manifest_file_count_file_size_and_total(self):
        with patch.object(a, "MAX_FILES", 1), self.assertRaises(b.BackupError):
            a.digest_manifest(manifest({"a.js": b"a", "b.js": b"b"}))
        with patch.object(a, "MAX_FILE_BYTES", 2), self.assertRaises(b.BackupError):
            a.digest_manifest(manifest({"a.js": b"abc"}))
        with patch.object(a, "MAX_TOTAL_BYTES", 1), self.assertRaises(b.BackupError):
            a.digest_manifest(manifest({"a.js": b"a", "b.js": b"b"}))


class Tar(unittest.TestCase):
    def test_exact_files_and_docker_cp_prefix(self):
        files = {"chunks/old.js": b"old", "css/new.css": b"new", "empty.js": b""}
        expected = manifest(files)
        self.assertEqual(a.read_tar_manifest(archive(files), expected), expected)
        self.assertEqual(a.read_tar_manifest(archive(files, prefix="static"), expected, prefix="static"), expected)
        self.assertEqual(a.read_tar_manifest(archive({"./chunks/old.js": b"old"})), manifest({"chunks/old.js": b"old"}))

    def test_hash_missing_and_unknown_members_rejected(self):
        data = archive({"a.js": b"a"})
        for expected in (manifest({"a.js": b"z"}), manifest({"b.js": b"a"}),
                         manifest({"a.js": b"a", "b.js": b"b"}), {}):
            with self.subTest(expected=expected), self.assertRaises(b.BackupError):
                a.read_tar_manifest(data, expected)

    def test_size_mismatch_rejected_before_reading_payload(self):
        with self.assertRaisesRegex(b.BackupError, "assets-tar-size"):
            a.read_tar_manifest(archive({"a.js": b"abc"}), manifest({"a.js": b"a"}))

    def test_duplicate_normalized_file_and_root_members_rejected(self):
        entry = tarfile.TarInfo("./a.js")
        entry.size = 1
        with self.assertRaisesRegex(b.BackupError, "assets-tar-duplicate"):
            a.read_tar_manifest(archive({"a.js": b"a"}, entries=[(entry, b"a")]))

    def test_symlink_hardlink_devices_and_fifos_never_extracted(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            entry = tarfile.TarInfo("a.js")
            entry.type = kind
            entry.linkname = "other.js" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
            with self.subTest(kind=kind), self.assertRaisesRegex(b.BackupError, "assets-tar-type"):
                a.read_tar_manifest(archive(entries=[(entry, None)]))

    def test_unknown_empty_directory_and_unsafe_directory_paths_rejected(self):
        for name in ("empty", "../outside", "chunks//", "static//"):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            with self.subTest(name=name), self.assertRaises(b.BackupError):
                a.read_tar_manifest(archive(entries=[(entry, None)]))

    def test_wrong_prefix_and_traversal_are_rejected(self):
        for name in ("../a.js", "/a.js", "static/../a.js", "static//a.js"):
            with self.subTest(name=name), self.assertRaises(b.BackupError):
                a.read_tar_manifest(archive({name: b"a"}), prefix="static")
        with self.assertRaisesRegex(b.BackupError, "assets-tar-prefix"):
            a.read_tar_manifest(archive({"a.js": b"a"}, prefix="other"), prefix="static")

    def test_pax_and_long_name_extensions_rejected(self):
        target = io.BytesIO()
        with tarfile.open(fileobj=target, mode="w", format=tarfile.PAX_FORMAT) as stream:
            entry = tarfile.TarInfo("a.js")
            entry.size = 1
            entry.pax_headers = {"comment": "unexpected metadata"}
            stream.addfile(entry, io.BytesIO(b"a"))
        with self.assertRaisesRegex(b.BackupError, "assets-tar-type"):
            a.read_tar_manifest(target.getvalue())
        target = io.BytesIO()
        with tarfile.open(fileobj=target, mode="w", format=tarfile.GNU_FORMAT) as stream:
            entry = tarfile.TarInfo("chunks/" + "a" * 110 + ".js")
            entry.size = 1
            stream.addfile(entry, io.BytesIO(b"a"))
        with self.assertRaisesRegex(b.BackupError, "assets-tar-type"):
            a.read_tar_manifest(target.getvalue())

    def test_compressed_truncated_and_nonzero_trailing_bytes_rejected(self):
        data = archive({"a.js": b"abc"})
        for bad in (b"not a tar", data[:-1], data[:1024], data + b"x" * 512):
            with self.subTest(size=len(bad)), self.assertRaises(b.BackupError):
                a.read_tar_manifest(bad)
        target = io.BytesIO()
        with tarfile.open(fileobj=target, mode="w:gz") as stream:
            stream.addfile(tarfile.TarInfo("a.js"), io.BytesIO(b""))
        with self.assertRaises(b.BackupError):
            a.read_tar_manifest(target.getvalue())

    def test_tar_file_total_and_input_bounds(self):
        data = archive({"a.js": b"abc"})
        with patch.object(a, "MAX_FILE_BYTES", 2), self.assertRaises(b.BackupError):
            a.read_tar_manifest(data)
        with patch.object(a, "MAX_TOTAL_BYTES", 2), self.assertRaises(b.BackupError):
            a.read_tar_manifest(data)
        with patch.object(a, "MAX_TAR_BYTES", len(data) - 1), self.assertRaises(b.BackupError):
            a.read_tar_manifest(data)


class PublicCompatibility(unittest.TestCase):
    def test_old_public_assets_and_generated_characters_preserved_additions_allowed(self):
        old = manifest({"figma/logo.png": b"logo", "characters/coordinator.png": b"generated"})
        target = {**old, **manifest({"characters/new.png": b"new"})}
        proof = a.verify_public_compatibility(old, target)
        self.assertEqual(proof["preserved"], 2)
        self.assertEqual(proof["added"], 1)
        self.assertEqual(proof["target_sha256"], a.digest_manifest(target))

    def test_public_change_or_deletion_blocks_switch(self):
        old = manifest({"characters/coordinator.png": b"old"})
        for target, code in (({}, "assets-public-deleted"),
                             (manifest({"characters/coordinator.png": b"new"}), "assets-public-changed")):
            with self.assertRaisesRegex(b.BackupError, code):
                a.verify_public_compatibility(old, target)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0,
                     "Linux root-owned dirfd/no-follow/flock publication")
class Filesystem(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-assets-fixture-")
        self.root = Path(self.temp.name) / "archive"
        self.root.mkdir(mode=0o755)
        self.old = {"chunks/old.js": b"old chunk", "css/shared.css": b"shared"}

    def tearDown(self):
        self.temp.cleanup()

    def publish(self, files, previous=None):
        return a.publish_static_archive(self.root, archive(files), manifest(files), previous_manifest=previous)

    def test_old_and_new_chunks_are_retained_and_same_content_reused(self):
        first = self.publish(self.old)
        second = self.publish({"chunks/new.js": b"new", "css/shared.css": b"shared"}, first["manifest"])
        self.assertEqual(second["added"], 1)
        self.assertEqual(second["reused"], 1)
        self.assertEqual(second["file_count"], 3)
        self.assertEqual((self.root / "chunks/old.js").read_bytes(), b"old chunk")
        self.assertEqual(a.verify_archive(self.root, second["manifest"])["manifest_sha256"], second["manifest_sha256"])
        for path in second["manifest"]:
            info = (self.root / path).lstat()
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(info.st_uid, 0)
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o444)

    def test_static_collision_rejected_before_any_addition(self):
        first = self.publish(self.old)
        with self.assertRaisesRegex(b.BackupError, "assets-static-collision"):
            self.publish({"chunks/old.js": b"changed", "chunks/new.js": b"new"}, first["manifest"])
        self.assertFalse((self.root / "chunks/new.js").exists())
        a.verify_archive(self.root, first["manifest"])

    def test_missing_wrong_hash_or_unknown_file_prevents_archive_proof(self):
        first = self.publish(self.old)
        path = self.root / "chunks/old.js"
        path.chmod(0o644)
        path.write_bytes(b"bad chunk")
        path.chmod(0o444)
        with self.assertRaisesRegex(b.BackupError, "assets-file-hash"):
            a.verify_archive(self.root, first["manifest"])
        path.unlink()
        with self.assertRaisesRegex(b.BackupError, "assets-archive-missing"):
            a.verify_archive(self.root, first["manifest"])
        (self.root / "unknown.js").write_bytes(b"unexpected")
        with self.assertRaisesRegex(b.BackupError, "assets-archive-unknown"):
            a.verify_archive(self.root, first["manifest"])

    def test_symlink_hardlink_and_writable_regular_file_are_rejected(self):
        first = self.publish({"a.js": b"one"})
        path = self.root / "a.js"
        path.chmod(0o644)
        with self.assertRaisesRegex(b.BackupError, "assets-file"):
            a.verify_archive(self.root, first["manifest"])
        path.chmod(0o444)
        outside = Path(self.temp.name) / "outside.js"
        os.link(path, outside)
        with self.assertRaisesRegex(b.BackupError, "assets-file"):
            a.verify_archive(self.root, first["manifest"])
        outside.unlink()
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaises(b.BackupError):
            a.verify_archive(self.root, first["manifest"])

    def test_symlink_root_or_directory_and_non_root_owner_rejected(self):
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(b.BackupError):
            a.verify_archive(alias, {})
        (self.root / "chunks").symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaises(b.BackupError):
            a.verify_archive(self.root, manifest({"chunks/a.js": b"a"}))
        (self.root / "chunks").unlink()
        os.chown(self.root, 65534, 65534)
        try:
            with self.assertRaisesRegex(b.BackupError, "assets-directory"):
                a.verify_archive(self.root, {})
        finally:
            os.chown(self.root, 0, 0)

    def test_unknown_empty_directory_and_group_writable_root_rejected(self):
        (self.root / "unknown").mkdir()
        with self.assertRaisesRegex(b.BackupError, "assets-archive-unknown"):
            a.verify_archive(self.root, {})
        (self.root / "unknown").rmdir()
        self.root.chmod(0o775)
        with self.assertRaisesRegex(b.BackupError, "assets-directory"):
            a.verify_archive(self.root, {})

    def test_wrong_expected_hash_does_not_write_any_file(self):
        with self.assertRaisesRegex(b.BackupError, "assets-tar-hash"):
            a.publish_static_archive(self.root, archive({"a.js": b"one"}), manifest({"a.js": b"two"}))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_atomic_link_never_replaces_existing_bytes_and_fsync_precedes_publication(self):
        events = []
        real_sync, real_link = os.fsync, os.link

        def sync(fd):
            events.append(("sync", stat.S_ISREG(os.fstat(fd).st_mode)))
            return real_sync(fd)

        def link(*args, **kwargs):
            events.append(("link", None))
            self.assertIn(("sync", True), events)
            return real_link(*args, **kwargs)

        with patch.object(a.os, "fsync", side_effect=sync), patch.object(a.os, "link", side_effect=link):
            first = self.publish({"a.js": b"one"})
        self.assertLess(events.index(("sync", True)), events.index(("link", None)))
        self.assertEqual(events[-1], ("sync", False))
        self.assertEqual([p.name for p in self.root.iterdir()], ["a.js"])
        self.assertEqual(self.publish({"a.js": b"one"}, first["manifest"])["added"], 0)

    def test_failed_publication_removes_only_own_temp_and_retains_previous_files(self):
        first = self.publish({"old.js": b"old"})
        with patch.object(a.os, "link", side_effect=OSError("synthetic link failure")), self.assertRaises(OSError):
            self.publish({"new.js": b"new"}, first["manifest"])
        self.assertEqual([p.name for p in self.root.iterdir()], ["old.js"])
        a.verify_archive(self.root, first["manifest"])

    def test_late_name_collision_never_replaces_or_deletes_destination(self):
        first = self.publish({"old.js": b"old"})
        real_link = os.link

        def race(source, target, **kwargs):
            # Simulate another privileged actor ignoring the archive lock.
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444,
                         dir_fd=kwargs["dst_dir_fd"])
            try:
                os.write(fd, b"independent bytes")
                os.fsync(fd)
            finally:
                os.close(fd)
            return real_link(source, target, **kwargs)

        with patch.object(a.os, "link", side_effect=race), self.assertRaisesRegex(b.BackupError, "assets-publish-conflict"):
            self.publish({"new.js": b"approved new"}, first["manifest"])
        self.assertEqual((self.root / "new.js").read_bytes(), b"independent bytes")
        self.assertEqual((self.root / "old.js").read_bytes(), b"old")
        self.assertFalse(any(p.name.startswith(".citygo") for p in self.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
