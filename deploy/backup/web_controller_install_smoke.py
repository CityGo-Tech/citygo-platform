#!/usr/bin/env python3
"""Real SIGKILL rehearsal of the INACTIVE installer on private Linux fixtures.

Default/--plan are inert. --disposable requires Linux root and a protected
TMPDIR (for example /root in an isolated runner). The installer itself is copied
unchanged into that tree before import. Its three fixed roots are patched only
inside this private harness; no CLI/environment root override is exposed.
Installed controller payloads are actual source bytes and are never imported.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time


SOURCE_NAMES = ("backup.py", "web_switch.py", "web_switch_assets.py")
INSTALLER_NAME = "web_controller_install.py"
CHECKPOINTS = ("pending-durable", "directory-created", "temp-created:backup.py", "temp-written:backup.py",
               "file-linked:backup.py", "tree-verified", "receipt-durable", "pending-cleared")
MAX_SOURCE = 2 * 1024 * 1024
WAIT_SECONDS = 30
CHILD = r'''
import importlib.util, json, os, signal, sys
from pathlib import Path
source, roots, payload, approval, wanted, now = sys.argv[1:]
spec = importlib.util.spec_from_file_location("private_installer_child", source)
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)
base = Path(roots)
installer.INSTALL_ROOT = base / "install"
installer.STATE_ROOT = base / "state"
installer.COORDINATION_ROOT = base / "coordination"
def checkpoint(name):
    if name == wanted:
        os.write(1, (json.dumps({"checkpoint": name}, separators=(",", ":")) + "\n").encode())
        while True:
            signal.pause()
installer.install_package(Path(payload), Path(approval), allow_install=True,
                          now=int(now), _checkpoint=checkpoint)
raise SystemExit(91)
'''


class SmokeError(Exception):
    """Fixed diagnostics only; no original paths, manifests or child stderr."""


def require(condition, code):
    if not condition:
        raise SmokeError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def private_write(path, raw, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, mode)


def protected(path):
    path = Path(path).absolute()
    for current in (path, *path.parents):
        item = current.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and item.st_gid == 0
                and item.st_mode & 0o022 == 0, "smoke-unprotected-root")
    return path


def source_bytes(path):
    """Read only a finite, fixed source inventory, rejecting links and races."""
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 < before.st_size <= MAX_SOURCE, "smoke-source-file")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), "smoke-source-race")
        raw = stream.read(MAX_SOURCE + 1)
        after = os.fstat(stream.fileno())
    final = path.lstat()
    expected = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    require(all((item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns) == expected
                for item in (opened, after, final)) and len(raw) == before.st_size, "smoke-source-race")
    return raw


def trusted_installer(path, roots):
    require(protected(path.parent) == path.parent.absolute(), "smoke-installer-root")
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_uid == 0
            and meta.st_gid == 0 and stat.S_IMODE(meta.st_mode) == 0o644, "smoke-installer-copy")
    spec = importlib.util.spec_from_file_location("private_installer_parent", path)
    installer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = installer
    spec.loader.exec_module(installer)
    installer.INSTALL_ROOT = roots / "install"
    installer.STATE_ROOT = roots / "state"
    installer.COORDINATION_ROOT = roots / "coordination"
    return installer


def guards(directory):
    directory.mkdir(mode=0o700)
    files = {
        "canonical.json": {"image": "unchanged", "apiCount": 1, "databaseSchema": 50},
        "config.json": {"profile": "postpay-native-search-v1", "secretReference": "synthetic-only"},
        "runtime.json": {"aiModes": 3, "markup": 10, "minimumRub": 3, "postpay": True,
                         "receipts": True, "phone": True, "giftRub": 500},
        "legacy-receipt.json": {"status": "historical", "containerId": "a" * 64},
        "budgets.json": {"limit": 321, "spent": 123, "counter": 17},
        "nginx.conf": {"enabled": "old-target", "reloads": 0},
    }
    for name, value in files.items():
        private_write(directory / name, wire(value))
    (directory / "nginx-enabled").symlink_to("nginx.conf")
    return guard_snapshot(directory)


def guard_snapshot(directory):
    result = {}
    for path in sorted(directory.iterdir()):
        meta = path.lstat()
        require(stat.S_ISREG(meta.st_mode) or stat.S_ISLNK(meta.st_mode), "smoke-guard-kind")
        value = {"mode": stat.S_IMODE(meta.st_mode), "uid": meta.st_uid, "gid": meta.st_gid,
                 "inode": meta.st_ino, "mtime_ns": meta.st_mtime_ns, "links": meta.st_nlink}
        if stat.S_ISLNK(meta.st_mode):
            value["link"] = os.readlink(path)
        else:
            value["sha256"] = digest(source_bytes(path))
        result[path.name] = value
    return result


def child_environment(directory):
    return {"PATH": "/usr/bin:/bin", "HOME": str(directory), "TMPDIR": str(directory),
            "LANG": "C", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}


def install_snapshot(root):
    """Bounded read-only snapshot including empty locks; access time excluded."""
    result = {}
    count = 0

    def visit(path, name, depth):
        nonlocal count
        count += 1
        require(count <= 64 and depth <= 4, "smoke-install-inventory")
        meta = path.lstat()
        require(meta.st_uid == 0 and meta.st_gid == 0 and not stat.S_ISLNK(meta.st_mode), "smoke-install-inventory")
        value = {"mode": stat.S_IMODE(meta.st_mode), "uid": meta.st_uid, "gid": meta.st_gid,
                 "inode": meta.st_ino, "mtime_ns": meta.st_mtime_ns, "ctime_ns": meta.st_ctime_ns,
                 "links": meta.st_nlink}
        if stat.S_ISREG(meta.st_mode):
            require(meta.st_nlink == 1 and meta.st_size <= MAX_SOURCE, "smoke-install-inventory")
            value["sha256"] = digest(path.read_bytes())
        else:
            require(stat.S_ISDIR(meta.st_mode), "smoke-install-inventory")
            for child in sorted(path.iterdir()):
                visit(child, name + "/" + child.name, depth + 1)
        result[name] = value

    for name in ("install", "state", "coordination"):
        visit(root / name, name, 0)
    return result


def kill_at_checkpoint(installer_path, roots, payload, approval, checkpoint, now):
    """The only signal target is this function's own unreaped Popen child."""
    command = [sys.executable, "-I", "-B", "-c", CHILD, str(installer_path), str(roots), str(payload),
               str(approval), checkpoint, str(now)]
    errors = roots / "child-stderr.log"
    child = None
    with errors.open("xb", buffering=0) as stderr:
        try:
            child = subprocess.Popen(command, cwd=roots, env=child_environment(roots),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr,
                                     shell=False, close_fds=True, start_new_session=True)
            observed = b""
            deadline = time.monotonic() + WAIT_SECONDS
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while b"\n" not in observed and time.monotonic() < deadline:
                    for key, _ in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                        chunk = os.read(key.fileobj.fileno(), 512)
                        require(chunk != b"", "smoke-checkpoint-child-exit")
                        observed += chunk
                        require(len(observed) <= 512, "smoke-checkpoint-output")
                    require(child.poll() is None, "smoke-checkpoint-child-exit")
            require(observed == wire({"checkpoint": checkpoint}), "smoke-checkpoint-not-reached")
            child.kill()
            require(child.wait(timeout=5) == -signal.SIGKILL, "smoke-child-not-sigkill")
            require(errors.stat().st_size == 0, "smoke-child-stderr")
            return {"checkpoint": checkpoint, "signal": "SIGKILL", "exitCode": -signal.SIGKILL,
                    "ownedChildOnly": True}
        finally:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                try:
                    child.wait(timeout=5)
                finally:
                    child.stdout.close()


def approval(operation, manifest_sha, now):
    return {"version": 1, "purpose": "citygo-web-switch-controller-install-v1",
            "operation_id": operation, "manifest_sha256": manifest_sha,
            "bootstrap_draft_sha256": "c" * 64, "approved_at": now, "expires_at": now + 600,
            "allow_install": True}


def verify_tree(destination, payload):
    meta = destination.lstat()
    require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == 0
            and stat.S_IMODE(meta.st_mode) == 0o755, "smoke-installed-directory")
    expected = {*SOURCE_NAMES, "manifest.json", "installed.json"}
    require({path.name for path in destination.iterdir()} == expected, "smoke-installed-inventory")
    for path in destination.iterdir():
        item = path.lstat()
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_gid == 0
                and item.st_nlink == 1 and stat.S_IMODE(item.st_mode) == 0o444, "smoke-installed-file")
        if path.name in payload:
            require(source_bytes(path) == payload[path.name], "smoke-installed-bytes")
    return json.loads(source_bytes(destination / "installed.json"))


def verify_crash_state(root, checkpoint, operation, manifest_sha, payload):
    destination = root / "install" / ("web-switch-controller-" + manifest_sha)
    pending = root / "state" / "pending.json"
    require(pending.exists() == (checkpoint != "pending-cleared"), "smoke-crash-pending")
    if checkpoint == "pending-durable":
        require(not destination.exists(), "smoke-crash-directory")
        return {"versionDirectoryExists": False, "pendingExists": True}
    require(destination.is_dir() and not destination.is_symlink(), "smoke-crash-directory")
    names = {path.name for path in destination.iterdir()}
    if checkpoint == "directory-created":
        require(names == set(), "smoke-crash-directory-not-empty")
        return {"versionDirectoryExists": True, "versionDirectoryEmpty": True}
    temp = destination / (".install-" + operation + "-backup.py.tmp")
    if checkpoint in {"temp-created:backup.py", "temp-written:backup.py", "file-linked:backup.py"}:
        meta = temp.lstat()
        require(stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == 0,
                "smoke-crash-temp")
        if checkpoint == "temp-created:backup.py":
            require(names == {temp.name} and meta.st_nlink == 1 and meta.st_size == 0
                    and stat.S_IMODE(meta.st_mode) == 0o600, "smoke-crash-empty-temp")
            return {"temporarySize": 0, "temporaryLinks": 1, "temporaryMode": "0600"}
        require(temp.read_bytes() == payload["backup.py"] and stat.S_IMODE(meta.st_mode) == 0o444,
                "smoke-crash-temp-bytes")
        if checkpoint == "temp-written:backup.py":
            require(names == {temp.name} and meta.st_nlink == 1, "smoke-crash-written-temp")
            return {"temporaryExactBytes": True, "temporaryLinks": 1, "temporaryMode": "0444"}
        final = (destination / "backup.py").lstat()
        require(names == {temp.name, "backup.py"} and meta.st_nlink == final.st_nlink == 2
                and (meta.st_dev, meta.st_ino) == (final.st_dev, final.st_ino), "smoke-crash-linked-inode")
        return {"temporaryExactBytes": True, "temporaryLinks": 2, "twoNamesSameInode": True}
    if checkpoint == "tree-verified":
        require(names == set(payload), "smoke-crash-verified-tree")
        for name, raw in payload.items():
            require(source_bytes(destination / name) == raw, "smoke-crash-verified-bytes")
        return {"payloadExactBeforeReceipt": True, "receiptExists": False}
    require(checkpoint in {"receipt-durable", "pending-cleared"}, "smoke-crash-checkpoint")
    verify_tree(destination, payload)
    return {"payloadExactBeforeSignal": True, "receiptExists": True,
            "pendingExists": checkpoint == "receipt-durable"}


def crash_case(base, index, checkpoint, installer_path, payload, manifest_sha, now):
    root = base / ("case-" + str(index))
    root.mkdir(mode=0o700)
    # Production requires these existing protected roots; the fixture creates
    # only private substitutes before the child imports the installer.
    (root / "install").mkdir(mode=0o755)
    (root / "coordination").mkdir(mode=0o700)
    source = root / "payload"
    source.mkdir(mode=0o700)
    for name, raw in payload.items():
        private_write(source / name, raw)
    before = guards(root / "unchanged")
    capability = approval(str(index + 1) * 32, manifest_sha, now)
    install_raw = wire(capability)
    install_cap = root / "install-cap.json"
    private_write(install_cap, install_raw)
    killed = kill_at_checkpoint(installer_path, root, source, install_cap, checkpoint, now)
    require(guard_snapshot(root / "unchanged") == before, "smoke-crash-side-effects")
    crash_state = verify_crash_state(root, checkpoint, capability["operation_id"], manifest_sha, payload)
    installer = trusted_installer(installer_path, root)
    if checkpoint == "pending-cleared":
        # The caller lost stdout after a completed transaction. Inspection must
        # reveal success without interpreting the missing stdout as permission
        # to start another transaction or automatically reconcile anything.
        state_before = install_snapshot(root)
        settled = installer.inspect_install(manifest_sha)
        require(settled.get("status") == "installed-inactive" and settled.get("pending") is False
                and settled.get("activation_authorized") is False and settled.get("runtime_changed") is False,
                "smoke-completed-before-signal")
        require(installer.inspect_install(manifest_sha) == settled, "smoke-settled-inspect")
        destination = root / "install" / ("web-switch-controller-" + manifest_sha)
        receipt = verify_tree(destination, payload)
        require(receipt.get("status") == "installed-inactive"
                and receipt.get("original_approval_sha256") == digest(install_raw)
                and receipt.get("reconcile_approval_sha256") is None
                and receipt.get("activation_authorized") is False and receipt.get("runtime_changed") is False,
                "smoke-completed-receipt")
        audit = root / "state" / ("approval-" + capability["operation_id"] + ".json")
        require(source_bytes(audit) == install_raw, "smoke-original-approval-audit")
        require(install_snapshot(root) == state_before and guard_snapshot(root / "unchanged") == before,
                "smoke-settled-inspect-wrote")
        return {**killed, "crashState": crash_state, "observedPhase": "already-committed", "alreadyCommittedBeforeSignal": True,
                "noFurtherWritesOnInspect": True, "freshExplicitReconcile": False,
                "installedInactive": True, "exactPayloadBytes": True, "immutableGuardsUnchanged": True,
                "receiptSha256": digest(source_bytes(destination / "installed.json")),
                "activationAuthorized": False, "runtimeChanged": False}
    observed = installer.inspect_install(manifest_sha)
    require(observed.get("status") == "pending" and observed.get("pending") is True
            and observed.get("phase") in {"incomplete", "complete", "committed"}
            and observed.get("operation_id") == capability["operation_id"]
            and observed.get("manifest_sha256") == manifest_sha
            and observed.get("bootstrap_draft_sha256") == capability["bootstrap_draft_sha256"]
            and observed.get("original_approval_sha256") == digest(install_raw)
            and observed.get("activation_authorized") is False and observed.get("runtime_changed") is False,
            "smoke-pending-observation")
    pending_sha = observed["pending_sha256"]
    require(installer.inspect_install(manifest_sha) == observed, "smoke-inspect-not-readonly")
    later = now + 3601
    reconcile = {key: value for key, value in capability.items() if key not in {"purpose", "allow_install"}}
    reconcile.update({"purpose": "citygo-web-switch-controller-reconcile-v1", "approved_at": later,
                      "expires_at": later + 600, "pending_sha256": pending_sha, "allow_reconcile": True})
    reconcile_raw = wire(reconcile)
    reconcile_cap = root / "reconcile-cap.json"
    private_write(reconcile_cap, reconcile_raw)
    try:
        installer.reconcile_package(source, reconcile_cap, now=later)
    except installer.InstallError:
        pass
    else:
        raise SmokeError("smoke-reconcile-without-authority")
    require(installer.inspect_install(manifest_sha) == observed, "smoke-implicit-reconcile")
    result = installer.reconcile_package(source, reconcile_cap, allow_reconcile=True, now=later)
    require(result.get("status") == "installed-inactive", "smoke-reconcile-status")
    final = installer.inspect_install(manifest_sha)
    require(final.get("status") == "installed-inactive" and final.get("pending") is False
            and final.get("activation_authorized") is False and final.get("runtime_changed") is False,
            "smoke-final-status")
    destination = root / "install" / ("web-switch-controller-" + manifest_sha)
    receipt = verify_tree(destination, payload)
    require(receipt.get("status") == "installed-inactive"
            and receipt.get("original_approval_sha256") == digest(install_raw)
            and receipt.get("activation_authorized") is False and receipt.get("runtime_changed") is False,
            "smoke-receipt")
    # A crash after the original receipt was durable preserves that original
    # receipt; earlier phases record the fresh explicit reconciliation approval.
    reconcile_pin = receipt.get("reconcile_approval_sha256")
    require(reconcile_pin == (None if checkpoint == "receipt-durable" else digest(reconcile_raw)),
            "smoke-reconcile-audit")
    audit = root / "state" / ("approval-" + capability["operation_id"] + ".json")
    require(source_bytes(audit) == install_raw, "smoke-original-approval-audit")
    require(guard_snapshot(root / "unchanged") == before, "smoke-side-effects")
    require({path.name for path in (root / "install").iterdir()} == {destination.name}, "smoke-extra-install")
    return {**killed, "crashState": crash_state, "observedPhase": observed["phase"], "pendingPreservedUntilExplicitReconcile": True,
            "expiredOriginalApprovalPreserved": True, "freshExplicitReconcile": True,
            "installedInactive": True, "exactPayloadBytes": True, "immutableGuardsUnchanged": True,
            "receiptSha256": digest(source_bytes(destination / "installed.json")),
            "activationAuthorized": False, "runtimeChanged": False}


def disposable():
    require(sys.platform == "linux" and hasattr(os, "geteuid") and os.geteuid() == 0
            and hasattr(os, "O_NOFOLLOW") and hasattr(signal, "SIGKILL"), "smoke-linux-root-required")
    temp_parent = protected(tempfile.gettempdir())
    source = Path(__file__).absolute().parent
    payload = {name: source_bytes(source / name) for name in SOURCE_NAMES}
    manifest_raw = wire({"version": 1, "purpose": "citygo-web-switch-controller-payload-v1",
                         "files": {name: {"sha256": digest(raw), "size": len(raw)} for name, raw in payload.items()}})
    payload["manifest.json"] = manifest_raw
    installer_raw = source_bytes(source / INSTALLER_NAME)
    now = int(time.time())
    with tempfile.TemporaryDirectory(prefix="citygo-controller-install-smoke-", dir=temp_parent) as directory:
        base = protected(directory)
        installer_path = base / INSTALLER_NAME
        private_write(installer_path, installer_raw, 0o644)
        require(source_bytes(installer_path) == installer_raw, "smoke-installer-copy")
        cases = [crash_case(base, index, checkpoint, installer_path, payload, digest(manifest_raw), now)
                 for index, checkpoint in enumerate(CHECKPOINTS)]
    require(not Path(directory).exists(), "smoke-cleanup")
    return {"purpose": "citygo-inactive-controller-install-crash-smoke-v1", "status": "passed",
            "cases": cases, "installerSha256": digest(installer_raw), "manifestSha256": digest(manifest_raw),
            "payload": {name: {"sha256": digest(raw), "size": len(raw)} for name, raw in sorted(payload.items())},
            "ownedTemporaryTreeRemoved": True, "payloadImported": False, "serverAccess": False,
            "dockerAccess": False, "networkAccess": False, "deploymentAuthorization": False,
            "activationAuthorized": False, "runtimeChanged": False}


def run(args):
    if args in ([], ["--plan"]):
        return {"purpose": "citygo-inactive-controller-install-crash-smoke-v1", "executes": False,
                "writes": False, "execution": "--disposable", "requires": "isolated Linux root; protected TMPDIR",
                "serverAccess": False, "dockerAccess": False, "networkAccess": False,
                "deploymentAuthorization": False, "activationAuthorized": False, "runtimeChanged": False}
    require(args == ["--disposable"], "smoke-arguments")
    return disposable()


def main(args=None):
    try:
        print(json.dumps(run(sys.argv[1:] if args is None else args), sort_keys=True))
        return 0
    except (SmokeError, OSError, ValueError, TypeError, KeyError, ImportError, subprocess.SubprocessError):
        print('{"error":"inactive-controller-install-smoke-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
