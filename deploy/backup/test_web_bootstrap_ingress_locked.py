"""Verify the read-only generation decision without Linux or Nginx."""
from copy import deepcopy
from dataclasses import replace
import unittest

from web_bootstrap_ingress_locked import LockedIngressError, confirm_generation
from web_bootstrap_ingress_transaction import Epoch


OPERATION = "a" * 32
REVIEW = "b" * 64
BOOT = "c" * 32
MASTER = (100, 1)
LEGACY = Epoch("legacy", "legacy", BOOT, MASTER, frozenset({(101, 2), (102, 3)}))
SWITCH = Epoch("switch", "switch", BOOT, MASTER, frozenset({(103, 4), (104, 5)}))
VERIFIED = "verified-closed"
HUP_PENDING = "observed-closed-hup-receipt-pending"


def receipt(direction, before, after=None):
    return {
        "version": 1,
        "binding": {
            "operation": OPERATION,
            "review_sha256": REVIEW,
            "direction": direction,
        },
        "phase": VERIFIED if after else "hup-intent",
        "before": before.pins(),
        "after": after.pins() if after else None,
    }


class ConfirmGenerationTests(unittest.TestCase):
    def test_fully_replaced_install_workers_prove_pending_reload_without_mutating_receipt(self):
        record = receipt("install", LEGACY)
        snapshot = deepcopy(record)

        self.assertEqual(confirm_generation(record, SWITCH), HUP_PENDING)
        self.assertEqual(record, snapshot)

    def test_install_rejects_incomplete_reload_or_changed_identity(self):
        record = receipt("install", LEGACY)
        for label, drift in (
            ("old workers", {"workers": LEGACY.workers}),
            ("mixed workers", {"workers": SWITCH.workers | {(101, 2)}}),
            ("no workers", {"workers": frozenset()}),
            ("stale loaded profile", {"loaded": "legacy"}),
            ("stale site link", {"link": "legacy"}),
            ("reboot", {"boot_id": "d" * 32}),
            ("new master PID", {"master": (200, 1)}),
            ("reused master PID", {"master": (100, 10)}),
        ):
            with self.subTest(label=label), self.assertRaises(LockedIngressError):
                confirm_generation(record, replace(SWITCH, **drift))

    def test_link_intent_cannot_be_confirmed_from_new_workers(self):
        record = receipt("install", LEGACY)
        record["phase"] = "link-intent"

        with self.assertRaises(LockedIngressError):
            confirm_generation(record, SWITCH)

    def test_verified_install_requires_exact_after_epoch(self):
        record = receipt("install", LEGACY, SWITCH)

        self.assertEqual(confirm_generation(record, SWITCH), VERIFIED)
        for workers in (frozenset({(103, 4)}), frozenset({(105, 6), (106, 7)})):
            with self.subTest(workers=workers), self.assertRaises(LockedIngressError):
                confirm_generation(record, replace(SWITCH, workers=workers))

    def test_restore_allows_worker_churn_since_verified_install(self):
        prior = receipt("install", LEGACY, SWITCH)
        before = replace(SWITCH, workers=frozenset({(104, 5), (105, 6)}))
        after = replace(LEGACY, workers=frozenset({(106, 7), (107, 8)}))
        pending = receipt("restore", before)
        snapshots = deepcopy((pending, prior))

        self.assertEqual(confirm_generation(pending, after, prior), HUP_PENDING)
        self.assertEqual(confirm_generation(receipt("restore", before, after), after, prior), VERIFIED)
        self.assertEqual((pending, prior), snapshots)
        for workers in (before.workers | after.workers, frozenset({(108, 9)})):
            with self.subTest(workers=workers), self.assertRaises(LockedIngressError):
                confirm_generation(
                    receipt("restore", before, after), replace(after, workers=workers), prior
                )

    def test_restore_rejects_missing_unbound_or_unproven_install(self):
        after = replace(LEGACY, workers=frozenset({(105, 6)}))
        record = receipt("restore", SWITCH, after)
        valid = receipt("install", LEGACY, SWITCH)
        for label, prior in (
            ("missing", None),
            ("unverified", receipt("install", LEGACY)),
            ("wrong direction", receipt("restore", LEGACY, SWITCH)),
            ("different operation", valid | {"binding": valid["binding"] | {"operation": "e" * 32}}),
            ("different review", valid | {"binding": valid["binding"] | {"review_sha256": "f" * 64}}),
            ("workers not replaced", receipt("install", LEGACY, replace(SWITCH, workers=LEGACY.workers))),
        ):
            with self.subTest(label=label), self.assertRaises(LockedIngressError):
                confirm_generation(record, after, prior)

    def test_restore_rejects_host_identity_change_since_prior_install(self):
        prior = receipt("install", LEGACY, SWITCH)
        for label, drift in (("reboot", {"boot_id": "d" * 32}), ("master replacement", {"master": (100, 12)})):
            with self.subTest(label=label), self.assertRaises(LockedIngressError):
                before = replace(SWITCH, **drift)
                after = replace(LEGACY, workers=frozenset({(105, 6)}), **drift)
                confirm_generation(receipt("restore", before, after), after, prior)


if __name__ == "__main__":
    unittest.main()
