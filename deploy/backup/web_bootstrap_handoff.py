"""Pure review of the prepared-closed Web bootstrap boundary.

A coherent export is an offline review draft. A live attestation, V2 plan
and capability belong to the later protected handoff.
"""
import json
import os
import stat
import sys
import time
from pathlib import Path

import web_bootstrap as compiler
import web_runtime_stage as stage
import web_switch as switch


PURPOSE = "citygo-web-bootstrap-handoff-review-v1"
OBSERVATION = "citygo-web-bootstrap-handoff-observation-v1"
MAX_AGE = 120
LEGACY_ENABLED = "/etc/nginx/sites-enabled/citygo-pilot"
LEGACY_AVAILABLE = "/etc/nginx/sites-available/citygo-pilot"
FILES = (
    "stage-plan.json", "draft.json", "prepared.json", "pending.json",
    "legacy-barrier.json", "stage-inspection.json", "observation.json",
)
ADOPT_FILES = ("adopt-approval.json", "adopt-state.json")
GATES = {
    "traffic_open": False,
    "worker_admission_open": False,
    "autodeploy_enabled": False,
    "external_reload_excluded": True,
}


class HandoffError(Exception):
    """Fixed diagnostics. Input bodies and local paths are never reported."""


def require(condition, code):
    if not condition:
        raise HandoffError(code)


def fields(value, names, code):
    require(type(value) is dict and set(value) == set(names), code)


def hash_fields(value, names, code):
    fields(value, names, code)
    require(all(switch.matches(item, switch.HEX) for item in value.values()), code)


def parse(raw):
    require(type(raw) is bytes and 0 < len(raw) <= stage.MAX_JSON, "handoff-input-size")
    return switch.strict_json(raw)


def version_one(value):
    return type(value) is int and value == 1


def prepared_pins(receipt, plan, plan_hash):
    flags = {
        "legacy_barrier_retained": True, "traffic_opened": False,
        "nginx_changed": False, "runtime_changed": True,
        "requires_fresh_handoff": True, "legacy_resume_allowed": False,
    }
    fields(receipt, {
        "version", "status", "operation_id", "plan_sha256", "original_approval_sha256",
        "adopt_approval_sha256", "targets", "attestation_provenance", *flags,
    }, "handoff-receipt")
    require(version_one(receipt["version"]) and receipt["status"] == "prepared-closed"
            and receipt["operation_id"] == plan["operation_id"] and receipt["plan_sha256"] == plan_hash
            and switch.matches(receipt["original_approval_sha256"], switch.HEX)
            and (receipt["adopt_approval_sha256"] is None
                 or switch.matches(receipt["adopt_approval_sha256"], switch.HEX))
            and receipt["attestation_provenance"] == "operator-supplied-not-live-proof"
            and all(receipt[name] is expected for name, expected in flags.items()), "handoff-receipt")
    targets = receipt["targets"]
    fields(targets, ("api", "web"), "handoff-target")
    ids = {plan["baseline"][role]["id"] for role in ("api", "web", "postgres")}
    ids.update(pin["id"] for pin in plan["baseline"]["jobs"])
    for role, project in (("api", compiler.PROJECT), ("web", "citygo-web-bootstrap-" + plan["operation_id"])):
        pin = targets[role]
        switch.container_pin(pin)
        previous = plan["baseline"][role]
        require(pin["service"] == role and pin["project"] == project and pin["id"] not in ids
                and pin["image"] == previous["image"] and pin["source_sha"] == previous["source_sha"],
                "handoff-target")
        ids.add(pin["id"])
    return targets


def closed_journal(pending, barrier, inspection, hashes, plan, receipt, targets, originals):
    fields(pending, {
        "version", "operation_id", "plan_sha256", "started_at", "original_approval_sha256",
        "legacy_barrier_sha256", "phase", "intent", "targets", "completed", "ready_pins",
        "runtime_semantics_sha256",
    }, "handoff-pending")
    op = plan["operation_id"]
    fully_recorded = pending["completed"] == list(stage.INTENTS) and pending["ready_pins"] == targets
    # Adoption proves the running topology without filling in a lost command
    # acknowledgement or a Web readiness pin absent from the original journal.
    partial = (pending["completed"] in (list(stage.INTENTS[:-1]), list(stage.INTENTS))
               and pending["ready_pins"] == {"api": targets["api"]})
    require(version_one(pending["version"]) and pending["operation_id"] == op
            and pending["plan_sha256"] == hashes["stage-plan.json"]
            and type(pending["started_at"]) is int
            and plan["observed_at"] <= pending["started_at"] < plan["expires_at"]
            and pending["original_approval_sha256"] == receipt["original_approval_sha256"]
            and pending["legacy_barrier_sha256"] == hashes["legacy-barrier.json"]
            and pending["phase"] == "prepared-closed" and pending["intent"] is None
            and (fully_recorded or partial)
            and pending["targets"] == {role: pin["id"] for role, pin in targets.items()}
            and pending["runtime_semantics_sha256"] == switch.digest(switch.wire(plan["runtime_semantics"])),
            "handoff-pending")
    require(type(barrier) is dict and version_one(barrier.get("version")) and barrier == {
        "version": 1, "operation": "web-runtime-stage", "id": op,
        "configuration_sha256": switch.digest(switch.wire(originals)),
        "stage_plan_sha256": hashes["stage-plan.json"],
    }, "handoff-barrier")
    fields(inspection, (
        "status", "intent", "operation_id", "plan_sha256", "pending_sha256", "desired_ready",
        "legacy_barrier_retained", "traffic_opened",
    ), "handoff-inspection")
    require(inspection["status"] == "prepared-closed" and inspection["intent"] is None
            and inspection["operation_id"] == op and inspection["plan_sha256"] == hashes["stage-plan.json"]
            and inspection["pending_sha256"] == hashes["pending.json"] and inspection["desired_ready"] is True
            and inspection["legacy_barrier_retained"] is True and inspection["traffic_opened"] is False,
            "handoff-inspection")


    return partial


def adopt_audit(files, hashes, pending, receipt, captured):
    code = "handoff-adopt-audit"
    approval_name, state_name = ADOPT_FILES
    require(approval_name in files and state_name in files, code)
    ack_lost = pending["completed"] == list(stage.INTENTS[:-1])
    approval_hash = receipt["adopt_approval_sha256"]
    require(approval_hash == hashes[approval_name] or (approval_hash is None and not ack_lost), code)
    before = dict(pending, phase="intent" if ack_lost else "done", intent="web-start" if ack_lost else None)
    # Match the exact serializer used by stage._save via backup.atomic_json.
    require(files[state_name] == json.dumps(before, sort_keys=True).encode("utf-8")
            and files["pending.json"] == json.dumps(pending, sort_keys=True).encode("utf-8"), code)
    try:
        approval = stage.authorization(files[approval_name], stage.ADOPT_APPROVAL)
    except stage.StageError:
        raise HandoffError(code) from None
    require(approval["operation_id"] == pending["operation_id"] and approval["plan_sha256"] == pending["plan_sha256"]
            and approval["pending_sha256"] == hashes[state_name]
            and pending["started_at"] <= approval["approved_at"] <= captured, code)


def observe(observation, hashes, plan, pending, targets, originals, now):
    fields(observation, (
        "version", "purpose", "operation_id", "observed_at", "inspection_sha256", "prepared_sha256",
        "runtime", "canonical_file_pins_sha256", "gates", "ingress", "assets",
    ), "handoff-observation")
    captured = observation["observed_at"]
    require(version_one(observation["version"]) and observation["purpose"] == OBSERVATION
            and observation["operation_id"] == plan["operation_id"]
            and type(now) is int and type(captured) is int
            and pending["started_at"] <= captured <= now < captured + MAX_AGE
            and observation["inspection_sha256"] == hashes["stage-inspection.json"]
            and observation["prepared_sha256"] == hashes["prepared.json"], "handoff-observation")
    expected = {"api": targets["api"], "new_web": targets["web"], "old_web": plan["baseline"]["web"],
                "postgres": plan["baseline"]["postgres"], "jobs": plan["baseline"]["jobs"],
                "networks": plan["networks"]}
    require(observation["runtime"] == expected
            and observation["canonical_file_pins_sha256"] == switch.digest(switch.wire(originals)),
            "handoff-baseline")
    fields(observation["gates"], GATES, "handoff-gates")
    require(all(observation["gates"][name] is expected for name, expected in GATES.items()), "handoff-gates")
    ingress = observation["ingress"]
    fields(ingress, ("enabled_link", "legacy_config", "candidate_config_sha256", "initial_upstream_sha256",
                     "master", "workers", "tls_evidence_sha256"), "handoff-ingress")
    fields(ingress["enabled_link"], ("path", "target"), "handoff-ingress")
    switch.file_pin(ingress["legacy_config"])
    require(ingress["enabled_link"]["path"] == LEGACY_ENABLED
            and ingress["enabled_link"]["target"] in (LEGACY_AVAILABLE, "../sites-available/citygo-pilot")
            and ingress["legacy_config"]["path"] == LEGACY_AVAILABLE
            and all(switch.matches(ingress[name], switch.HEX) for name in ("candidate_config_sha256", "tls_evidence_sha256"))
            and ingress["legacy_config"]["sha256"] != ingress["candidate_config_sha256"]
            and ingress["initial_upstream_sha256"] == switch.digest(switch.upstream(3000)),
            "handoff-ingress")
    workers = ingress["workers"]
    require(type(workers) is list and 1 <= len(workers) <= 128, "handoff-workers")
    processes = [ingress["master"], *workers]
    for pin in processes:
        switch.process_pin(pin)
    require(len({pin["pid"] for pin in processes}) == len(processes), "handoff-workers")
    hash_fields(observation["assets"], ("public_manifest_sha256", "static_manifest_sha256",
                "archive_observation_sha256"), "handoff-assets")
    return captured


def review_handoff(files, *, now):
    """Cross-check hashes and runtime pins in bounded in-memory evidence."""
    try:
        require(type(files) is dict and set(files) in (set(FILES), set(FILES + ADOPT_FILES)), "handoff-inputs")
        values = {name: parse(raw) for name, raw in files.items()}
        hashes = {name: switch.digest(raw) for name, raw in files.items()}
        # Historical stage plan is evidence. Only the new observation has a
        # handoff freshness deadline, and this review creates no capability.
        plan = stage.validate_plan(files["stage-plan.json"])
        draft = values["draft.json"]
        require(hashes["draft.json"] == plan["draft_sha256"] and type(draft) is dict
                and version_one(draft.get("version")) and draft.get("purpose") == compiler.PURPOSE
                and draft.get("operation_id") == plan["operation_id"] and draft.get("origin") == plan["origin"]
                and draft.get("source_sha") == plan["baseline"]["web"]["source_sha"]
                and draft.get("readyToApply") is False and draft.get("productionPlan") is False
                and draft.get("legacyResumeAllowed") is False, "handoff-draft")
        originals = draft.get("originals")
        fields(originals, ("compose", "env", "backup_config", "active_release", "autodeploy_current"), "handoff-draft")
        for pin in originals.values():
            switch.file_pin(pin)
            require(pin in plan["files"], "handoff-draft")
        require(len({pin["path"] for pin in originals.values()}) == len(originals), "handoff-draft")
        receipt = values["prepared.json"]
        targets = prepared_pins(receipt, plan, hashes["stage-plan.json"])
        pending = values["pending.json"]
        partial = closed_journal(pending, values["legacy-barrier.json"], values["stage-inspection.json"],
                                 hashes, plan, receipt, targets, originals)
        captured = observe(values["observation.json"], hashes, plan, pending, targets, originals, now)
        if partial:
            adopt_audit(files, hashes, pending, receipt, captured)
        else:
            require(not set(ADOPT_FILES).intersection(files), "handoff-adopt-audit")
    except (OSError, ValueError, TypeError, KeyError, stage.StageError, switch.WebSwitchError):
        raise HandoffError("handoff-invalid-evidence") from None
    return {
        "version": 1, "purpose": PURPOSE, "status": "reviewed-closed-not-authorized",
        "operation_id": plan["operation_id"], "evidence_sha256": hashes,
        "observed_at": captured, "review_expires_at": captured + MAX_AGE,
        "first_upstream_port": 3000, "canary_port": 3001,
        "legacy_barrier_retained": True, "legacy_resume_allowed": False,
        "canonical_action": "retain-existing-compose-env-backup-config-active-current",
        "next_review": ["recheck-live-pins-under-shared-locks", "install-ingress-and-archive-while-closed",
                        "verify-tls-keepalive-and-both-slots", "reconcile-active-state-and-barriers",
                        "authorize-traffic-and-fresh-v2-plan-separately"],
        "return_review": ["preserve-legacy-nginx-symlink-and-target-bytes",
                          "restore-old-api-policy-and-proxy-cidr-only-under-separate-closed-approval",
                          "collect-fresh-legacy-pins-before-resume"],
        "provenance": "operator-supplied-not-live-attestation",
        "runtimeChanged": False, "productionPlan": False, "readyToApply": False,
        "deploymentAuthorization": False, "serverAccess": False,
    }


def local_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns)


def read_local(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and 0 < info.st_size <= stage.MAX_JSON, "handoff-input-path")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        identity = local_identity(info)
        require(local_identity(os.fstat(stream.fileno())) == identity, "handoff-input-path")
        raw = stream.read(stage.MAX_JSON + 1)
        require(len(raw) == info.st_size and local_identity(os.fstat(stream.fileno())) == identity,
                "handoff-input-path")
    return raw


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if args in ([], ["--plan"]):
        print(switch.wire({"purpose": PURPOSE, "inputs": list(FILES), "inputsForAdoptedJournal": list(ADOPT_FILES),
                           "serverAccess": False,
                           "readyToApply": False, "deploymentAuthorization": False}).decode(), end="")
        return 0
    try:
        require(len(args) == 2 and args[0] == "--review", "handoff-arguments")
        root = Path(args[1])
        require(root.is_dir() and not root.is_symlink(), "handoff-input-path")
        names = FILES + ADOPT_FILES if any(os.path.lexists(root / name) for name in ADOPT_FILES) else FILES
        files = {name: read_local(root / name) for name in names}
        print(switch.wire(review_handoff(files, now=int(time.time()))).decode(), end="")
        return 0
    except (HandoffError, OSError) as error:
        code = str(error) if isinstance(error, HandoffError) else "handoff-input-path"
        print(switch.wire({"error": code}).decode(), end="", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
