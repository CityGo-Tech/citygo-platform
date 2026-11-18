"""Synthetic offline review tests; no local runtime or network prerequisites."""
import copy
import io
from contextlib import redirect_stderr, redirect_stdout
import json
from os import link
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import test_web_bootstrap as synthetic
import web_bootstrap as compiler
import web_bootstrap_handoff as handoff
import web_runtime_stage as stage
import web_switch as switch


def fixture():
    canonical, request, now = synthetic.fixture()
    op = request["operation_id"]
    source = request["source_sha"]
    draft = compiler.compile_draft(canonical, switch.wire(request), now)["draft.json"]

    def pin(role, ident, image, project=compiler.PROJECT):
        return {"id": ident * 64, "image": "sha256:" + image * 64, "source_sha": source,
                "started_at": "2026-11-09T01:00:00.000000000Z", "runtime_sha256": ident * 64,
                "project": project, "service": role}

    baseline = {"api": pin("api", "5", "1"), "web": pin("web", "6", "2"),
                "postgres": pin("postgres", "7", "4"), "jobs": [pin("worker", "8", "3")]}
    networks = {"web": request["web_network"], "database": {"name": "citygo-pilot_database", "id": "e" * 64}}
    backup, restore = [{"path": "/var/lib/citygo-backup/" + name + ".json", "sha256": digit * 64}
                       for name, digit in (("backup", "1"), ("restore", "2"))]
    plan = {"version": 1, "purpose": stage.PURPOSE, "operation_id": op, "origin": request["origin"],
            "observed_at": now - 2, "expires_at": now + 1,
            "draft_dir": "/var/lib/citygo-backup/draft-review", "draft_sha256": switch.digest(draft),
            "baseline": baseline, "networks": networks,
            "files": [*request["originals"].values(), *request["secret_pins"], backup, restore],
            "attestation": {"drained": True, "backup": backup, "restore": restore, "observed_at": now - 3},
            "runtime_semantics": {"api": "a" * 64, "web": "b" * 64}}
    raw_plan = switch.wire(plan)
    plan_hash = switch.digest(raw_plan)
    barrier = {"version": 1, "operation": "web-runtime-stage", "id": op,
               "configuration_sha256": switch.digest(switch.wire(request["originals"])), "stage_plan_sha256": plan_hash}
    targets = {"api": pin("api", "c", "1"), "web": pin("web", "d", "2", "citygo-web-bootstrap-" + op)}
    pending = {"version": 1, "operation_id": op, "plan_sha256": plan_hash, "started_at": now,
               "original_approval_sha256": "5" * 64, "legacy_barrier_sha256": switch.digest(switch.wire(barrier)),
               "phase": "prepared-closed", "intent": None, "targets": {role: value["id"] for role, value in targets.items()},
               "completed": list(stage.INTENTS), "ready_pins": targets,
               "runtime_semantics_sha256": switch.digest(switch.wire(plan["runtime_semantics"]))}
    receipt = stage._receipt(plan, raw_plan, pending, targets)
    inspection = {"status": "prepared-closed", "intent": None, "operation_id": op, "plan_sha256": plan_hash,
                  "pending_sha256": switch.digest(switch.wire(pending)), "desired_ready": True,
                  "legacy_barrier_retained": True, "traffic_opened": False}
    values = {"stage-plan.json": plan, "draft.json": json.loads(draft), "prepared.json": receipt,
              "pending.json": pending, "legacy-barrier.json": barrier, "stage-inspection.json": inspection}
    files = {name: switch.wire(value) for name, value in values.items()}
    files["draft.json"] = draft
    files["observation.json"] = switch.wire(observation_fixture(files, now + 4))
    return files, now + 6


def observation_fixture(files, captured):
    plan = json.loads(files["stage-plan.json"])
    draft = json.loads(files["draft.json"])
    targets = json.loads(files["prepared.json"])["targets"]
    op = plan["operation_id"]
    baseline = plan["baseline"]
    return {"version": 1, "purpose": handoff.OBSERVATION, "operation_id": op, "observed_at": captured,
                   "inspection_sha256": switch.digest(files["stage-inspection.json"]),
                   "prepared_sha256": switch.digest(files["prepared.json"]),
                   "runtime": {"api": targets["api"], "old_web": baseline["web"], "new_web": targets["web"],
                               "postgres": baseline["postgres"], "jobs": baseline["jobs"], "networks": plan["networks"]},
                   "canonical_file_pins_sha256": switch.digest(switch.wire(draft["originals"])),
                   "gates": {"traffic_open": False, "worker_admission_open": False,
                             "autodeploy_enabled": False, "external_reload_excluded": True},
                   "ingress": {"enabled_link": {"path": handoff.LEGACY_ENABLED, "target": handoff.LEGACY_AVAILABLE},
                               "legacy_config": {"path": handoff.LEGACY_AVAILABLE, "sha256": "1" * 64},
                               "candidate_config_sha256": "2" * 64, "tls_evidence_sha256": "3" * 64,
                               "initial_upstream_sha256": switch.digest(switch.upstream(3000)),
                               "master": {"pid": 91, "starttime": 31}, "workers": [{"pid": 92, "starttime": 41}]},
                   "assets": {"public_manifest_sha256": "4" * 64, "static_manifest_sha256": "5" * 64,
                              "archive_observation_sha256": "6" * 64}}


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.files, self.now = fixture()

    def replace(self, name, update):
        value = json.loads(self.files[name])
        update(value)
        self.files[name] = switch.wire(value)

    def rebind_observation(self, name):
        field = {"prepared.json": "prepared_sha256", "stage-inspection.json": "inspection_sha256"}[name]
        self.replace("observation.json", lambda observation: observation.update({field: switch.digest(self.files[name])}))

    def reject(self, code):
        with self.assertRaisesRegex(handoff.HandoffError, "^" + code + "$"):
            handoff.review_handoff(self.files, now=self.now)

    def test_historical_stage_with_new_capture_returns_only_inert_review(self):
        result = handoff.review_handoff(self.files, now=self.now)
        self.assertEqual(result, handoff.review_handoff(copy.deepcopy(self.files), now=self.now))
        self.assertEqual({name: switch.digest(raw) for name, raw in self.files.items()}, result["evidence_sha256"])
        self.assertEqual((result["first_upstream_port"], result["canary_port"]), (3000, 3001))
        self.assertEqual(result["status"], "reviewed-closed-not-authorized")
        self.assertTrue(result["legacy_barrier_retained"])
        for field in ("deploymentAuthorization", "readyToApply", "serverAccess", "productionPlan",
                      "legacy_resume_allowed", "runtimeChanged"):
            self.assertIs(result[field], False)
        self.assertNotIn("runtime", result)

    def test_raw_file_hashes_are_required_even_if_json_is_unchanged(self):
        for name, code in (("draft.json", "handoff-draft"), ("legacy-barrier.json", "handoff-pending"),
                           ("stage-inspection.json", "handoff-observation"), ("prepared.json", "handoff-observation")):
            with self.subTest(name=name):
                self.files, self.now = fixture()
                self.files[name] = b" " + self.files[name]
                self.reject(code)

    def test_receipt_must_preserve_same_source_image_and_distinct_ids(self):
        for field, value in (("source_sha", "d" * 40), ("image", "sha256:" + "b" * 64), ("id", "6" * 64),
                             ("project", "citygo-other")):
            with self.subTest(field=field):
                self.files, self.now = fixture()
                self.replace("prepared.json", lambda receipt: receipt["targets"]["web"].update({field: value}))
                self.rebind_observation("prepared.json")
                self.reject("handoff-target")

    def test_rejects_partial_or_rebound_stage_even_with_correct_inspection_hash(self):
        for patch_value in ({"phase": "intent"}, {"intent": "web-start"}, {"completed": ["api-term"]}):
            with self.subTest(patch_value=patch_value):
                self.files, self.now = fixture()
                self.replace("pending.json", lambda pending: pending.update(patch_value))
                self.replace("stage-inspection.json", lambda inspection: inspection.update(
                    pending_sha256=switch.digest(self.files["pending.json"])))
                self.rebind_observation("stage-inspection.json")
                self.reject("handoff-pending")

    def partial_adoption(self, count, *, adopted=True, archived=False):
        pending = json.loads(self.files["pending.json"])
        pending.update(completed=list(stage.INTENTS[:count]), ready_pins={"api": pending["ready_pins"]["api"]})
        self.files["pending.json"] = json.dumps(pending, sort_keys=True).encode()
        ack_lost = count < len(stage.INTENTS)
        before = dict(pending, phase="intent" if ack_lost else "done", intent="web-start" if ack_lost else None)
        state_name = "adopt-state.json"
        self.files[state_name] = json.dumps(before, sort_keys=True).encode()
        approval = {
            "version": 1, "purpose": stage.ADOPT_APPROVAL, "operation_id": pending["operation_id"],
            "plan_sha256": pending["plan_sha256"], "pending_sha256": switch.digest(self.files[state_name]),
            "approved_at": pending["started_at"], "expires_at": self.now - 3 if archived else self.now + 30,
            "allow_adopt": True,
        }
        self.files["adopt-approval.json"] = switch.wire(approval)
        self.replace("stage-inspection.json", lambda inspection: inspection.update(
            pending_sha256=switch.digest(self.files["pending.json"])))
        if adopted:
            self.bind_adopt_receipt()
        self.rebind_observation("stage-inspection.json")

    def bind_adopt_receipt(self):
        self.replace("prepared.json", lambda receipt: receipt.update(
            adopt_approval_sha256=switch.digest(self.files["adopt-approval.json"])))
        self.rebind_observation("prepared.json")

    def test_partial_journal_requires_real_prefix_and_original_receipt_kind(self):
        cases = ((5, True, None), (6, True, None), (6, False, None),
                 (4, True, "handoff-pending"), (5, False, "handoff-adopt-audit"))
        for count, adopted, expected in cases:
            with self.subTest(count=count, adopted=adopted):
                self.files, self.now = fixture()
                self.partial_adoption(count, adopted=adopted, archived=True)
                prior = dict(self.files)
                if expected:
                    self.reject(expected)
                else:
                    self.assertEqual(handoff.review_handoff(self.files, now=self.now)["status"],
                                     "reviewed-closed-not-authorized")
                self.assertEqual(self.files, prior)

    def test_partial_journal_rejects_missing_unbound_expired_shape_or_future_audit(self):
        for changes in ({"allow_adopt": 1}, {"pending_sha256": "9" * 64}, {"operation_id": "9" * 32},
                        {"plan_sha256": "9" * 64}, {"approved_at": self.now + 1}, {"expires_at": 1}):
            with self.subTest(changes=changes):
                self.files, self.now = fixture()
                self.partial_adoption(5)
                self.replace("adopt-approval.json", lambda approval: approval.update(changes))
                self.bind_adopt_receipt()
                self.reject("handoff-adopt-audit")
        self.files, self.now = fixture()
        self.partial_adoption(6, adopted=False)
        for name in handoff.ADOPT_FILES:
            self.files.pop(name)
        self.reject("handoff-adopt-audit")

    def test_partial_journal_compare_requires_actual_saved_bytes_and_receipt_digest(self):
        self.partial_adoption(5)
        self.files["adopt-approval.json"] = b" " + self.files["adopt-approval.json"]
        self.reject("handoff-adopt-audit")
        self.files, self.now = fixture()
        self.partial_adoption(6, adopted=False)
        self.files["adopt-state.json"] += b"\n"
        self.replace("adopt-approval.json", lambda approval: approval.update(
            pending_sha256=switch.digest(self.files["adopt-state.json"])))
        self.reject("handoff-adopt-audit")

    def test_legacy_barrier_must_be_bound_to_original_canonical_pins(self):
        self.replace("legacy-barrier.json", lambda value: value.update(configuration_sha256="f" * 64))
        self.replace("pending.json", lambda value: value.update(legacy_barrier_sha256=switch.digest(
            self.files["legacy-barrier.json"])))
        self.replace("stage-inspection.json", lambda value: value.update(pending_sha256=switch.digest(
            self.files["pending.json"])))
        self.rebind_observation("stage-inspection.json")
        self.reject("handoff-barrier")

    def test_inspection_must_confirm_live_closed_desired_topology(self):
        self.replace("stage-inspection.json", lambda value: value.update(desired_ready=False))
        self.rebind_observation("stage-inspection.json")
        self.reject("handoff-inspection")

    def test_rejects_stale_and_future_capture(self):
        for offset in (-handoff.MAX_AGE, 1):
            with self.subTest(offset=offset):
                self.files, self.now = fixture()
                self.replace("observation.json", lambda value: value.update(observed_at=self.now + offset))
                self.reject("handoff-observation")

    def test_rejects_drift_in_proc_inventory_or_legacy_config(self):
        for mutate in (lambda value: value["runtime"]["postgres"].update(runtime_sha256="f" * 64),
                       lambda value: value["runtime"]["jobs"].clear(),
                       lambda value: value["runtime"]["old_web"].update(started_at="2026-11-11T01:00:00.000000000Z"),
                       lambda value: value.update(canonical_file_pins_sha256="f" * 64)):
            self.files, self.now = fixture()
            self.replace("observation.json", mutate)
            self.reject("handoff-baseline")

    def test_rejects_numeric_booleans_and_open_gates(self):
        for field, value in (("traffic_open", True), ("worker_admission_open", True),
                             ("autodeploy_enabled", 0), ("external_reload_excluded", False)):
            with self.subTest(field=field):
                self.files, self.now = fixture()
                self.replace("observation.json", lambda observed: observed["gates"].update({field: value}))
                self.reject("handoff-gates")

    def test_rejects_legacy_nginx_path_drift_wrong_first_port_and_pid_alias(self):
        for mutate, code in (
            (lambda value: value["ingress"]["enabled_link"].update(target="/tmp/foreign"), "handoff-ingress"),
            (lambda value: value["ingress"].update(initial_upstream_sha256=switch.digest(switch.upstream(3001))), "handoff-ingress"),
            (lambda value: value["ingress"]["workers"][0].update(pid=91), "handoff-workers"),
            (lambda value: value["assets"].update(static_manifest_sha256="secret"), "handoff-assets"),
        ):
            self.files, self.now = fixture()
            self.replace("observation.json", mutate)
            self.reject(code)

    def test_rejects_oversized_duplicate_and_extra_input(self):
        self.files["observation.json"] = b'{"version":1,"version":2}'
        self.reject("handoff-invalid-evidence")
        self.files["observation.json"] = b" " * (stage.MAX_JSON + 1)
        self.reject("handoff-input-size")
        self.files["secret.json"] = b"{}"
        self.reject("handoff-inputs")

    def test_cli_inert_and_read_only_with_redacted_rejection(self):
        with redirect_stdout(io.StringIO()) as out:
            status = handoff.main([])
        self.assertEqual(status, 0)
        self.assertIs(json.loads(out.getvalue())["serverAccess"], False)
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, raw in self.files.items():
                (root / name).write_bytes(raw)
            with patch.object(handoff.time, "time", return_value=self.now), redirect_stdout(io.StringIO()) as out:
                self.assertEqual(handoff.main(["--review", temporary]), 0)
            self.assertEqual(json.loads(out.getvalue())["status"], "reviewed-closed-not-authorized")
            self.assertEqual({item.name: item.read_bytes() for item in root.iterdir()}, self.files)
            (root / "observation.json").write_bytes(b"PRIVATE_TOKEN_VALUE")
            with redirect_stderr(io.StringIO()) as err:
                self.assertEqual(handoff.main(["--review", temporary]), 1)
            self.assertEqual(json.loads(err.getvalue()), {"error": "handoff-invalid-evidence"})


    def test_cli_rejects_multiply_linked_evidence(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, raw in self.files.items():
                (root / name).write_bytes(raw)
            link(root / "observation.json", root / "second-link.json")
            with redirect_stderr(io.StringIO()) as err:
                self.assertEqual(handoff.main(["--review", temporary]), 1)
            self.assertEqual(json.loads(err.getvalue()), {"error": "handoff-input-path"})


if __name__ == "__main__":
    unittest.main()
