"""CI-only graceful stop/start drill; NEVER a server operator or reboot command."""
import copy
import os
from pathlib import Path
import tempfile
import time

import backup as b
import finish as f
import prepare as p
import start as s
import target as t
import worker as w
from test_backup import MemoryStore

GRACE = {"api": 330, "web": 30, "postgres": 60}


def fixture_scope(config, origin):
    b.require(t.matches(config.get("project"), r"citygo-pilot-test-[0-9a-f]{12}")
              and config.get("source_sha") == "c" * 40
              and origin == "https://pilot.example.test", "disposable-required")


def same_container(before, after):
    # A new process is intended, a replacement container/image/runtime is not.
    a, z = p.identity(before), p.identity(after)
    a.pop("started_at"); z.pop("started_at")
    b.require(a == z and before["Labels"] == after["Labels"], "restart-fixture-replaced")


def stopped(before, after):
    same_container(before, after)
    b.require(before["State"]["Running"] is True
              and before["State"]["StartedAt"] == after["State"]["StartedAt"], "restart-fixture-process")
    p.stopped_cleanly(after)
    b.require(after["State"].get("Dead", False) is False, "restart-fixture-dead")


def restarted(stopped_value, after, *, ready=True):
    same_container(stopped_value, after)
    state = after["State"]
    b.require(state.get("Running") is True and state.get("Status") == "running"
              and all(state.get(k) is False for k in ("Paused", "Restarting", "OOMKilled"))
              and state.get("Dead", False) is False and state.get("Error") == "", "restart-fixture-unhealthy")
    b.require(w.timestamp(state["StartedAt"]) > w.timestamp(stopped_value["State"]["FinishedAt"]), "restart-fixture-process")
    health = state.get("Health", {}).get("Status")
    b.require(health == "healthy" if ready else health in ("starting", "healthy"), "restart-fixture-unhealthy")


def cycle(host, containers, check):
    """Only exact verified fixture IDs, stop evidence BEFORE start, no retry."""
    targets = {v["Labels"]["com.docker.compose.service"]: v for v in containers.values()
               if v["Labels"]["com.docker.compose.service"] in GRACE}
    b.require(set(targets) == set(GRACE), "restart-fixture-targets")
    exits, starts = {}, {}
    for role in ("api", "web", "postgres"):
        check()
        value = targets[role]
        current = host.inspect(value["Id"])
        b.require(p.evidence(current) == p.evidence(value), "restart-fixture-changed")
        host.capture(["stop", "--timeout", str(GRACE[role]), value["Id"]], timeout=GRACE[role] + 30)
        after = host.inspect(value["Id"])
        stopped(value, after)  # SIGKILL/nonzero exit aborts BEFORE any restart.
        exits[role] = after
    check()  # All services down, ingress must STILL return the maintenance contract.
    for role in ("postgres", "api", "web"):
        value = exits[role]
        b.require(p.evidence(host.inspect(value["Id"])) == p.evidence(value), "restart-fixture-changed")
        check()
        host.capture(["start", value["Id"]], timeout=30)
        deadline = time.monotonic() + 120
        while True:
            after = host.inspect(value["Id"])
            restarted(value, after, ready=False)
            if after["State"]["Health"]["Status"] == "healthy": break
            b.require(time.monotonic() < deadline, "restart-fixture-timeout")
            time.sleep(0.25)
        restarted(value, after)
        starts[role] = after
        check()
    return exits, starts


def rehearse(directory, fixture, config, plan, images, host_factory, api_file):
    fixture_scope(config, fixture["origin"])
    state = b.protected(config["state_dir"], directory=True)
    b.require(state.is_relative_to(directory) and plan["directory"].is_relative_to(directory), "disposable-required")
    active = f.active_release(config)  # Commit history, NOT fresh runtime evidence.
    b.require(active["restart_authorized"] is False, "fixture-restart-authority")
    # No production approval is created. This exact random disposable harness is
    # already authorized to destroy its synthetic DB/containers after the test.
    with b.lock(state), b.lock(state, "worker-admission.lock"), tempfile.TemporaryDirectory(prefix="restart-client-", dir=directory) as tmp:
        host = host_factory(config, Path(tmp), fixture["ingress_directory"], fixture["origin"])
        before = host.inventory()
        jobs = [p.evidence(v) for v in before if v["Labels"]["com.docker.compose.service"] not in GRACE]
        initial = p.validate_inventory(before, config["project"], fixture["images"], initial=True, retained_jobs=jobs)
        files = {path: t.read_file(path) for path in state.glob("*.json")}
        networks = {"database": host.database_network()["id"], "web_api": host.web_network()["id"]}
        pg = next(v for v in before if v["Labels"]["com.docker.compose.service"] == "postgres")
        mounts = host.detail(pg["Id"])["Mounts"]
        data = [v for v in mounts if v["Destination"] == "/var/lib/postgresql/data"]
        b.require(len(data) == 1 and data[0]["Type"] == "volume" and data[0]["Name"] == config["project"] + "_database"
                  and data[0]["RW"] is True, "restart-fixture-volume")

        def check():
            b.assert_current_config(config); b.assert_operation_idle(state)
            b.require(not os.path.lexists(state / w.ADMISSION), "restart-fixture-worker-open")
            host.assert_closed(); f.verify_generation(plan)
            values = host.inventory()
            b.require({v["Id"] for v in values} == set(initial) and len(values) == len(initial), "restart-fixture-inventory")
            p.check_retained(values, config["project"], jobs)
            b.require(set(state.glob("*.json")) == set(files)
                      and all(t.read_file(path) == raw for path, raw in files.items()), "restart-fixture-history")

        check()
        for v in before:
            role = v["Labels"]["com.docker.compose.service"]
            if role in ("api", "web"):
                s.runtime(host.detail(v["Id"]), role, images["target"][role], config["project"], fixture["origin"], api_file, networks)
        exits, starts = cycle(host, initial, check)
        final = p.validate_inventory(host.inventory(), config["project"], fixture["images"], initial=True, retained_jobs=jobs)
        b.require(host.detail(pg["Id"])["Mounts"] == mounts, "restart-fixture-volume")
        p.check_network(host.database_network(), final, {"id": networks["database"]})
        web = host.web_network()
        b.require(web["id"] == networks["web_api"] and set(web["peers"]) == {starts[r]["Id"] for r in ("api", "web")}, "restart-fixture-network")
        for role in ("api", "web"):
            s.runtime(host.detail(starts[role]["Id"]), role, images["target"][role], config["project"], fixture["origin"], api_file, networks)
        host.probe(); check()
        # A pre-restart process receipt MUST NOT pass a same-process recovery gate.
        try: p.same_inventory(initial, final)
        except b.BackupError as error: b.require(str(error) == "container-replaced", "restart-fixture-negative-control")
        else: raise b.BackupError("restart-fixture-stale-evidence-accepted")
        proof = {role: {"id": starts[role]["Id"], "before": initial[starts[role]["Id"]]["State"]["StartedAt"],
                        "stopped": exits[role]["State"]["FinishedAt"], "after": starts[role]["State"]["StartedAt"]} for role in GRACE}
    b.require(f.active_release(config) == active, "restart-fixture-history")
    store = MemoryStore()
    backup = b.perform_backup(config, storage_factory=lambda *_: store)
    b.require(backup["source_sha"] == "c" * 40 and len(store.objects) == 2, "restart-fixture-backup")
    return {"closed_restart_verified": True, "restart_processes": copy.deepcopy(proof),
            "restart_backup_verified": True, "stale_process_evidence_rejected": True}
