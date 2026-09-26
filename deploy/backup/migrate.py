"""Internal approved prepare -> migration continuation; NOT a production CLI.

No startup, traffic opening, pending removal, retry, rollback or approval writer.
Until start/health/finish exist, this must NOT be run against the pilot server.
"""
import copy
import os
from pathlib import Path
import sys
import time
import uuid

import backup as b
import image_gate as g
import migration_job as m
import prepare as p
import target as t


def approval(data, now):
    value = t.strict_json(data)
    t.keys(value, {"version", "purpose", "preparation_sha256", "target_manifest_sha256",
                   "configuration_sha256", "project", "origin", "network_id", "approved_at",
                   "expires_at", "allow_migration", "allow_start", "allow_traffic"}, "migration-approval")
    b.require(type(value["version"]) is int and value["version"] == 1
              and value["purpose"] == "citygo-release-migration"
              and value["allow_migration"] is True and value["allow_start"] is False
              and value["allow_traffic"] is False, "migration-approval")
    for key in ("preparation_sha256", "target_manifest_sha256", "configuration_sha256", "network_id"):
        b.require(t.matches(value[key], t.HASH), "migration-approval")
    b.require(t.matches(value["project"], r"citygo-[a-z0-9][a-z0-9-]{0,62}"), "migration-approval")
    p.hostname(value["origin"])
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400,
              "migration-approval-expired")
    return value


class Approval:
    """Independently reviewed protected file outside BOTH delivered bundles.

    Revoke/change/expiry poisons the object. This is the same manual root of trust
    as Selection, not cryptographic attestation or protection from root/Python.
    """
    def __init__(self, path):
        self.path = Path(path)
        self._pin, self._failed = None, False

    def verify(self, selection, config, target_sha, origin, images):
        b.require(not self._failed, "migration-approval-invalidated")
        try:
            b.require(sys.platform.startswith("linux") and type(selection) is t.Selection, "migration-selection")
            path = self.path
            b.require(path.is_absolute() and ".." not in path.parts
                      and path != selection.approval_file
                      and all(not path.is_relative_to(root) for root in
                              (selection.current_directory, selection.target_directory)), "migration-self-approval")
            data = t.read_file(path, private=True)
            pin = t.sha256(data)
            b.require(self._pin is None or self._pin == pin, "migration-approval-changed")
            approved = approval(data, time.time())
            selected = selection.verify(config, target_sha, origin, images)
            b.require(approved["preparation_sha256"] == selected["approval_sha256"]
                      and approved["target_manifest_sha256"] == selected["target_manifest_sha256"]
                      and approved["configuration_sha256"] == b.configuration_fingerprint(config)
                      and approved["project"] == config["project"] and approved["origin"] == origin,
                      "migration-approval-binding")
            current = t.bundle(selection.current_directory, selected["current_manifest_sha256"], current=True)
            target = t.bundle(selection.target_directory, selected["target_manifest_sha256"])
            grants = next(e["sha256"] for e in target["runtimeFiles"] if e["path"] == "deploy/postgres/grants.sql")
            # Inventory/ACL are derived only from the independently selected
            # manifests; no caller-supplied SQL hashes or commands are accepted.
            inputs = {"currentMigrations": current["migrations"], "targetMigrations": target["migrations"],
                      "grantsSha256": grants}
            b.require(selection.verify(config, target_sha, origin, images) == selected, "migration-selection-changed")
            latest = t.read_file(path, private=True)
            b.require(latest == data, "migration-approval-changed")
            approval(latest, time.time())
            self._pin = pin
            return copy.deepcopy({"approval_sha256": pin, "network_id": approved["network_id"],
                                  "selected": selected, "inputs": inputs})
        except Exception:
            self._failed = True
            raise


def migrate(config, target_sha, origin, ingress_directory, images, secret_file, *,
            allow_stop=False, allow_upload=False, allow_migration=False, selection=None,
            authorization=None, image_store_factory=g.Store, host_factory=p.Host,
            storage_factory=b.S3, encryptor=b.encrypt, min_free=b.MIN_FREE, transport_factory=m.Docker):
    b.require(allow_stop is True and allow_upload is True and allow_migration is True,
              "explicit-migration-permission-required")
    b.require(type(authorization) is Approval, "migration-approval-required")
    config, images = copy.deepcopy(b.validate(config)), p.expected_images(images)
    approved = authorization.verify(selection, config, target_sha, origin, images)
    state = b.protected(config["state_dir"], directory=True)
    spent = state / ("migration-approval-" + approved["approval_sha256"] + ".used.json")
    b.require(not os.path.lexists(spent), "migration-approval-already-used")
    secret = m.secret_bytes(Path(secret_file))  # Bad credentials fail BEFORE downtime.
    reservation = None

    def check_approval():
        b.require(authorization.verify(selection, config, target_sha, origin, images) == approved,
                  "migration-approval-changed")
        b.require(m.secret_bytes(Path(secret_file)) == secret, "migration-secret-changed")
        if reservation is None:
            b.require(not os.path.lexists(spent), "migration-approval-already-used")
        else:
            b.require(t.read_file(spent, private=True) == reservation, "migration-reservation-changed")

    with p._prepared_window(config, target_sha, origin, ingress_directory, images,
            allow_stop=True, allow_upload=True, selection=selection, image_store_factory=image_store_factory,
            host_factory=host_factory, storage_factory=storage_factory, encryptor=encryptor, min_free=min_free,
            authorization_check=check_approval, expected_network_id=approved["network_id"]) as stage:
        window, host = stage["window"], stage["host"]
        operation = window._operation
        plan = {"version": 1, "kind": "citygo-release-migration", "operationId": str(uuid.UUID(operation["id"])),
                "targetSha": target_sha, **approved["inputs"]}
        request_hash = t.sha256(m.request(plan, operation))
        selected = approved["selected"]
        job_image = stage["proof"]["local_images"]["target"]["jobs"]
        job_record = state / ("migration-" + operation["id"] + ".container.json")
        pinned_record = None

        def guard():
            nonlocal pinned_record
            window._check()
            stage["check_selection"]()
            host.assert_closed()
            values = host.inventory()
            job_id = None
            if os.path.lexists(job_record):
                raw = t.read_file(job_record, private=True)
                b.require(pinned_record is None or raw == pinned_record, "migration-record-changed")
                record = t.strict_json(raw)
                job_id = record.get("container_id")
                expected = {"version": 1, "operation_id": operation["id"], "project": config["project"],
                            "container_name": "citygo-migrate-" + operation["id"], "target_sha": target_sha,
                            "image": job_image, "network_id": approved["network_id"],
                            "request_sha256": request_hash, "container_id": job_id}
                b.require(t.matches(job_id, t.HASH) and record == expected, "migration-record-binding")
                jobs = [v for v in values if v.get("Id") == job_id]
                b.require(len(jobs) == 1, "migration-job-missing")
                job = jobs[0]
                labels = job.get("Labels", {})
                b.require(job.get("Name") == "/" + expected["container_name"]
                          and job.get("Image") in (job_image["local_id"], job_image["config_id"])
                          and labels.get("citygo.operation") == operation["id"]
                          and labels.get("citygo.request-sha256") == request_hash
                          and labels.get("com.docker.compose.service") == "migrator"
                          and labels.get("com.docker.compose.project") == config["project"]
                          and job.get("RestartCount") == 0 and job.get("RestartPolicy") == "no",
                          "migration-job-binding")
                state_value = job.get("State", {})
                b.require(state_value.get("Status") in ("created", "exited")
                          and state_value.get("Running") is False, "migration-job-active")
                if state_value["Status"] == "exited": p.stopped_cleanly(job)
                pinned_record = raw
            else:
                b.require(pinned_record is None, "migration-record-missing")
            baseline = p.validate_inventory([v for v in values if v.get("Id") != job_id],
                                            config["project"], images, initial=False)
            p.same_inventory(stage["containers"], baseline)
            network = host.database_network()
            # The new retained job can leave an endpoint briefly after exit.
            # No other added peer/container is allowed, even with valid labels.
            if job_id is not None:
                network = {**network, "peers": [i for i in network["peers"] if i != job_id]}
            p.check_network(network, baseline, stage["network"])
            host.assert_closed()
            stage["check_selection"]()
            window._check()

        guard()
        # Reserve this independent approval once, under the release lock and
        # before Docker create. Retain on every failure; never resume from disk.
        reservation = m.wire({"version": 1, "approval_sha256": approved["approval_sha256"],
                              "operation_id": operation["id"], "request_sha256": request_hash})
        fd = os.open(spent, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(reservation); stream.flush(); os.fsync(stream.fileno())
        b.sync_directory(state)
        proof = m._execute_in_window(window, plan, selected["images"]["jobs"], selected["image_ids"]["jobs"],
            approved["network_id"], secret_file, allow_migration=True, guard=guard,
            transport_factory=transport_factory, image_store_factory=image_store_factory)
        guard()
        result = {"version": 1, "preparation": stage["proof"], "migration": proof,
                  "approval_sha256": approved["approval_sha256"], "traffic_authorized": False}
    return copy.deepcopy(result)
