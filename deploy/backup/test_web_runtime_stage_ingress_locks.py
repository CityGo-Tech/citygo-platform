"""Verify lock contention against the actual Linux stage lock implementation."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import web_bootstrap_ingress_locked as ingress
import web_runtime_stage as stage


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires protected Linux locks")
class LockedIngressControllerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR", "/root"))
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.stage, self.coordination = root / "stage", root / "coordination"
        for path in (self.stage, self.coordination):
            path.mkdir(mode=0o700)
        self.locks = (
            (self.coordination, "maintenance.lock"),
            (self.coordination, "worker-admission.lock"),
            (self.stage, "runtime-stage.lock"),
        )
        for directory, name in self.locks:
            (directory / name).touch(mode=0o600)
        self.proof = root / "proof.json"
        for name, value in (("STATE_ROOT", self.stage), ("COORDINATION_ROOT", self.coordination)):
            override = patch.object(stage, name, value)
            override.start()
            self.addCleanup(override.stop)

    def test_all_shared_locks_block_the_live_verifier_before_it_reads_the_proof(self):
        for directory, name in self.locks:
            with self.subTest(lock=name), stage._lock(directory, name, readonly=True):
                with patch.object(stage, "_platform"), patch.object(stage, "read") as read:
                    with self.assertRaisesRegex(stage.StageError, "runtime-stage-already-running"):
                        ingress.verify_locked(self.proof)
                    self.assertNotIn(self.proof, [call.args[0] for call in read.call_args_list])

    def test_lock_inodes_are_verified_and_a_replaced_namespace_is_rejected(self):
        with stage._locked(readonly=True) as namespace:
            namespace()
            lockfile = self.stage / "runtime-stage.lock"
            lockfile.unlink()
            lockfile.touch(mode=0o600)
            with self.assertRaisesRegex(stage.StageError, "stage-lock-namespace-changed"):
                namespace()

    def test_missing_lock_is_not_created(self):
        lockfile = self.coordination / "worker-admission.lock"
        lockfile.unlink()
        with patch.object(stage, "_platform"), patch.object(stage, "read"):
            with self.assertRaisesRegex(stage.StageError, "stage-lock-missing"):
                ingress.verify_locked(self.proof)
        self.assertFalse(lockfile.exists())


if __name__ == "__main__":
    unittest.main()
