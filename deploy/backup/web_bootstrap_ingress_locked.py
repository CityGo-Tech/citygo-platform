"""Manual, read-only verification of a staged Web ingress reload or rollback."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

import web_bootstrap_ingress_transaction as transaction
import web_bootstrap_ingress_witness as witness
import web_runtime_stage as stage
import web_switch as switch

PURPOSE = "citygo-locked-web-ingress-proof-v1"
NGINX = Path("/etc/nginx/nginx.conf")
ENABLED = Path("/etc/nginx/sites-enabled/citygo-pilot")
LEGACY = Path("/etc/nginx/sites-available/citygo-pilot")
WITNESS = Path("/etc/nginx/conf.d/citygo-closed-epoch.conf")
UPSTREAM = Path("/var/lib/citygo/ingress/web-upstream.conf")
LEGACY_TARGETS = (str(LEGACY), "../sites-available/citygo-pilot")
HASHES = {"review_sha256", "stage_plan_sha256", "stage_pending_sha256", "prepared_sha256",
          "transition_sha256", "legacy_sha256", "candidate_sha256", "nginx_dump_sha256"}
FIELDS = {"version", "purpose", "operation_id", "direction", "observed_at", "expires_at",
          "legacy_link_target", "install_journal_sha256", *HASHES}


class LockedIngressError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise LockedIngressError(reason)


def parse_proof(raw, now):
    value = switch.strict_json(raw)
    require(type(value) is dict and set(value) == FIELDS
            and type(value["version"]) is int and value["version"] == 1 and value["purpose"] == PURPOSE
            and switch.matches(value["operation_id"], r"[a-f0-9]{32}")
            and value["direction"] in ("install", "restore")
            and value["legacy_link_target"] in LEGACY_TARGETS
            and all(switch.matches(value[key], switch.HEX) for key in HASHES), "proof-shape")
    require(type(value["observed_at"]) is int and type(value["expires_at"]) is int
            and 0 < value["observed_at"] <= now < value["expires_at"] <= value["observed_at"] + 120,
            "proof-expired")
    previous = value["install_journal_sha256"]
    require((previous is None if value["direction"] == "install" else switch.matches(previous, switch.HEX)),
            "rollback-binding")
    return value


def confirm_generation(record, epoch, prior=None):
    direction = record["binding"]["direction"]
    destination = transaction.PROFILES[direction][1]
    before = record["before"]
    require(record["phase"] in ("hup-intent", "verified-closed"), "reload-intent-missing")
    require(type(epoch) is transaction.Epoch and transaction.valid_pins(epoch.pins())
            and transaction.converged(epoch, before, destination), "reload-unconfirmed")
    if direction == "restore":
        require(prior is not None and prior["phase"] == "verified-closed"
                and prior["binding"] == dict(record["binding"], direction="install"), "rollback-binding")
        install_before, install_after = prior["before"], prior["after"]
        require(transaction.valid_pins(install_before) and transaction.valid_pins(install_after)
                and all(install_before[key] == install_after[key] == before[key] for key in ("boot_id", "master"))
                and not {tuple(pin) for pin in install_before["workers"]}
                        & {tuple(pin) for pin in install_after["workers"]}, "rollback-binding")
    else:
        require(prior is None, "rollback-binding")
    if record["phase"] == "verified-closed":
        require(epoch.pins() == record["after"], "final-epoch-changed")
        return "verified-closed"
    return "observed-closed-hup-receipt-pending"


class IngressObservation(switch.Host):
    """Reuse the existing fixed Nginx master and worker checks. No signals."""
    def __init__(self, master):
        self.value = {"nginx": {"master": {"pid": master[0], "starttime": master[1]}}}
        self.env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": str(stage.STATE_ROOT), "LANG": "C.UTF-8"}

    def closed_epoch(self, proof, before):
        def pins():
            return frozenset((worker["pid"], worker["starttime"]) for worker in self.processes())

        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")
        workers = pins()
        direction = proof["direction"]
        site_hash = proof["candidate_sha256" if direction == "install" else "legacy_sha256"]
        token = witness.epoch_token(operation=proof["operation_id"], direction=direction,
                                    site_sha256=site_hash, review_sha256=proof["review_sha256"])
        self.pinned_files(proof, token)
        observed = witness.read_epoch(witness.WITNESS_SOCKET, master_pid=before["master"][0], owner_uid=0)
        require(observed == token and workers == pins(), "witness-generation-changed")
        self.pinned_files(proof, token)
        destination = transaction.PROFILES[direction][1]
        return transaction.Epoch(destination, destination, boot, tuple(before["master"]), workers)

    def pinned_files(self, proof, token):
        switch.protected(ENABLED.parent, directory=True)
        switch.protected(Path(witness.WITNESS_SOCKET).parent, directory=True, private=True)
        require(switch.digest(switch.read_protected(LEGACY)) == proof["legacy_sha256"], "legacy-site-changed")
        if proof["direction"] == "install":
            require(switch.digest(switch.read_protected(ENABLED)) == proof["candidate_sha256"], "candidate-site-changed")
        else:
            enabled = ENABLED.lstat()
            require(stat.S_ISLNK(enabled.st_mode) and enabled.st_uid == 0 and enabled.st_nlink == 1
                    and os.readlink(ENABLED) == proof["legacy_link_target"], "legacy-link-changed")
        require(switch.read_protected(WITNESS) == witness.render_witness(token), "witness-file-changed")
        require(switch.read_protected(UPSTREAM) == switch.upstream(3000), "initial-upstream-changed")

    def verify_nginx_sources(self, proof):
        raw = self.capture(["/usr/sbin/nginx", "-T"])
        require(switch.digest(raw) == proof["nginx_dump_sha256"], "nginx-dump-changed")
        paths = {Path(item.decode("utf-8")) for item in re.findall(rb"(?m)^# configuration file (/[^:\n]+):[ \t]*$", raw)}
        includes_upstream = proof["direction"] == "install"
        require({NGINX, ENABLED, WITNESS} <= paths and (UPSTREAM in paths) == includes_upstream,
                "nginx-file-allowlist")
        for path in paths - {ENABLED}:
            switch.protected(path)
        policy = re.sub(rb"#[^\n]*", b"", raw)
        shutdown = re.findall(rb"\bworker_shutdown_timeout\s+([^;{}]+);", policy)
        require(all(value.strip() in (b"0", b"0ms", b"0s") for value in shutdown),
                "nginx-forced-worker-timeout")


def verify_locked(proof_path, *, now=None, _runtime=None, _nginx=None):
    stage._platform()
    for module in (sys.modules[__name__], transaction, witness):
        stage.read(module.__file__)
    clock = (lambda: int(time.time())) if now is None else (lambda: now)

    # Runtime-stage acquires the same maintenance and worker-admission locks
    # used by backup and Web switching, then its stage lock. Never reacquire
    # those locks via inspect_stage() or web_switch.Host.locked().
    with stage._locked(readonly=True) as namespace:
        namespace()
        proof_raw = stage.read(proof_path, private=True)
        proof = parse_proof(proof_raw, clock())
        operation, direction = proof["operation_id"], proof["direction"]
        root = stage.STATE_ROOT
        plan_path = root / ("plan-" + operation + ".json")
        pending_path = root / "pending.json"
        prepared_path = root / ("prepared-" + operation + ".json")
        journal_path = root / ("ingress-" + operation + "-" + direction + ".json")
        immutable = {plan_path: proof["stage_plan_sha256"], pending_path: proof["stage_pending_sha256"],
                     prepared_path: proof["prepared_sha256"], journal_path: proof["transition_sha256"]}
        install_path = root / ("ingress-" + operation + "-install.json")
        if direction == "restore":
            immutable[install_path] = proof["install_journal_sha256"]
        evidence = {path: stage.read(path, private=True) for path in immutable}
        require(all(switch.digest(raw) == immutable[path] for path, raw in evidence.items()), "evidence-pin-changed")
        pending, pending_raw = stage._journal()
        require(pending_raw == evidence[pending_path] and pending["phase"] == "prepared-closed"
                and pending["operation_id"] == operation and pending["plan_sha256"] == proof["stage_plan_sha256"],
                "stage-pending-changed")
        plan = stage.validate_plan(evidence[plan_path], pending["started_at"])
        require(plan["operation_id"] == operation, "stage-plan-changed")
        draft = stage.load_draft(plan, pending["started_at"])
        binding = {"operation": operation, "review_sha256": proof["review_sha256"], "direction": direction}
        record = transaction.parse_record(evidence[journal_path], binding)
        prior = (transaction.parse_record(evidence[install_path], dict(binding, direction="install"))
                 if direction == "restore" else None)
        require(record["phase"] in ("hup-intent", "verified-closed"), "reload-intent-missing")
        runtime = stage.Host(plan) if _runtime is None else _runtime
        nginx = IngressObservation(record["before"]["master"]) if _nginx is None else _nginx

        def recheck():
            namespace()
            require(stage.read(proof_path, private=True) == proof_raw
                    and all(stage.read(path, private=True) == raw for path, raw in evidence.items()), "evidence-pin-changed")
            parse_proof(proof_raw, clock())
            stage._files(plan, draft)
            stage._barrier(pending)
            runtime.closed(plan["origin"])

        recheck()
        targets = stage._desired(runtime, plan, draft, pending)
        stage._validate_receipt(evidence[prepared_path], plan, pending, targets)
        recheck()
        epoch = nginx.closed_epoch(proof, record["before"])
        status = confirm_generation(record, epoch, prior)
        nginx.verify_nginx_sources(proof)
        recheck()
        require(nginx.closed_epoch(proof, record["before"]) == epoch, "witness-generation-changed")
        recheck()
        return {"version": 1, "purpose": PURPOSE, "operation_id": operation, "direction": direction,
                "status": status, "proof_sha256": switch.digest(proof_raw),
                "transition_sha256": proof["transition_sha256"], "traffic_opened": False,
                "legacy_barrier_retained": True, "ready_to_open": False}


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        if args in ([], ["--plan"]):
            print(json.dumps({"purpose": PURPOSE, "writes": False, "ready_to_open": False}, sort_keys=True))
            return 0
        require(len(args) == 3 and args[:2] == ["verify", "--proof"], "arguments")
        print(json.dumps(verify_locked(args[2]), sort_keys=True))
        return 0
    except (LockedIngressError, stage.StageError, transaction.TransitionError, witness.WitnessError,
            switch.WebSwitchError, OSError, TypeError, ValueError):
        print('{"error":"locked-ingress-verification-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
