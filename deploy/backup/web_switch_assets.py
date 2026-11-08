"""Bounded, offline asset staging for an explicitly approved Web-only switch.

Manifests are exact ``relative/path -> {sha256, size}`` mappings. Static paths
are relative to /_next/static; public paths are relative to /. Docker/image
selection and protected, hash-pinned manifest reads belong to the controller.
This module never contacts Docker, runs commands, changes ingress or grants
release approval. An archive is append-only: no replacement and no GC.
"""
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tarfile

import backup as b

MAX_FILES = 20000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 192 * 1024 * 1024
MAX_TAR_BYTES = 256 * 1024 * 1024
MAX_PATH_BYTES = 1024
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_PART = re.compile(r"[A-Za-z0-9_@+\[\]()~-][A-Za-z0-9_.@+\[\]()~-]{0,127}\Z")


def _path(value):
    b.require(type(value) is str and 0 < len(value) <= MAX_PATH_BYTES,
              "assets-path")
    parts = value.split("/")
    b.require(len(parts) <= 24 and all(_PART.fullmatch(p) and p not in (".", "..")
                                     for p in parts), "assets-path")
    return value


def _manifest(value):
    b.require(type(value) is dict and len(value) <= MAX_FILES, "assets-manifest")
    result, total = {}, 0
    for path, entry in value.items():
        _path(path)
        b.require(type(entry) is dict and set(entry) == {"sha256", "size"}
                  and type(entry["sha256"]) is str and _HASH.fullmatch(entry["sha256"])
                  and type(entry["size"]) is int and 0 <= entry["size"] <= MAX_FILE_BYTES,
                  "assets-manifest")
        total += entry["size"]
        b.require(total <= MAX_TOTAL_BYTES, "assets-size")
        result[path] = {"sha256": entry["sha256"], "size": entry["size"]}
    b.require(not set(result).intersection(_parents(result)), "assets-path-conflict")
    return dict(sorted(result.items()))


def _parents(paths):
    return {"/".join(path.split("/")[:i]) for path in paths
            for i in range(1, len(path.split("/")))}


def digest_manifest(manifest):
    """Stable digest of the validated mapping, independent of insertion order."""
    raw = json.dumps(_manifest(manifest), sort_keys=True, separators=(",", ":"),
                     ensure_ascii=True).encode("ascii")
    return hashlib.sha256(raw).hexdigest()


def _tar(data, expected_manifest=None, *, prefix=""):
    b.require(type(data) is bytes and 1024 <= len(data) <= MAX_TAR_BYTES
              and len(data) % 512 == 0, "assets-tar-size")
    if prefix:
        _path(prefix)
    expected = None if expected_manifest is None else _manifest(expected_manifest)
    files, directories, seen, total, end = {}, set(), set(), 0, 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            for item in archive:
                # PAX/GNU extension records can hide extra paths/metadata. The
                # bounded ASCII path contract needs only ordinary ustar files.
                b.require(not item.pax_headers and item.offset_data == item.offset + 512
                          and item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
                          and not item.linkname, "assets-tar-type")
                name = item.name
                if name.startswith("./"):
                    name = name[2:]
                if item.isdir() and name.endswith("/"):
                    name = name[:-1]
                if name in ("", "."):
                    b.require(item.isdir() and not prefix, "assets-tar-root")
                    name = ""
                elif prefix:
                    b.require(name == prefix and item.isdir() or name.startswith(prefix + "/"),
                              "assets-tar-prefix")
                    name = "" if name == prefix else name[len(prefix) + 1:]
                if name:
                    _path(name)
                b.require(name not in seen and len(seen) < MAX_FILES * 2, "assets-tar-duplicate")
                seen.add(name)
                b.require(type(item.size) is int and 0 <= item.size <= MAX_FILE_BYTES,
                          "assets-tar-size")
                b.require(not item.isdir() or item.size == 0, "assets-tar-size")
                end = item.offset_data + ((item.size + 511) // 512) * 512
                b.require(end <= len(data), "assets-tar-size")
                if item.isdir():
                    if name:
                        directories.add(name)
                    continue
                b.require(name and len(files) < MAX_FILES, "assets-tar-size")
                total += item.size
                b.require(total <= MAX_TOTAL_BYTES, "assets-tar-size")
                if expected is not None:
                    b.require(name in expected, "assets-tar-unknown")
                    b.require(item.size == expected[name]["size"], "assets-tar-size")
                stream = archive.extractfile(item)
                b.require(stream is not None, "assets-tar-type")
                payload = stream.read(MAX_FILE_BYTES + 1)
                b.require(len(payload) == item.size, "assets-tar-size")
                entry = {"sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}
                if expected is not None:
                    b.require(entry == expected[name], "assets-tar-hash")
                files[name] = (entry, payload)
    except (tarfile.TarError, OSError, EOFError, ValueError, OverflowError):
        raise b.BackupError("assets-tar") from None
    # No concatenated archive, nonzero trailer, unexplained empty directory or
    # duplicate normalized path may accompany the reviewed file inventory.
    b.require(len(data) - end >= 1024 and not any(data[end:]), "assets-tar-trailer")
    manifest = _manifest({name: entry for name, (entry, _) in files.items()})
    b.require(directories <= _parents(manifest), "assets-tar-unknown")
    if expected is not None:
        b.require(manifest == expected, "assets-tar-missing")
    return manifest, {name: payload for name, (_, payload) in files.items()}


def read_tar_manifest(data, expected_manifest=None, *, prefix=""):
    """Read a bounded uncompressed tar without extracting it or trusting metadata.

    ``prefix='static'`` accepts an exact Docker-cp root directory. With the
    default prefix, names are already relative (one leading './' is accepted).
    Supply the approved exact manifest whenever the bytes are used for staging.
    """
    return _tar(data, expected_manifest, prefix=prefix)[0]


def verify_public_compatibility(previous, target):
    """Every old public URL must remain byte-identical; new URLs may be added.

    Include generated /characters files in BOTH image inventories. Public files
    are served by the selected image, not retained in the hashed static archive.
    """
    previous, target = _manifest(previous), _manifest(target)
    for path, entry in previous.items():
        b.require(path in target, "assets-public-deleted")
        b.require(target[path] == entry, "assets-public-changed")
    return {"version": 1, "kind": "citygo-web-public-compatibility-v1",
            "previous_sha256": digest_manifest(previous), "target_sha256": digest_manifest(target),
            "preserved": len(previous), "added": len(target) - len(previous)}


def _directory(info):
    b.require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
              "assets-directory")


@contextmanager
def _root(root, *, write=False):
    b.require(sys.platform.startswith("linux") and os.geteuid() == 0, "assets-root-required")
    path = Path(root)
    b.require(path.is_absolute() and ".." not in path.parts, "assets-root-path")
    info = path.lstat()
    _directory(info)
    for parent in path.parents:
        value = parent.lstat()
        b.require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0
                  and (not value.st_mode & 0o022 or bool(value.st_mode & stat.S_ISVTX)),
                  "assets-directory")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        _directory(current)
        b.require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), "assets-root-changed")
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
        yield path, fd
        after = path.lstat()
        b.require((after.st_dev, after.st_ino) == (current.st_dev, current.st_ino), "assets-root-changed")
        _directory(after)
    finally:
        os.close(fd)


def _file(fd, expected):
    before = os.fstat(fd)
    b.require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
              and not before.st_mode & 0o222 and before.st_size == expected["size"], "assets-file")
    digest, count = hashlib.sha256(), 0
    while True:
        block = os.read(fd, min(1024 * 1024, expected["size"] - count + 1))
        if not block:
            break
        count += len(block)
        b.require(count <= expected["size"], "assets-file-size")
        digest.update(block)
    after = os.fstat(fd)
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    b.require(all(getattr(before, key) == getattr(after, key) for key in fields), "assets-file-changed")
    b.require(count == expected["size"] and digest.hexdigest() == expected["sha256"], "assets-file-hash")


def _verify(fd, manifest):
    parents, observed = _parents(manifest), set()

    def walk(directory, prefix=""):
        for name in os.listdir(directory):
            path = prefix + name
            _path(path)
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                b.require(path in parents, "assets-archive-unknown")
                _directory(info)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    _directory(os.fstat(child))
                    walk(child, path + "/")
                finally:
                    os.close(child)
            else:
                b.require(path in manifest and stat.S_ISREG(info.st_mode), "assets-archive-unknown")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    _file(child, manifest[path])
                finally:
                    os.close(child)
                observed.add(path)

    walk(fd)
    b.require(observed == set(manifest), "assets-archive-missing")


def _proof(root, manifest):
    return {"version": 1, "kind": "citygo-web-static-archive-v1", "root": str(root),
            "manifest_sha256": digest_manifest(manifest), "file_count": len(manifest),
            "total_bytes": sum(entry["size"] for entry in manifest.values())}


def verify_archive(root, manifest):
    """Verify exact root-owned immutable files under a shared directory lock."""
    manifest = _manifest(manifest)
    with _root(root) as (path, fd):
        _verify(fd, manifest)
        return _proof(path, manifest)


@contextmanager
def _parent(root_fd, parts):
    fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, mode=0o755, dir_fd=fd)
                os.fsync(fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.fchmod(child, 0o755)
                os.fsync(child)
            _directory(os.fstat(child))
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _publish(parent, name, payload):
    temp = ".citygo-asset-tmp-" + secrets.token_hex(16)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent)
    identity = os.fstat(fd)
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(fd, payload[offset:offset + 1024 * 1024])
            b.require(written > 0, "assets-publish-write")
            offset += written
        os.fchmod(fd, 0o444)
        os.fsync(fd)
        # link() is an atomic no-replace publication. The private staging name
        # is immediately unlinked under the exclusive archive lock; the final
        # inode has one link before verification/proof or another writer enters.
        os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
    except FileExistsError:
        raise b.BackupError("assets-publish-conflict") from None
    finally:
        os.close(fd)
        current = os.stat(temp, dir_fd=parent, follow_symlinks=False)
        b.require((current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino),
                  "assets-publish-temp-changed")
        os.unlink(temp, dir_fd=parent)
        os.fsync(parent)


def publish_static_archive(root, data, expected_manifest, *, previous_manifest=None, prefix=""):
    """Append approved tar files, preserving the exact previous archive inventory.

    The existing root must be created by the operator. A caller stages both
    approved images in turn, carrying the returned ``manifest`` forward. All
    collisions/unsafe inputs are rejected before writes. Individual additions
    are crash-safe; an interrupted batch gets no success proof and requires
    explicit inventory review, never deletion/GC or replacement of old files.
    """
    incoming, files = _tar(data, expected_manifest, prefix=prefix)
    previous = _manifest({} if previous_manifest is None else previous_manifest)
    for name in set(incoming).intersection(previous):
        b.require(incoming[name] == previous[name], "assets-static-collision")
    merged = _manifest({**previous, **incoming})
    added = set(incoming) - set(previous)
    with _root(root, write=True) as (path, fd):
        _verify(fd, previous)
        for name in sorted(added):
            parts = name.split("/")
            with _parent(fd, parts[:-1]) as parent:
                _publish(parent, parts[-1], files[name])
        os.fsync(fd)
        _verify(fd, merged)
        return {**_proof(path, merged), "manifest": merged, "added": len(added),
                "reused": len(incoming) - len(added)}
