"""Freshly approved commit-only recovery of an already verified closed release.

Never restart/recreate containers, rerun DDL, restore a DB, change configuration,
open admission, upload or clear an unknown pending operation. Old receipts are
evidence, not authority: a NEW independent one-hour approval is mandatory.
"""
import copy
import os
from pathlib import Path
import tempfile
import time
import uuid

import backup as b
import control as ctl
import finish as f
import image_gate as g
import migrate as c
import migration_job as m
import prepare as p
import start as s
import target as t
import worker as w


def historical(parser, raw):
    value = t.strict_json(raw)
    b.require(type(value) is dict and type(value.get("approved_at")) is int, "recovery-history")
    # Validate the original schema/bindings, NOT current permission. Expiry of old
    # approvals is expected after a crash; only the fresh recovery approval grants
    # the narrow settle action. Removed/changed historical evidence fails closed.
    return parser(raw, value["approved_at"])


def pending(value):
    t.keys(value, {"version", "operation", "id", "configuration_sha256", "target_sha"}, "recovery-pending")
    b.require(type(value["version"]) is int and value["version"] == 1 and value["operation"] == "release"
              and t.matches(value["id"], r"[0-9a-f]{32}") and t.matches(value["target_sha"], t.SHA)
              and t.matches(value["configuration_sha256"], t.HASH), "recovery-pending")
    return value


def _observe(request_path, config, *, host_factory=s.Host, image_store_factory=g.Store):
    """Caller owns BOTH locks. No container/config/DB writes; temporary client HOME only."""
    request, request_raw = ctl.request(request_path)
    b.require(Path(request["config_path"]) == config._binding.path, "recovery-config-path")
    b.assert_current_config(config)
    state = b.protected(config["state_dir"], directory=True)
    b.require(not os.path.lexists(state / w.ADMISSION), "worker-not-paused")
    files = {}
    def read(path):
        path = Path(path)
        raw = t.read_file(path, private=True)
        b.require(path not in files or files[path] == raw, "recovery-evidence-changed")
        files[path] = raw
        return t.strict_json(raw)
    operation = pending(read(state / "operation-pending.json"))
    ident = operation["id"]
    b.require(operation["target_sha"] == request["target_sha"] == config["source_sha"], "recovery-before-cutover")
    active = read(state / f.ACTIVE)
    t.keys(active, {"version", "kind", "operation_id", "source_sha", "configuration_sha256", "generation_sha256",
                   "approval_sha256", "startup", "traffic_authorized", "worker_authorized", "restart_authorized"}, "recovery-active")
    b.require(type(active["version"]) is int and active["version"] == 1 and active["kind"] == "closed-release"
              and active["operation_id"] == ident and active["source_sha"] == config["source_sha"]
              and all(active[k] is False for k in ("traffic_authorized", "worker_authorized", "restart_authorized")), "recovery-active")
    for key in ("configuration_sha256", "generation_sha256", "approval_sha256"):
        b.require(t.matches(active[key], t.HASH), "recovery-active")
    previous_path = state / ("finish-" + ident + ".previous.json")
    previous = b.validate(read(previous_path))  # Historical values only; NEVER execute with this unbound dictionary.
    b.require(previous["state_dir"] == config["state_dir"] and previous["project"] == config["project"]
              and b.configuration_fingerprint(previous) == operation["configuration_sha256"], "recovery-previous")
    prepared = read(state / "release-prepared.json")
    migrated = read(state / ("migration-" + ident + ".success.json"))
    startup = read(state / ("start-" + ident + ".success.json"))
    for value in (prepared, migrated, startup):
        b.require(value.get("version") == 1 and value.get("operation_id") == ident
                  and value.get("target_sha") == config["source_sha"], "recovery-operation-binding")
    b.require(active["startup"] == startup and startup["traffic_authorized"] is False
              and startup["worker_authorized"] is False and migrated["traffic_authorized"] is False
              and migrated["result"]["committed"] is True and prepared["migration_authorized"] is False,
              "recovery-checkpoints")
    b.require(prepared["origin"] == request["origin"] and prepared["ingress_directory"] == request["ingress_directory"], "recovery-origin")
    history = {}
    for key, parser in (("preparation_approval", t.approval), ("migration_approval", c.approval),
                        ("startup_approval", s.approval), ("finish_approval", f.approval)):
        read(request[key]); history[key] = historical(parser, files[Path(request[key])])
    hashes = {k: t.sha256(files[Path(request[k])]) for k in history}
    pa, ma, sa, fa = (history[k] for k in ("preparation_approval", "migration_approval", "startup_approval", "finish_approval"))
    b.require(pa["target_sha"] == config["source_sha"] and pa["configuration_sha256"] == operation["configuration_sha256"]
              and pa["origin"] == request["origin"] and pa["project"] == config["project"]
              and ma["preparation_sha256"] == hashes["preparation_approval"]
              and ma["configuration_sha256"] == operation["configuration_sha256"]
              and ma["target_manifest_sha256"] == pa["target_manifest_sha256"]
              and ma["project"] == config["project"] and ma["origin"] == request["origin"]
              and sa["migration_approval_sha256"] == hashes["migration_approval"]
              and fa["startup_approval_sha256"] == hashes["startup_approval"]
              and startup["approval_sha256"] == hashes["startup_approval"]
              and fa["config_file_sha256"] == t.sha256(files[previous_path])
              and fa["config_path"] == request["config_path"]
              and fa["generation_sha256"] == active["generation_sha256"]
              and active["approval_sha256"] == hashes["finish_approval"], "recovery-history-binding")
    current = t.bundle(Path(request["current_bundle"]), pa["current_manifest_sha256"], current=True)
    target = t.bundle(Path(request["target_bundle"]), pa["target_manifest_sha256"], current=True)
    b.require({"deploy/backup/start.py", "deploy/backup/finish.py"} <= {entry["path"] for entry in target["runtimeFiles"]}, "recovery-profile-history")
    b.require(current["sourceSha"] == previous["source_sha"] and target["sourceSha"] == config["source_sha"]
              and target["releaseId"] == pa["target_release_id"]
              and target["migrations"][:len(current["migrations"])] == current["migrations"]
              and target["bases"]["postgres"] == current["bases"]["postgres"], "recovery-manifests")
    selected = {"current": {"images": current["images"], "image_ids": current["imageIds"],
                           "source_sha": current["sourceSha"], "postgres": current["bases"]["postgres"]},
                "images": target["images"], "image_ids": target["imageIds"], "target_sha": target["sourceSha"]}
    local = g.verify(image_store_factory(state), selected, pa["current_images"])
    b.require(local == prepared["local_images"], "recovery-image-evidence")
    migration_plan = {"version": 1, "kind": "citygo-release-migration", "operationId": str(uuid.UUID(ident)),
                      "targetSha": config["source_sha"], "currentMigrations": current["migrations"],
                      "targetMigrations": target["migrations"],
                      "grantsSha256": next(e["sha256"] for e in target["runtimeFiles"] if e["path"] == "deploy/postgres/grants.sql")}
    migration_request = m.request(migration_plan, operation)
    b.require(migrated["request_sha256"] == t.sha256(migration_request)
              and migrated["image"] == local["target"]["jobs"], "recovery-migration-binding")
    m.result(m.wire(migrated["result"]), migration_plan, migration_request)
    plan = f.generation(previous, config["source_sha"], request["origin"], local,
                        request["api_secret"], request["worker_secret"], request["backup_secret"], sa["profile"])
    f.verify_generation(plan)
    b.require(plan["config"] == config and plan["sha256"] == active["generation_sha256"]
              and plan["configuration_sha256"] == active["configuration_sha256"] == b.configuration_fingerprint(config)
              and plan["secrets"][request["api_secret"]] == sa["api_secret_sha256"], "recovery-generation")
    used = read(state / ("finish-approval-" + hashes["finish_approval"] + ".used.json"))
    b.require(used == {"version": 1, "operation_id": ident, "approval_sha256": hashes["finish_approval"],
                       "old_config_sha256": fa["config_file_sha256"], "generation_sha256": plan["sha256"]}, "recovery-finish-reservation")
    baseline = {v["id"]: v for v in prepared["containers"] if v["role"] not in ("api", "web")}
    b.require(len(baseline) >= 1 and sum(v["role"] == "postgres" for v in baseline.values()) == 1, "recovery-baseline")
    networks = {"database": ma["network_id"], "web_api": sa["web_network_id"]}
    b.require(prepared["database_network"]["id"] == networks["database"], "recovery-network")
    def runtime(host):
        host.assert_closed()
        values = host.inventory()
        p.check_retained(values, config["project"], pa.get("retained_jobs", []))
        by_id = {v["Id"]: v for v in values}
        app_ids = {v["id"] for v in startup["apps"].values()}
        b.require(len(by_id) == len(values) and set(by_id) == set(baseline) | app_ids | {migrated["container_id"]}, "recovery-container-set")
        for cid, expected in baseline.items():
            v = by_id[cid]
            b.require(p.evidence(v) == expected and v["Labels"].get("com.docker.compose.project") == config["project"], "recovery-baseline-changed")
            b.require(v["State"]["Running"] is (expected["status"] == "running")
                      and not any(v["State"].get(k) for k in ("Paused", "Restarting", "OOMKilled", "Dead")), "recovery-baseline-changed")
            if expected["role"] == "postgres": b.require(v["State"].get("Health", {}).get("Status") == "healthy", "recovery-postgres-health")
            else: p.stopped_cleanly(v)
        job = by_id[migrated["container_id"]]
        p.stopped_cleanly(job)
        labels = job["Labels"]
        b.require(job["Name"] == "/citygo-migrate-" + ident and job["Image"] in (local["target"]["jobs"]["local_id"], local["target"]["jobs"]["config_id"])
                  and job["RestartCount"] == 0 and job["RestartPolicy"] == "no"
                  and labels.get("com.docker.compose.project") == config["project"] and labels.get("com.docker.compose.service") == "migrator"
                  and labels.get("citygo.operation") == ident and labels.get("citygo.request-sha256") == migrated["request_sha256"]
                  and job["State"]["StartedAt"] == migrated["started_at"] and job["State"]["FinishedAt"] == migrated["finished_at"], "recovery-migration-process")
        apps = {}
        for role in ("api", "web"):
            cid = startup["apps"][role]["id"]
            detail = host.detail(cid)
            b.require(detail.get("Id") == cid, "recovery-app-replaced")
            apps[role] = s.runtime(detail, role, local["target"][role], config["project"], request["origin"], request["api_secret"], networks, sa["profile"])
        b.require(apps == startup["apps"], "recovery-app-process")
        for name, net in (("database", host.database_network()), ("web_api", host.web_network())):
            allowed = set(by_id) - {apps["web"]["id"]} if name == "database" else app_ids
            required = {cid for cid in allowed if by_id[cid]["State"]["Running"]}
            b.require(net["id"] == networks[name] and required <= set(net["peers"]) <= allowed, "recovery-network-changed")
        return {"apps": apps, "retained": [p.evidence(by_id[i]) for i in sorted(baseline)],
                "migration": p.evidence(job), "networks": networks}
    with tempfile.TemporaryDirectory(prefix=".recovery-check-", dir=state) as tmp:
        host = host_factory(config, Path(tmp), request["ingress_directory"], request["origin"])
        observed = runtime(host)
        host.probe()
        b.require(runtime(host) == observed, "recovery-runtime-changed")
    f.verify_generation(plan)
    b.require(t.bundle(Path(request["current_bundle"]), pa["current_manifest_sha256"], current=True) == current
              and t.bundle(Path(request["target_bundle"]), pa["target_manifest_sha256"], current=True) == target,
              "recovery-manifests-changed")
    b.assert_current_config(config)
    b.require(not os.path.lexists(state / w.ADMISSION), "worker-not-paused")
    b.require(t.read_file(request_path, private=True) == request_raw, "operator-request-changed")
    for path, raw in files.items(): b.require(t.read_file(path, private=True) == raw, "recovery-evidence-changed")
    snapshot = {"version": 1, "request_sha256": t.sha256(request_raw), "config_file_sha256": t.sha256(b._config_bytes(config._binding.path)),
                "files": {str(path): t.sha256(raw) for path, raw in files.items()}, "runtime": observed,
                "generation_sha256": plan["sha256"], "operation": operation}
    return {"status": "closed-commit-eligible-not-approved", "observation_sha256": t.sha256(m.wire(snapshot)),
            "operation_id": ident, "source_sha": config["source_sha"], "config_path": request["config_path"]}, operation


def inspect(request_path, **test_options):
    value, _raw = ctl.request(request_path)
    config = b.load_config(value["config_path"])
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state), b.lock(state, "worker-admission.lock"):
        report, _operation = _observe(request_path, config, **test_options)
        return report


def approval(raw, now):
    value = t.strict_json(raw)
    t.keys(value, {"version", "purpose", "config_path", "operation_id", "observation_sha256", "approved_at", "expires_at",
                   "allow_settle", "allow_migration", "allow_start", "allow_traffic", "allow_worker"}, "recovery-approval")
    b.require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == "citygo-recovery-closed-commit"
              and value["allow_settle"] is True and all(value[k] is False for k in ("allow_migration", "allow_start", "allow_traffic", "allow_worker"))
              and t.matches(value["operation_id"], r"[0-9a-f]{32}") and t.matches(value["observation_sha256"], t.HASH), "recovery-approval")
    b.require(type(value["config_path"]) is str, "recovery-approval")
    f.path_string(value["config_path"])
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 3600, "recovery-expired")
    return value


def settle(request_path, approval_path, *, allow_settle=False, **test_options):
    b.require(allow_settle is True, "explicit-recovery-permission-required")
    value, _raw = ctl.request(request_path)
    config = b.load_config(value["config_path"])
    state = b.protected(config["state_dir"], directory=True)
    path = Path(f.path_string(approval_path))
    b.require(path != Path(request_path) and path not in {Path(value[k]) for k in ctl.PATHS}
              and all(not path.is_relative_to(root) for root in (state, Path(value["current_bundle"]), Path(value["target_bundle"]))), "recovery-self-approval")
    raw = t.read_file(path, private=True)
    approved = approval(raw, time.time())
    used = state / ("recovery-approval-" + t.sha256(raw) + ".used.json")
    def check_approval():
        b.require(t.read_file(path, private=True) == raw, "recovery-approval-changed")
        approval(raw, time.time())
    with b.lock(state), b.lock(state, "worker-admission.lock"):
        check_approval()
        b.require(not os.path.lexists(used), "recovery-approval-used")
        report, operation = _observe(request_path, config, **test_options)
        b.require(all(approved[k] == report[k] for k in ("config_path", "operation_id", "observation_sha256")), "recovery-approval-binding")
        check_approval()
        record = {"version": 1, "operation_id": operation["id"], "approval_sha256": t.sha256(raw),
                  "observation_sha256": report["observation_sha256"]}
        reservation = m.wire(record)
        f.write_new(used, reservation)
        receipt = state / ("recovery-" + operation["id"] + ".json")
        f.write_new(receipt, reservation)
        result = {"status": "closed-commit-recovered", "operation_id": operation["id"], "source_sha": config["source_sha"],
                  "traffic_authorized": False, "worker_authorized": False, "restart_authorized": False}
        def final_check():
            b.require(_observe(request_path, config, **test_options) == (report, operation), "recovery-observation-changed")
            b.require(t.read_file(used, private=True) == reservation and t.read_file(receipt, private=True) == reservation, "recovery-reservation-changed")
            check_approval()  # AFTER all engine/HTTP/file reads, immediately before unlink.
        b.complete_operation(state, operation, before_clear=final_check)
    return copy.deepcopy(result)
