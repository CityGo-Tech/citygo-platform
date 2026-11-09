"""Root-only installation of an INACTIVE, hash-pinned controller directory.

No payload imports, subprocesses, runtime operations, active pointers or policy
changes. The caller must launch this trusted module from a protected root-owned
copy. A bootstrap draft is only an audit link; a separate private authorization
permits this finite filesystem transaction. Recovery never renews old approval.
"""
from contextlib import contextmanager
from functools import wraps
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


INSTALL_ROOT = Path("/opt/citygo")
STATE_ROOT = Path("/var/lib/citygo-web-controller-install")
COORDINATION_ROOT = Path("/var/lib/citygo-backup")
MODULES = ("backup.py", "web_switch.py", "web_switch_assets.py")
MAX_MODULE = 1024 * 1024
MAX_JSON = 16384
PAYLOAD_PURPOSE = "citygo-web-switch-controller-payload-v1"
INSTALL_PURPOSE = "citygo-web-switch-controller-install-v1"
RECONCILE_PURPOSE = "citygo-web-switch-controller-reconcile-v1"
PENDING_PURPOSE = "citygo-web-switch-controller-install-pending-v1"
HASH = r"[a-f0-9]{64}"
OPERATION = r"[a-f0-9]{32}"


class InstallError(Exception):
    """Fixed diagnostic codes; never input data, paths or engine output."""


def require(condition, code):
    if not condition:
        raise InstallError(code)


def _sanitized(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except OSError:
            raise InstallError("filesystem-error") from None
    return call


def matches(value, expression):
    return type(value) is str and re.fullmatch(expression, value) is not None


def keys(value, expected, code):
    require(type(value) is dict and set(value) == set(expected), code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def strict_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_JSON, "input-file")

    def pairs(items):
        result = {}
        for name, value in items:
            require(name not in result, "invalid-json")
            result[name] = value
        return result

    def constant(_):
        raise InstallError("invalid-json")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise InstallError("invalid-json") from None


def parse_manifest(raw):
    value = strict_json(raw)
    keys(value, ("version", "purpose", "files"), "manifest-shape")
    require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == PAYLOAD_PURPOSE,
            "manifest-shape")
    keys(value["files"], MODULES, "manifest-shape")
    for item in value["files"].values():
        keys(item, ("sha256", "size"), "manifest-shape")
        require(matches(item["sha256"], HASH) and type(item["size"]) is int and 0 < item["size"] <= MAX_MODULE,
                "manifest-shape")
    return value


def parse_authorization(raw, purpose, now=None):
    value = strict_json(raw)
    reconcile = purpose == RECONCILE_PURPOSE
    require(purpose in (INSTALL_PURPOSE, RECONCILE_PURPOSE), "approval-shape")
    keys(value, {"version", "purpose", "operation_id", "manifest_sha256", "bootstrap_draft_sha256", "approved_at", "expires_at",
                 "allow_reconcile" if reconcile else "allow_install"} | ({"pending_sha256"} if reconcile else set()), "approval-shape")
    require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == purpose
            and value["allow_reconcile" if reconcile else "allow_install"] is True
            and matches(value["operation_id"], OPERATION) and matches(value["manifest_sha256"], HASH)
            and matches(value["bootstrap_draft_sha256"], HASH), "approval-shape")
    require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
            and 0 < value["approved_at"] < value["expires_at"] <= value["approved_at"] + 3600, "approval-shape")
    if reconcile:
        require(matches(value["pending_sha256"], HASH), "approval-shape")
    if now is not None:
        require(type(now) is int and value["approved_at"] <= now < value["expires_at"], "approval-expired")
    return value


def _trusted(info, *, directory=False, private=False):
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & (0o077 if private else 0o022)
            and (directory or info.st_nlink == 1), "protected-path")


@contextmanager
def _directory(path, *, trusted=True, create=False, mode=0o755):
    path = Path(path).absolute()
    require(path.is_absolute() and ".." not in path.parts, "protected-path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.parts[1:]
        for index, name in enumerate(parts):
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                require(create and index == len(parts) - 1, "protected-path")
                os.mkdir(name, mode=mode, dir_fd=fd)
                os.fsync(fd)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            if trusted:
                info = os.fstat(fd)
                # An owned private child below sticky /tmp is safe for Linux
                # fixtures; the leaf directory itself never gets this exception.
                if index < len(parts) - 1 and info.st_uid == 0 and info.st_mode & stat.S_ISVTX:
                    require(stat.S_ISDIR(info.st_mode), "protected-path")
                else:
                    _trusted(info, directory=True)
        yield fd
        final = os.stat(path, follow_symlinks=False)
        current = os.fstat(fd)
        require((final.st_dev, final.st_ino) == (current.st_dev, current.st_ino), "input-raced")
        if trusted:
            _trusted(current, directory=True)
    finally:
        os.close(fd)


def _exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def _read_at(fd, name, limit, *, trusted=False, private=False, mode=None, links=1):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        before = os.fstat(child)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == links and 0 <= before.st_size <= limit, "input-file")
        if trusted:
            require(before.st_uid == 0 and before.st_gid == 0 and not before.st_mode & (0o077 if private else 0o022), "protected-path")
        if mode is not None:
            require(stat.S_IMODE(before.st_mode) == mode, "protected-path")
        data = bytearray()
        while len(data) <= limit:
            block = os.read(child, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(child)
        final = os.stat(name, dir_fd=fd, follow_symlinks=False)
        fields = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_gid", "st_nlink", "st_mtime_ns", "st_ctime_ns")
        require(all(getattr(before, key) == getattr(item, key) for item in (after, final) for key in fields)
                and len(data) == before.st_size <= limit, "input-raced")
        return bytes(data), before
    finally:
        os.close(child)


def _read_path(path, *, private=False):
    path = Path(path).absolute()
    with _directory(path.parent) as parent:
        return _read_at(parent, path.name, MAX_JSON, trusted=True, private=private,
                        mode=0o600 if private else None)[0]


def _platform():
    require(sys.platform.startswith("linux") and os.geteuid() == 0 and os.getegid() == 0, "root-linux-required")
    path = Path(__file__).absolute()
    with _directory(path.parent) as parent:
        _read_at(parent, path.name, MAX_MODULE, trusted=True)


@contextmanager
def _lock(fd, name, *, create):
    if not create and not _exists(fd, name):
        yield
        return
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT if create else 0)
    child = os.open(name, flags, 0o600, dir_fd=fd)
    try:
        _trusted(os.fstat(child), private=True)
        import fcntl
        try:
            fcntl.flock(child, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("install-already-running") from None
        yield
    finally:
        os.close(child)


@contextmanager
def _locked(*, create, readonly=False):
    with _directory(COORDINATION_ROOT) as coordination:
        with _lock(coordination, "maintenance.lock", create=not readonly), _lock(coordination, "worker-admission.lock", create=not readonly):
            for name in ("operation-pending.json", "worker-pending.json", "pending.json"):
                require(not _exists(coordination, name), "legacy-operation-pending")
            with _directory(STATE_ROOT, create=create, mode=0o700) as state:
                require(not os.fstat(state).st_mode & 0o077, "protected-path")
                with _lock(state, "install.lock", create=not readonly):
                    yield state, coordination


def target_directory(manifest_sha256):
    require(matches(manifest_sha256, HASH), "manifest-hash")
    return INSTALL_ROOT / ("web-switch-controller-" + manifest_sha256)


def _package(source_dir):
    with _directory(source_dir) as source:
        require(set(os.listdir(source)) == {*MODULES, "manifest.json"}, "manifest-shape")
        raw, _ = _read_at(source, "manifest.json", MAX_JSON, trusted=True)
        manifest = parse_manifest(raw)
        files = {"manifest.json": raw}
        for name in MODULES:
            content, _ = _read_at(source, name, MAX_MODULE, trusted=True)
            expected = manifest["files"][name]
            require(len(content) == expected["size"] and digest(content) == expected["sha256"], "payload-file")
            files[name] = content
        return manifest, files


def _emit(callback, name):
    if callback is not None:
        callback(name)  # Private in-process test seam, never read from JSON/env.


def _create_record(fd, name, raw, mode=0o400):
    child = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        os.fchmod(child, 0o600)
        offset = 0
        while offset < len(raw):
            written = os.write(child, raw[offset:])
            require(written > 0, "install-write")
            offset += written
        os.fchmod(child, mode)
        os.fsync(child)
    finally:
        os.close(child)
    os.fsync(fd)


def _pending(state):
    raw, _ = _read_at(state, "pending.json", MAX_JSON, trusted=True, private=True, mode=0o600)
    value = strict_json(raw)
    keys(value, ("version", "purpose", "operation_id", "manifest_sha256", "bootstrap_draft_sha256", "manifest",
                 "original_approval_sha256", "original_approval_file"), "install-drift")
    require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == PENDING_PURPOSE
            and matches(value["operation_id"], OPERATION) and matches(value["manifest_sha256"], HASH)
            and matches(value["bootstrap_draft_sha256"], HASH) and matches(value["original_approval_sha256"], HASH)
            and value["original_approval_file"] == "approval-" + value["operation_id"] + ".json", "install-drift")
    audit, _ = _read_at(state, value["original_approval_file"], MAX_JSON, trusted=True, private=True, mode=0o400)
    require(digest(audit) == value["original_approval_sha256"], "install-drift")
    approval = parse_authorization(audit, INSTALL_PURPOSE)
    require(all(approval[name] == value[name] for name in ("operation_id", "manifest_sha256", "bootstrap_draft_sha256")), "install-drift")
    # Re-validate embedded metadata without interpreting it as Python or paths.
    parse_manifest(wire(value["manifest"]))
    historical, _ = _read_at(state, "transaction-" + value["operation_id"] + ".json", MAX_JSON,
                              trusted=True, private=True, mode=0o400)
    require(historical == raw, "install-drift")
    return value, raw


def _transaction_body(identities, manifest, original_approval_sha256):
    return {"version": 1, "purpose": PENDING_PURPOSE, "operation_id": identities["operation_id"],
            "manifest_sha256": identities["manifest_sha256"], "bootstrap_draft_sha256": identities["bootstrap_draft_sha256"],
            "manifest": manifest, "original_approval_sha256": original_approval_sha256,
            "original_approval_file": "approval-" + identities["operation_id"] + ".json"}


def _reconcile_audit(state, receipt, pending_sha256):
    audit_hash = receipt["reconcile_approval_sha256"]
    if audit_hash is None:
        return
    raw, _ = _read_at(state, "reconcile-" + audit_hash + ".json", MAX_JSON, trusted=True, private=True, mode=0o400)
    require(digest(raw) == audit_hash, "receipt-changed")
    approval = parse_authorization(raw, RECONCILE_PURPOSE)
    require(approval["pending_sha256"] == pending_sha256
            and all(approval[key] == receipt[key] for key in ("operation_id", "manifest_sha256", "bootstrap_draft_sha256")),
            "receipt-changed")


def _temp(pending, name):
    return ".install-" + pending["operation_id"] + "-" + name + ".tmp"


def _final(fd, name, raw, pending, *, cleanup=False):
    temp = _temp(pending, name)
    linked = _exists(fd, temp)
    data, info = _read_at(fd, name, max(len(raw), 1), trusted=True, mode=0o444,
                          links=2 if linked else 1)
    require(data == raw, "install-drift")
    if linked:
        other = os.stat(temp, dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISREG(other.st_mode) and other.st_uid == 0 and other.st_nlink == 2
                and (other.st_dev, other.st_ino) == (info.st_dev, info.st_ino), "install-drift")
        if cleanup:
            os.unlink(temp, dir_fd=fd)
            os.fsync(fd)
    return info


def _publish(fd, name, raw, pending, callback):
    temp = _temp(pending, name)
    if _exists(fd, name):
        _final(fd, name, raw, pending, cleanup=True)
        return
    if _exists(fd, temp):
        old, info = _read_at(fd, temp, max(len(raw), 1), trusted=True)
        require(info.st_nlink == 1 and stat.S_IMODE(info.st_mode) in (0o600, 0o444), "install-drift")
        require(old == raw if stat.S_IMODE(info.st_mode) == 0o444 else raw.startswith(old), "install-drift")
        if stat.S_IMODE(info.st_mode) != 0o444:
            # Only this transaction's explicitly named private temporary inode
            # is repairable. Final files are never replaced or truncated.
            current = os.stat(temp, dir_fd=fd, follow_symlinks=False)
            require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), "input-raced")
            os.unlink(temp, dir_fd=fd)
            os.fsync(fd)
    if not _exists(fd, temp):
        child = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            os.fchmod(child, 0o600)
            _emit(callback, "temp-created:" + name)
            offset = 0
            while offset < len(raw):
                count = os.write(child, raw[offset:offset + 65536])
                require(count > 0, "install-write")
                offset += count
            os.fchmod(child, 0o444)
            os.fsync(child)
            _emit(callback, "temp-written:" + name)
        finally:
            os.close(child)
    try:
        os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    except FileExistsError:
        raise InstallError("install-drift") from None
    os.fsync(fd)
    _emit(callback, "file-linked:" + name)
    _final(fd, name, raw, pending, cleanup=True)
    _emit(callback, "file-published:" + name)


def _allowed_names(fd, pending):
    fixed = {*MODULES, "manifest.json", "installed.json"}
    require(set(os.listdir(fd)) <= fixed | {_temp(pending, name) for name in fixed}, "install-drift")


def _receipt(pending, reconcile_hash):
    return {"version": 1, "status": "installed-inactive", "operation_id": pending["operation_id"],
            "manifest_sha256": pending["manifest_sha256"], "bootstrap_draft_sha256": pending["bootstrap_draft_sha256"],
            "original_approval_sha256": pending["original_approval_sha256"], "reconcile_approval_sha256": reconcile_hash,
            "activation_authorized": False, "runtime_changed": False}


def _read_receipt(fd, pending, *, cleanup=False):
    raw, _ = _read_at(fd, "installed.json", MAX_JSON, trusted=True, mode=0o444,
                      links=2 if _exists(fd, _temp(pending, "installed.json")) else 1)
    value = strict_json(raw)
    expected = _receipt(pending, value.get("reconcile_approval_sha256") if type(value) is dict else None)
    require(value == expected and type(value.get("version")) is int
            and value.get("activation_authorized") is False and value.get("runtime_changed") is False
            and matches(value.get("operation_id"), OPERATION) and matches(value.get("manifest_sha256"), HASH)
            and matches(value.get("bootstrap_draft_sha256"), HASH) and matches(value.get("original_approval_sha256"), HASH)
            and (value["reconcile_approval_sha256"] is None or matches(value["reconcile_approval_sha256"], HASH)),
            "receipt-changed")
    _final(fd, "installed.json", raw, pending, cleanup=cleanup)
    return value, raw


def _verify(fd, files, pending, *, cleanup=False):
    _trusted(os.fstat(fd), directory=True)
    _allowed_names(fd, pending)
    for name, raw in files.items():
        _final(fd, name, raw, pending, cleanup=cleanup)


def _result(receipt, pending=False):
    return {**receipt, "pending": pending, "directory": str(target_directory(receipt["manifest_sha256"]))}


def _finish(state, parent, coordination, pending, pending_raw, files, reconcile_hash, callback, guard):
    guard()
    name = target_directory(pending["manifest_sha256"]).name
    created = not _exists(parent, name)
    if created:
        os.mkdir(name, 0o755, dir_fd=parent)
        os.fsync(parent)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        _trusted(os.fstat(fd), directory=True)
        require(stat.S_IMODE(os.fstat(fd).st_mode) in (0o700, 0o755), "install-drift")
        os.fchmod(fd, 0o755)
        os.fsync(fd)
        if created:
            _emit(callback, "directory-created")
        _allowed_names(fd, pending)
        for filename in (*MODULES, "manifest.json"):
            guard()
            _publish(fd, filename, files[filename], pending, callback)
        _verify(fd, files, pending, cleanup=True)
        os.fsync(fd)
        _emit(callback, "tree-verified")
        guard()
        if _exists(fd, "installed.json"):
            receipt, _ = _read_receipt(fd, pending, cleanup=True)
        else:
            receipt = _receipt(pending, reconcile_hash)
            _publish(fd, "installed.json", wire(receipt), pending, callback)
        _verify(fd, files, pending)
        _read_receipt(fd, pending)
        _reconcile_audit(state, receipt, digest(pending_raw))
        require(set(os.listdir(fd)) == {*files, "installed.json"}, "install-drift")
        os.fsync(fd)
        os.fsync(parent)
        _emit(callback, "receipt-durable")
        current_target = os.stat(name, dir_fd=parent, follow_symlinks=False)
        held_target = os.fstat(fd)
        require((current_target.st_dev, current_target.st_ino) == (held_target.st_dev, held_target.st_ino)
                and stat.S_ISDIR(current_target.st_mode), "input-raced")
        # Reopen all root components before removing the transaction barrier;
        # a held FD alone does not prove that the returned pathname still binds.
        for path, held in ((INSTALL_ROOT, parent), (STATE_ROOT, state), (COORDINATION_ROOT, coordination)):
            with _directory(path) as current_fd:
                meta, expected = os.fstat(current_fd), os.fstat(held)
                require((meta.st_dev, meta.st_ino) == (expected.st_dev, expected.st_ino), "input-raced")
        current, _ = _pending(state)
        require(current == pending and digest(pending_raw) == digest(_read_at(state, "pending.json", MAX_JSON, trusted=True, private=True)[0]),
                "install-drift")
        guard()
        os.unlink("pending.json", dir_fd=state)
        os.fsync(state)
        _emit(callback, "pending-cleared")
        return _result(receipt)
    finally:
        os.close(fd)


def _installed(state, parent, manifest_hash, files=None):
    name = target_directory(manifest_hash).name
    if not _exists(parent, name):
        return None
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        _trusted(os.fstat(fd), directory=True)
        raw, _ = _read_at(fd, "manifest.json", MAX_JSON, trusted=True, mode=0o444)
        require(digest(raw) == manifest_hash, "install-not-owned")
        manifest = parse_manifest(raw)
        receipt_raw, _ = _read_at(fd, "installed.json", MAX_JSON, trusted=True, mode=0o444)
        receipt = strict_json(receipt_raw)
        require(type(receipt) is dict and matches(receipt.get("operation_id"), OPERATION)
                and receipt.get("manifest_sha256") == manifest_hash, "receipt-changed")
        pending = {**receipt, "original_approval_file": "approval-" + receipt["operation_id"] + ".json"}
        _read_receipt(fd, pending)
        audit, _ = _read_at(state, pending["original_approval_file"], MAX_JSON, trusted=True, private=True, mode=0o400)
        require(digest(audit) == receipt["original_approval_sha256"], "receipt-changed")
        approved = parse_authorization(audit, INSTALL_PURPOSE)
        require(all(approved[key] == receipt[key] for key in ("operation_id", "manifest_sha256", "bootstrap_draft_sha256")), "receipt-changed")
        historical, _ = _read_at(state, "transaction-" + receipt["operation_id"] + ".json", MAX_JSON,
                                  trusted=True, private=True, mode=0o400)
        require(historical == wire(_transaction_body(receipt, manifest, receipt["original_approval_sha256"])), "receipt-changed")
        _reconcile_audit(state, receipt, digest(historical))
        expected = {"manifest.json": raw}
        for module in MODULES:
            data, _ = _read_at(fd, module, MAX_MODULE, trusted=True, mode=0o444)
            require(len(data) == manifest["files"][module]["size"] and digest(data) == manifest["files"][module]["sha256"], "install-drift")
            expected[module] = data
        require(files is None or files == expected, "install-drift")
        require(set(os.listdir(fd)) == {*MODULES, "manifest.json", "installed.json"}, "install-drift")
        return _result(receipt)
    finally:
        os.close(fd)


@_sanitized
def install_package(source_dir, approval_path, *, allow_install=False, now=None, _checkpoint=None):
    require(allow_install is True, "explicit-install-required")
    _platform()
    approval_raw = _read_path(approval_path, private=True)
    approval = parse_authorization(approval_raw, INSTALL_PURPOSE, int(time.time()) if now is None else now)
    manifest, files = _package(source_dir)
    require(digest(files["manifest.json"]) == approval["manifest_sha256"], "approval-binding")

    def guard():
        require(_read_path(approval_path, private=True) == approval_raw, "approval-binding")
        parse_authorization(approval_raw, INSTALL_PURPOSE, int(time.time()) if now is None else now)

    with _locked(create=True) as (state, coordination), _directory(INSTALL_ROOT) as parent:
        guard()
        require(not _exists(state, "pending.json"), "install-pending")
        if _exists(parent, target_directory(approval["manifest_sha256"]).name):
            result = _installed(state, parent, approval["manifest_sha256"], files)
            require(result["operation_id"] == approval["operation_id"]
                    and result["bootstrap_draft_sha256"] == approval["bootstrap_draft_sha256"], "approval-binding")
            return result
        audit_name = "approval-" + approval["operation_id"] + ".json"
        if _exists(state, audit_name):
            require(_read_at(state, audit_name, MAX_JSON, trusted=True, private=True, mode=0o400)[0] == approval_raw,
                    "approval-binding")
        else:
            _create_record(state, audit_name, approval_raw)
        pending = _transaction_body(approval, manifest, digest(approval_raw))
        pending_raw = wire(pending)
        history_name = "transaction-" + approval["operation_id"] + ".json"
        if _exists(state, history_name):
            require(_read_at(state, history_name, MAX_JSON, trusted=True, private=True, mode=0o400)[0] == pending_raw,
                    "approval-binding")
        else:
            _create_record(state, history_name, pending_raw)
        _create_record(state, "pending.json", pending_raw, 0o600)
        _emit(_checkpoint, "pending-durable")
        return _finish(state, parent, coordination, pending, pending_raw, files, None, _checkpoint, guard)


@_sanitized
def reconcile_package(source_dir, approval_path, *, allow_reconcile=False, now=None, _checkpoint=None):
    require(allow_reconcile is True, "explicit-reconcile-required")
    _platform()
    approval_raw = _read_path(approval_path, private=True)
    approval = parse_authorization(approval_raw, RECONCILE_PURPOSE, int(time.time()) if now is None else now)
    manifest, files = _package(source_dir)

    def guard():
        require(_read_path(approval_path, private=True) == approval_raw, "approval-binding")
        parse_authorization(approval_raw, RECONCILE_PURPOSE, int(time.time()) if now is None else now)

    with _locked(create=False) as (state, coordination), _directory(INSTALL_ROOT) as parent:
        guard()
        require(_exists(state, "pending.json"), "install-pending")
        pending, raw = _pending(state)
        require(digest(raw) == approval["pending_sha256"] and manifest == pending["manifest"]
                and digest(files["manifest.json"]) == pending["manifest_sha256"]
                and all(approval[name] == pending[name] for name in ("operation_id", "manifest_sha256", "bootstrap_draft_sha256")), "approval-binding")
        approval_hash = digest(approval_raw)
        audit_name = "reconcile-" + approval_hash + ".json"
        if _exists(state, audit_name):
            require(_read_at(state, audit_name, MAX_JSON, trusted=True, private=True, mode=0o400)[0] == approval_raw,
                    "approval-binding")
        else:
            _create_record(state, audit_name, approval_raw)
        return _finish(state, parent, coordination, pending, raw, files, approval_hash, _checkpoint, guard)


@_sanitized
def inspect_install(manifest_sha256=None):
    _platform()
    if manifest_sha256 is not None:
        target_directory(manifest_sha256)
    # No state/lock creation on inspect, including before the first installation.
    if not os.path.lexists(STATE_ROOT):
        return {"status": "not-installed" if manifest_sha256 else "idle", "pending": False,
                "activation_authorized": False, "runtime_changed": False}
    with _locked(create=False, readonly=True) as (state, _coordination), _directory(INSTALL_ROOT) as parent:
        if not _exists(state, "pending.json"):
            if manifest_sha256 is not None:
                result = _installed(state, parent, manifest_sha256)
                if result is not None:
                    return result
            return {"status": "not-installed" if manifest_sha256 else "idle", "pending": False,
                    "activation_authorized": False, "runtime_changed": False}
        pending, raw = _pending(state)
        require(manifest_sha256 is None or manifest_sha256 == pending["manifest_sha256"], "approval-binding")
        phase = "incomplete"
        name = target_directory(pending["manifest_sha256"]).name
        if _exists(parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                try:
                    _trusted(os.fstat(fd), directory=True)
                    _allowed_names(fd, pending)
                    files = {}
                    for filename, item in pending["manifest"]["files"].items():
                        if not _exists(fd, filename):
                            break
                        data, _ = _read_at(fd, filename, MAX_MODULE, trusted=True, mode=0o444,
                                          links=2 if _exists(fd, _temp(pending, filename)) else 1)
                        require(len(data) == item["size"] and digest(data) == item["sha256"], "install-drift")
                        files[filename] = data
                    if len(files) == len(MODULES) and _exists(fd, "manifest.json"):
                        manifest_raw, _ = _read_at(fd, "manifest.json", MAX_JSON, trusted=True, mode=0o444,
                                                  links=2 if _exists(fd, _temp(pending, "manifest.json")) else 1)
                        require(digest(manifest_raw) == pending["manifest_sha256"], "install-drift")
                        files["manifest.json"] = manifest_raw
                        _verify(fd, files, pending)
                        phase = "complete"
                        if _exists(fd, "installed.json"):
                            receipt, _ = _read_receipt(fd, pending)
                            _reconcile_audit(state, receipt, digest(raw))
                            phase = "committed"
                except (OSError, InstallError):
                    phase = "drift"
            finally:
                os.close(fd)
        return {"status": "pending", "pending": True, "phase": phase, "operation_id": pending["operation_id"],
                "manifest_sha256": pending["manifest_sha256"], "bootstrap_draft_sha256": pending["bootstrap_draft_sha256"],
                "pending_sha256": digest(raw), "directory": str(target_directory(pending["manifest_sha256"])),
                "original_approval_sha256": pending["original_approval_sha256"], "activation_authorized": False, "runtime_changed": False}
