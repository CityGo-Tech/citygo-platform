"""Real locked-ingress verifier rehearsal inside the owned runtime-stage DinD host."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from uuid import uuid4

import web_bootstrap_ingress_locked as locked
import web_bootstrap_ingress_transaction as transaction
import web_bootstrap_ingress_witness as witness
import web_runtime_stage as stage
import web_switch as switch

ORIGIN = "https://runtime-stage.example.test"
BASELINE_TOKEN = switch.digest(b"isolated runtime-stage baseline witness")


def fixture_only():
    if (not __debug__ or not sys.platform.startswith("linux") or os.geteuid() != 0
            or Path(__file__).parent != Path("/opt/citygo-controller-fixture")
            or not Path("/evidence").is_dir()):
        raise RuntimeError("isolated runtime-stage fixture required")


def replace_file(path, raw):
    fd, temporary = tempfile.mkstemp(prefix=".ingress-fixture-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        switch.b.sync_directory(path.parent)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def setup_closed_ingress():
    """Admit a fixed witness include into the fixture before staging snapshots."""
    fixture_only()
    Path(witness.WITNESS_SOCKET).parent.mkdir(mode=0o700)
    locked.WITNESS.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    assert not os.path.lexists(locked.WITNESS)
    replace_file(locked.WITNESS, witness.render_witness(BASELINE_TOKEN))


class FixtureIngress(locked.IngressObservation):
    """The only mutating adapter here belongs to the disposable harness."""
    def __init__(self, operation, review, legacy, candidate, target, plan):
        pid = int(Path("/run/nginx.pid").read_text())
        super().__init__((pid, self.process(pid)["starttime"]))
        self.master = (pid, self.value["nginx"]["master"]["starttime"])
        self.boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")
        self.runtime = stage.Host(plan)
        self.legacy = legacy
        self.candidate = candidate
        self.target = target
        self.hups = 0
        self.tokens = {
            "baseline": BASELINE_TOKEN,
            "install": witness.epoch_token(operation=operation, direction="install",
                                           site_sha256=switch.digest(candidate), review_sha256=review),
            "restore": witness.epoch_token(operation=operation, direction="restore",
                                           site_sha256=switch.digest(legacy), review_sha256=review),
        }

    def file_profile(self):
        assert switch.read_protected(locked.LEGACY) == self.legacy
        if locked.ENABLED.is_symlink():
            assert os.readlink(locked.ENABLED) == self.target
            return "legacy"
        assert switch.read_protected(locked.ENABLED) == self.candidate
        return "switch"

    def observe_closed(self):
        self.runtime.closed(ORIGIN)
        profile = self.file_profile()
        token = witness.read_epoch(witness.WITNESS_SOCKET, master_pid=self.master[0], owner_uid=0)
        allowed = {"install": "switch", "restore": "legacy", "baseline": "legacy"}
        loaded, = [allowed[direction] for direction, expected in self.tokens.items() if token == expected]
        workers = frozenset((item["pid"], item["starttime"]) for item in self.processes())
        return transaction.Epoch(profile, loaded, self.boot, self.master, workers)

    def replace_link(self, origin, destination):
        assert self.file_profile() == origin
        if destination == "switch":
            replace_file(locked.ENABLED, self.candidate)
        else:
            temporary = locked.ENABLED.with_name(".ingress-fixture-" + uuid4().hex)
            try:
                temporary.symlink_to(self.target)
                temporary.replace(locked.ENABLED)
                switch.b.sync_directory(locked.ENABLED.parent)
            finally:
                if os.path.lexists(temporary):
                    temporary.unlink()
        assert self.file_profile() == destination

    def prepare_witness(self, origin, destination):
        assert transaction.PROFILES[self.direction] == (origin, destination)
        replace_file(locked.WITNESS, witness.render_witness(self.tokens[self.direction]))

    def test_config(self):
        self.nginx_test()

    def check_prepared(self, destination):
        assert self.file_profile() == destination
        assert switch.read_protected(locked.WITNESS) == witness.render_witness(self.tokens[self.direction])

    def hup(self):
        super().hup()
        self.hups += 1

    def wait_for_workers(self, before):
        old = {tuple(item) for item in before["workers"]}
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            observed = self.observe_closed()
            if observed.workers and not old & observed.workers and observed.loaded == observed.link:
                return
            time.sleep(0.025)
        raise AssertionError("fixture Nginx did not converge to the expected generation")


class LostReloadReply(Exception):
    pass


def lose_hup_reply(checkpoint):
    if checkpoint == "hup-sent":
        raise LostReloadReply()


def rehearse_locked_ingress(operation, plan, origin):
    fixture_only()
    assert origin == plan["origin"] == ORIGIN and plan["operation_id"] == operation
    legacy = switch.read_protected(locked.LEGACY)
    target = os.readlink(locked.ENABLED)
    site_end = legacy.rindex(b"}")
    # The synthetic candidate remains closed even if the private test location
    # is requested. Nginx still reads its distinct initial upstream include.
    candidate = (legacy[:site_end] + b"\nlocation = /__fixture_locked_ingress { internal; include "
                 + os.fsencode(locked.UPSTREAM) + b"; }\n" + legacy[site_end:])
    stage_plan_path = stage.STATE_ROOT / ("plan-" + operation + ".json")
    pending_path = stage.STATE_ROOT / "pending.json"
    prepared_path = stage.STATE_ROOT / ("prepared-" + operation + ".json")
    barrier_path = stage.COORDINATION_ROOT / "operation-pending.json"
    originals = {path: stage.read(path, private=True) for path in (stage_plan_path, pending_path, prepared_path, barrier_path)}
    review = switch.digest(originals[stage_plan_path] + b"fixture ingress review")
    ingress = FixtureIngress(operation, review, legacy, candidate, target, plan)
    locked.UPSTREAM.parent.mkdir(parents=True, exist_ok=True)
    assert not os.path.lexists(locked.UPSTREAM)
    replace_file(locked.UPSTREAM, switch.upstream(3000))
    proof_path = stage.STATE_ROOT / ("fixture-locked-ingress-" + operation + ".json")
    install_path = stage.STATE_ROOT / ("ingress-" + operation + "-install.json")

    def write_proof(direction, journal_path):
        now = int(time.time())
        proof = {"version": 1, "purpose": locked.PURPOSE, "operation_id": operation, "direction": direction,
                 "observed_at": now, "expires_at": now + 120, "legacy_link_target": target,
                 "review_sha256": review, "legacy_sha256": switch.digest(legacy),
                 "candidate_sha256": switch.digest(candidate),
                 "stage_plan_sha256": switch.digest(originals[stage_plan_path]),
                 "stage_pending_sha256": switch.digest(originals[pending_path]),
                 "prepared_sha256": switch.digest(originals[prepared_path]),
                 "transition_sha256": switch.digest(stage.read(journal_path, private=True)),
                 "install_journal_sha256": (switch.digest(stage.read(install_path, private=True))
                                             if direction == "restore" else None),
                 "nginx_dump_sha256": switch.digest(ingress.capture(["/usr/sbin/nginx", "-T"]))}
        switch.b.atomic_json(proof_path, proof)

    reports = {}
    for expected_hups, direction in enumerate(("install", "restore"), start=1):
        ingress.direction = direction
        journal_path = stage.STATE_ROOT / ("ingress-" + operation + "-" + direction + ".json")
        args = {"operation": operation, "review_sha256": review, "direction": direction, "host": ingress}
        with stage._locked(readonly=True) as namespace:
            namespace()
            try:
                transaction.transition(journal_path, checkpoint=lose_hup_reply, **args)
            except LostReloadReply:
                pass
            else:
                raise AssertionError("fixture did not lose the HUP reply")
            namespace()
        raw = stage.read(journal_path, private=True)
        pending = json.loads(raw)
        assert pending["phase"] == "hup-intent" and ingress.hups == expected_hups
        ingress.wait_for_workers(pending["before"])
        write_proof(direction, journal_path)
        observed = locked.verify_locked(proof_path)
        assert observed["status"] == "observed-closed-hup-receipt-pending"
        assert stage.read(journal_path, private=True) == raw

        with stage._lock(stage.COORDINATION_ROOT, "maintenance.lock", readonly=True):
            try:
                locked.verify_locked(proof_path)
            except stage.StageError as exc:
                assert str(exc) == "runtime-stage-already-running"
            else:
                raise AssertionError("locked verifier bypassed the held maintenance lock")

        workers = ingress.processes()
        with stage._locked(readonly=True) as namespace:
            namespace()
            assert transaction.transition(journal_path, resume=True, **args)["phase"] == "verified-closed"
            namespace()
        assert ingress.hups == expected_hups and ingress.processes() == workers, "resume unexpectedly reloaded Nginx"
        write_proof(direction, journal_path)
        reports[direction] = locked.verify_locked(proof_path)
        assert reports[direction]["status"] == "verified-closed"
        assert reports[direction]["ready_to_open"] is False
        assert reports[direction]["legacy_barrier_retained"] is True

    assert locked.ENABLED.is_symlink() and os.readlink(locked.ENABLED) == target
    assert switch.read_protected(locked.LEGACY) == legacy
    assert all(stage.read(path, private=True) == raw for path, raw in originals.items())
    ingress.runtime.closed(origin)
    return dict(reports, lockRefusal=True, lostHupObservedWithoutReplay=True, restoredExactLegacyLink=True)
