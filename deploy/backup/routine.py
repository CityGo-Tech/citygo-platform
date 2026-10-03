"""Standing hourly backups with bounded GFS retention; separate from trial schedule.

Only an operator installs/enables this controller. It follows the root-owned
active backup configuration across releases, never repository-provided commands.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

import backup as b
import notify

ID = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{32}")
FIELDS = {"version", "enabled", "backup_config", "mail_config", "state_dir", "pins"}
PIN_FIELDS = {"project", "state_dir", "endpoint", "bucket", "prefix", "recipient_sha256", "storage_credentials_file"}
MAX_OBJECTS = 10000


def load(path):
    policy = b.read_json(b.protected(path))
    b.require(type(policy) is dict and set(policy) == FIELDS, "routine-policy")
    b.require(type(policy["version"]) is int and policy["version"] == 1
              and type(policy["enabled"]) is bool, "routine-policy")
    b.require(all(notify.private_path(policy[k]) for k in ("backup_config", "mail_config", "state_dir")), "routine-path")
    b.require(type(policy["pins"]) is dict and set(policy["pins"]) == PIN_FIELDS, "routine-pins")
    b.protected(policy["state_dir"], directory=True)
    return policy


def active(policy):
    b.require(policy["enabled"], "routine-disabled")
    config = b.load_config(policy["backup_config"])
    pins = {k: config[k] for k in PIN_FIELDS - {"recipient_sha256"}}
    pins["recipient_sha256"] = hashlib.sha256(config["recipient"].encode()).hexdigest()
    b.require(pins == policy["pins"], "routine-destination-changed")
    b.require(config["upload_enabled"], "upload-disabled")
    b.require(Path(policy["state_dir"]) != Path(config["state_dir"]), "routine-state")
    return config


class Store(b.S3):
    def request(self, *args):
        # Never surface AWS stderr (can contain request identifiers/credentials).
        with tempfile.TemporaryFile() as output:
            result = subprocess.run([*self.args, *args, "--bucket", self.bucket, "--output", "json"],
                                    env=self.env, stdin=subprocess.DEVNULL, stdout=output,
                                    stderr=subprocess.DEVNULL, timeout=90, preexec_fn=b.limits)
            b.require(result.returncode == 0, "retention-storage-request")
            output.seek(0)
            raw = output.read(2 * 1024 * 1024 + 1)
        b.require(len(raw) <= 2 * 1024 * 1024, "retention-response-size")
        value = json.loads(raw or b"{}")
        b.require(type(value) is dict, "retention-response")
        return value

    def listing(self, prefix):
        result, token, tokens = {}, None, set()
        for _ in range(20):
            args = ["list-objects-v2", "--prefix", prefix + "/", "--max-keys", "1000", "--no-paginate"]
            if token:
                args += ["--continuation-token", token]
            page = self.request(*args)
            b.require(type(page.get("IsTruncated")) is bool, "retention-pagination")
            for item in page.get("Contents", []):
                key, size = item["Key"], item["Size"]
                b.require(type(key) is str and key.startswith(prefix + "/") and key not in result
                          and type(size) is int and size >= 0, "retention-listing")
                result[key] = item
            b.require(len(result) <= MAX_OBJECTS, "retention-object-limit")
            if not page["IsTruncated"]:
                return result
            token = page.get("NextContinuationToken")
            b.require(type(token) is str and 0 < len(token) <= 8192 and token not in tokens, "retention-pagination")
            tokens.add(token)
        raise b.BackupError("retention-page-limit")

    def unversioned(self, key):
        # Cloud.ru requires an additional IAM ACL role for GetBucketVersioning.
        # Object HEAD is available under GetObject; never delete a versioned object.
        info = self.request("head-object", "--key", key)
        b.require(info.get("VersionId") in (None, "null") and not info.get("DeleteMarker"), "retention-versioned-object")

    def delete(self, key):
        self.unversioned(key)
        info = self.request("delete-object", "--key", key)
        b.require(not info.get("DeleteMarker") and info.get("VersionId") in (None, "null"), "retention-versioning-changed")


def snapshot_time(backup_id):
    b.require(type(backup_id) is str and ID.fullmatch(backup_id), "retention-id")
    try:
        return datetime.strptime(backup_id[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        raise b.BackupError("retention-date") from None


def keep_ids(records):
    """24 hourly buckets + 7 days + 4 ISO weeks, and at least two snapshots.

    Extra pre-release snapshots share the policy. Union <=35 (newest overlaps
    all three groups); gaps retain older usable points. All buckets use UTC.
    """
    ordered = sorted(records, key=lambda r: (r["snapshot_started_at"], r["backup_id"]), reverse=True)
    keep = {r["backup_id"] for r in ordered[:2]}
    hours, days, weeks = set(), set(), set()
    for record in ordered:
        date = datetime.fromtimestamp(record["snapshot_started_at"], timezone.utc)
        day, week = date.date(), date.isocalendar()[:2]
        hour = date.replace(minute=0, second=0, microsecond=0)
        if hour not in hours and len(hours) < 24:
            hours.add(hour)
            keep.add(record["backup_id"])
        if day not in days and len(days) < 7:
            days.add(day)
            keep.add(record["backup_id"])
        if week not in weeks and len(weeks) < 4:
            weeks.add(week)
            keep.add(record["backup_id"])
    return keep


def inventory(config, store, directory, *, now):
    objects = store.listing(config["prefix"])
    records, recognized = [], set()
    recipient = hashlib.sha256(config["recipient"].encode()).hexdigest()
    for key, item in objects.items():
        name = key.removeprefix(config["prefix"] + "/")
        if not name.endswith(".complete.json") or not ID.fullmatch(name[:-14]):
            continue  # Unknown/enrollment files are never deletion candidates.
        backup_id = name[:-14]
        timestamp = snapshot_time(backup_id)
        b.require(timestamp <= now and 0 < item["Size"] <= 65536, "retention-manifest")
        path = directory / "manifest.json"
        store.get(key, path)
        record = b.read_json(path)
        archive = config["prefix"] + "/" + backup_id + ".dump.age"
        b.require(record.get("version") == 1 and record.get("backup_id") == backup_id
                  and record.get("key") == archive and record.get("format") == "pg_dump-custom+age-x25519"
                  and record.get("recipient_sha256") == recipient, "retention-manifest")
        start = record.get("snapshot_started_at")
        b.require(type(start) in (int, float) and math.isfinite(start) and timestamp <= start < timestamp + 1
                  and start <= now and type(record.get("bytes")) is int and 0 < record["bytes"] <= b.MAX_BYTES
                  and type(record.get("sha256")) is str and re.fullmatch(r"[0-9a-f]{64}", record["sha256"]), "retention-manifest")
        # Missing archives stop cleanup. An interrupted delete needs operator
        # reconciliation instead of silently forgetting a partially deleted pair.
        b.require(archive in objects and objects[archive]["Size"] == record["bytes"], "retention-incomplete-pair")
        records.append(record)
        recognized.update((key, archive))
    return records, objects, set(objects) - recognized


def prune(config, store, directory, fresh, *, delete=False):
    b.check_freshness(config)
    records, objects, unknown = inventory(config, store, directory, now=time.time())
    matching = [r for r in records if r["backup_id"] == fresh["backup_id"]]
    b.require(matching == [fresh], "retention-fresh-copy-missing")
    keep = keep_ids(records)
    b.require(fresh["backup_id"] in keep and len(keep) >= min(2, len(records)), "retention-keepers")
    candidates = [r for r in records if r["backup_id"] not in keep]
    # Check ALL candidate versions before the first delete. No wildcard deletes.
    for record in candidates:
        store.unversioned(record["key"])
        store.unversioned(record["key"].removesuffix(".dump.age") + ".complete.json")
    removed = 0
    if delete:
        for record in candidates:
            b.assert_current_config(config)
            b.check_freshness(config)
            store.delete(record["key"])
            store.delete(record["key"].removesuffix(".dump.age") + ".complete.json")
            removed += 1
    return {"snapshots": len(records), "kept": len(keep), "candidates": len(candidates),
            "deleted": removed, "kept_bytes": sum(r["bytes"] for r in records if r["backup_id"] in keep),
            "unknown_objects": len(unknown), "unknown_bytes": sum(objects[k]["Size"] for k in unknown)}


def run(policy, *, delete, runner=b._backup_in_operation, storage_factory=Store):
    config = active(policy)
    state, ops = Path(config["state_dir"]), Path(policy["state_dir"])
    with b.lock(state):
        b.assert_current_config(config)
        b.assert_operation_idle(state)
        # Preflight listing BEFORE backup starts a durable operation.
        with tempfile.TemporaryDirectory(prefix=".retention-", dir=ops) as temp:
            directory = Path(temp)
            store = storage_factory(config, directory)
            records, objects, _unknown = inventory(config, store, directory, now=time.time())
            # A broken retention grant must not result in unlimited hourly uploads.
            # Reserve the maximum next dump before beginning. Deployment backups
            # are independent and are reported in this same inventory.
            b.require(len(records) < 40 and sum(x["Size"] for x in objects.values()) < 1024 ** 3,
                      "routine-storage-cap")
            operation = b.begin_operation(state, "backup", b.configuration_fingerprint(config))
            fresh = runner(config, operation)
            b.complete_operation(state, operation)
            result = prune(config, store, directory, fresh, delete=delete)
        b.atomic_json(ops / "last-run.json", {"status": "ok", "at": time.time(), **result})
        return result


def check(policy):
    config = active(policy)
    # Holding the backup/deploy lock is expected during an update; freshness
    # monitoring must still run so a stuck deployment is not silently ignored.
    b.check_freshness(config)
    status = b.read_json(b.protected(Path(policy["state_dir"]) / "last-run.json"))
    b.require(status.get("status") == "ok" and type(status.get("at")) in (int, float)
              and 0 <= time.time() - status["at"] < 7200, "routine-stale-or-failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["run", "check"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--allow-upload", action="store_true")
    parser.add_argument("--allow-delete", action="store_true")
    parser.add_argument("--allow-send", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise b.BackupError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    policy, event, code = None, "healthy", 0
    try:
        policy = load(args.config)
        if args.operation == "run":
            b.require(args.allow_upload and args.allow_delete, "routine-explicit-approval")
            result = run(policy, delete=True)
            print(json.dumps(result, sort_keys=True))
        else:
            check(policy)
    except b.BackupError as error:
        if str(error) == "already-running" and args.operation == "run":
            print("CityGo routine: skipped (backup/deployment lock busy)")
            return 0
        event, code = "backup_failed", 1
        print("CityGo routine: " + str(error), file=sys.stderr)
    except Exception:
        event, code = "configuration", 1
        print("CityGo routine: failed (details hidden)", file=sys.stderr)
    if code and policy and args.operation == "run":
        b.atomic_json(Path(policy["state_dir"]) / "last-run.json", {"status": "failed", "at": time.time()})
    if args.allow_send and policy:
        try:
            notify.notify(notify.load(policy["mail_config"]), event)
        except Exception:
            print("CityGo routine: email unconfirmed", file=sys.stderr)
            code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
