"""In-process release/backup checkpoint, NOT a deploy command or migration gate.

The future reviewed controller must close ingress and prove writer quiescence
inside this window before calling backup(). No CLI, automatic unlock or resume.
Even a normal exit retains durable pending: this stage cannot finish a release.
"""
from contextlib import contextmanager
import copy
import os
import re
import threading
import time

import backup as b


class _Window:
    def __init__(self, config, state, operation):
        self._config = copy.deepcopy(config)
        self._state = state
        self._operation = copy.deepcopy(operation)
        self._owner = (os.getpid(), threading.get_ident())
        self._active = True
        self._attempted = False
        self._checkpoint = None
        self._migration_attempted = False

    def _check_owner(self):
        b.require(self._active and self._owner == (os.getpid(), threading.get_ident()), "release-window-inactive")

    def _check(self):
        self._check_owner()
        b.verify_operation(self._state, self._operation)
        b.require(not os.path.lexists(self._state / "worker-admission.json"), "worker-not-paused")
        b.require(b.configuration_fingerprint(self._config) == self._operation["configuration_sha256"], "configuration-changed")

    def backup(self, *, storage_factory=b.S3, encryptor=b.encrypt, min_free=b.MIN_FREE):
        # Dependency arguments are only for isolated tests, never config/CLI input.
        self._check_owner()
        b.require(not self._attempted, "release-backup-already-attempted")
        # Poison before mutable-state preflight too: restoring files/markers
        # after an observed mismatch must not resurrect this release operation.
        self._attempted = True
        self._check()
        manifest = b._backup_in_operation(self._config, self._operation,
            storage_factory=storage_factory, encryptor=encryptor, min_free=min_free)
        self._check()
        checkpoint = {"version": 1, "operation_id": self._operation["id"],
                      "target_sha": self._operation["target_sha"], "backup": manifest,
                      "verified_at": time.time(), "migration_authorized": False}
        b.atomic_json(self._state / "release-backup.json", checkpoint)
        self._checkpoint = copy.deepcopy(checkpoint)
        return copy.deepcopy(checkpoint)


@contextmanager
def release_window(config, target_sha):
    """Hold the SAME lock before, through and after backup, until caller exits.

    Pending remains after exit/crash, regardless of a successful checkpoint.
    No stored checkpoint can reopen this window or authorize a later migration.
    """
    config = copy.deepcopy(b.validate(config))
    b.require(type(target_sha) is str and re.fullmatch(r"[0-9a-f]{40}", target_sha), "release-target")
    b.require(config["upload_enabled"], "upload-disabled")
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state):
        with b.lock(state, "worker-admission.lock"):
            b.assert_operation_idle(state)
            b.require(not os.path.lexists(state / "worker-admission.json"), "worker-not-paused")
            operation = b.begin_operation(state, "release", b.configuration_fingerprint(config),
                                          target_sha=target_sha)
        window = _Window(config, state, operation)
        try:
            yield window
        finally:
            window._active = False
            # Deliberately NOT complete_operation(): a backup is not a release.
