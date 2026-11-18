"""Test recovery decisions independently of Docker and a privileged Nginx."""
from dataclasses import replace
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import web_bootstrap_ingress_transaction as tx
from web_switch import WebSwitchError


OP = "a" * 32
REVIEW = "b" * 64
BOOT = "c" * 32


class Interrupt(Exception):
    pass


class FixtureHost:
    def __init__(self, direction):
        self.initial, self.requested = tx.PROFILES[direction]
        self.epoch = tx.Epoch(self.initial, self.initial, BOOT, (100, 1), frozenset({(101, 2)}))
        self.link_calls = self.hup_calls = 0
        self.gates_closed = True
        self.loaded = True
        self.valid_config = True

    def observe_closed(self):
        if not self.gates_closed:
            raise tx.TransitionError("admission-open")
        return self.epoch

    def replace_link(self, origin, destination):
        assert origin == self.epoch.link and destination == self.requested
        self.epoch = replace(self.epoch, link=destination)
        self.link_calls += 1

    def test_config(self):
        if not self.valid_config:
            raise tx.TransitionError("syntax")

    def hup(self):
        self.hup_calls += 1
        if self.loaded:
            self.epoch = replace(self.epoch, loaded=self.requested, workers=frozenset({(102, 3)}))

    def wait_for_workers(self, _):
        pass


class IngressTransactionTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "ingress.json"
        # The shared atomic writer opens/fsyncs its directory on Linux. Windows
        # unit tests exercise real file replacement, without claiming Linux fsync.
        if os.name == "nt":
            directory_sync = patch("backup.sync_directory")
            directory_sync.start()
            self.addCleanup(directory_sync.stop)
        self.host = FixtureHost("install")

    def call(self, **overrides):
        args = dict(operation=OP, review_sha256=REVIEW, direction="install", host=self.host)
        return tx.transition(self.path, **(args | overrides))

    def read(self):
        return json.loads(self.path.read_bytes())

    def interrupted(self, phase, **overrides):
        def crash(label):
            if label == phase:
                raise Interrupt(label)

        with self.assertRaises(Interrupt):
            self.call(checkpoint=crash, **overrides)

    def test_install_makes_one_hup_and_existing_receipt_can_be_rechecked(self):
        receipt = self.call()
        self.assertEqual(receipt["phase"], "verified-closed")
        self.assertEqual(self.call(resume=True), receipt)
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (1, 1))
        with self.assertRaisesRegex(tx.TransitionError, "journal-exists"):
            self.call()

    def test_lost_link_response_resumes_without_replacing_again(self):
        self.interrupted("link-replaced")
        self.assertEqual(self.read()["phase"], "link-intent")
        self.assertEqual(self.host.epoch.loaded, "legacy")
        self.assertEqual(self.call(resume=True)["phase"], "verified-closed")
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (1, 1))

    def test_lost_hup_response_can_be_confirmed_without_resending(self):
        self.interrupted("hup-sent")
        self.assertEqual(self.read()["phase"], "hup-intent")
        self.assertEqual(self.call(resume=True)["phase"], "verified-closed")
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (1, 1))

    def test_crash_around_hup_with_old_generation_retains_pending_intent(self):
        self.interrupted("hup-intent")
        baseline = self.path.read_bytes()
        with self.assertRaisesRegex(tx.TransitionError, "reload-unconfirmed"):
            self.call(resume=True)
        self.assertEqual(self.path.read_bytes(), baseline)
        self.assertEqual(self.host.hup_calls, 0)

    def test_unproven_hup_is_never_replayed_after_wrong_live_profile(self):
        self.host.loaded = False
        with self.assertRaisesRegex(tx.TransitionError, "reload-unconfirmed"):
            self.call()
        self.host.epoch = replace(self.host.epoch, workers=frozenset({(102, 3)}))
        with self.assertRaisesRegex(tx.TransitionError, "reload-unconfirmed"):
            self.call(resume=True)
        self.assertEqual(self.host.hup_calls, 1)

    def test_old_workers_master_reuse_and_reboot_do_not_prove_convergence(self):
        self.interrupted("hup-sent")
        final = self.host.epoch
        for drift in ({"workers": final.workers | {(101, 2)}}, {"master": (100, 4)}, {"boot_id": "d" * 32}):
            with self.subTest(drift=drift):
                self.host.epoch = replace(final, **drift)
                with self.assertRaisesRegex(tx.TransitionError, "reload-unconfirmed"):
                    self.call(resume=True)
        self.assertEqual(self.host.hup_calls, 1)

    def test_wrong_review_or_direction_cannot_reuse_journal(self):
        self.interrupted("link-intent")
        for overrides in ({"review_sha256": "f" * 64}, {"direction": "restore"}, {"operation": "e" * 32}):
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(tx.TransitionError, "journal-binding"):
                    self.call(resume=True, **overrides)
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (0, 0))

    def test_closed_gate_checked_again_after_hup_intent(self):
        def open_gate(label):
            if label == "hup-intent":
                self.host.gates_closed = False

        with self.assertRaisesRegex(tx.TransitionError, "admission-open"):
            self.call(checkpoint=open_gate)
        self.assertEqual(self.read()["phase"], "hup-intent")
        self.assertEqual(self.host.hup_calls, 0)

    def test_invalid_nginx_keeps_legacy_live_and_does_not_signal(self):
        self.host.valid_config = False
        with self.assertRaisesRegex(tx.TransitionError, "syntax"):
            self.call()
        self.assertEqual(self.read()["phase"], "link-intent")
        self.assertEqual(self.host.epoch.loaded, "legacy")
        self.assertEqual(self.host.hup_calls, 0)

    def test_restore_has_reverse_profiles_and_its_own_operation(self):
        self.host = FixtureHost("restore")
        self.interrupted("link-replaced", direction="restore")
        receipt = self.call(resume=True, direction="restore")
        self.assertEqual(receipt["binding"]["direction"], "restore")
        self.assertEqual(self.host.epoch.link, "legacy")
        self.assertEqual(self.host.epoch.loaded, "legacy")
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (1, 1))

    def test_invalid_journal_never_starts_or_resumes(self):
        self.path.write_bytes(b'{"phase":"link-intent","phase":"verified-closed"}')
        with self.assertRaises(WebSwitchError):
            self.call(resume=True)
        self.assertEqual((self.host.link_calls, self.host.hup_calls), (0, 0))


if __name__ == "__main__":
    unittest.main()
