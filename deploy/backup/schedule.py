"""Disabled-by-default, time/attempt-bounded backup and email monitor entrypoint.

No installation, remote deletion, lifecycle changes, restore, DNS or AI activation.
"""
import argparse
import hashlib
import json
import os
import signal
import sys
import time

import backup as b
import notify as mail

FIELDS = {"version", "schedule_enabled", "monitor_enabled", "backup_config", "mail_config",
          "state_dir", "approved_until", "max_attempts"}


def validate(config):
    b.require(type(config) is dict and set(config) == FIELDS, "schedule-configuration")
    b.require(type(config["version"]) is int and config["version"] == 1, "schedule-configuration")
    b.require(all(type(config[x]) is bool for x in ("schedule_enabled", "monitor_enabled")), "schedule-configuration")
    b.require(all(mail.private_path(config[x]) for x in ("backup_config", "mail_config", "state_dir")), "schedule-path")
    b.require(type(config["approved_until"]) is int and config["approved_until"] >= 0, "schedule-expiry")
    b.require(type(config["max_attempts"]) is int and 1 <= config["max_attempts"] <= 168, "schedule-attempts")
    return config


def approval(config, now):
    validate(config)
    b.require(config["schedule_enabled"], "schedule-disabled")
    b.require(0 < now < config["approved_until"] <= now + 7 * 86400, "schedule-approval-expired")


def approval_id(config, backup_config):
    # Binding prevents a ledger from silently following a different DB/bucket/release.
    return hashlib.sha256(json.dumps({"config": config, "backup": b.configuration_fingerprint(backup_config)}, sort_keys=True).encode()).hexdigest()


def read_ledger(config, backup_config):
    state = b.protected(config["state_dir"], directory=True)
    value = b.read_json(b.protected(state / "attempts.json"))
    b.require(type(value) is dict and set(value) == {"approval", "attempts", "last_started"}, "schedule-ledger")
    b.require(value["approval"] == approval_id(config, backup_config), "schedule-approval-changed")
    b.require(type(value["attempts"]) is int and 0 <= value["attempts"] <= config["max_attempts"], "schedule-ledger")
    b.require(type(value["last_started"]) in (int, float) and 0 <= value["last_started"] < float("inf"), "schedule-ledger")
    return state, value


def initialize(config, *, now=None):
    now = time.time() if now is None else now
    approval(config, now)
    backup_config = b.load_config(config["backup_config"])
    b.require(backup_config["upload_enabled"], "upload-disabled")
    state = b.protected(config["state_dir"], directory=True)
    value = {"approval": approval_id(config, backup_config), "attempts": 0, "last_started": 0}
    with b.lock(state):
        fd = os.open(state / "attempts.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())


def perform(config, *, now=None, runner=b.perform_backup):
    now = time.time() if now is None else now
    approval(config, now)
    backup_config = b.load_config(config["backup_config"])
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state):
        _, ledger = read_ledger(config, backup_config)
        b.require(ledger["attempts"] < config["max_attempts"], "schedule-attempt-limit")
        b.require(ledger["last_started"] == 0 or now - ledger["last_started"] >= 3500, "schedule-too-soon")
        # A failed, interrupted or uncertain run still spends one attempt.
        b.atomic_json(state / "attempts.json", {**ledger, "attempts": ledger["attempts"] + 1, "last_started": now})
        runner(backup_config)
        b.check_freshness(backup_config)


def assessment(config, now):
    validate(config)
    if not config["schedule_enabled"]:
        return "paused"
    if not now < config["approved_until"] <= now + 7 * 86400:
        return "approval_expired"
    try:
        backup_config = b.load_config(config["backup_config"])
        _, ledger = read_ledger(config, backup_config)
        b.require(ledger["last_started"] <= now, "schedule-clock")
        if not backup_config["upload_enabled"]:
            return "paused"
        b.check_freshness(backup_config, now=now)
        if ledger["attempts"] >= config["max_attempts"]:
            return "attempt_limit"
        return "healthy"
    except b.BackupError as error:
        return {"stale-backup": "stale", "last-attempt-failed": "backup_failed"}.get(str(error), "configuration")
    except Exception:
        return "configuration"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["initialize", "backup", "check", "test-email"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--allow-initialize", action="store_true")
    parser.add_argument("--allow-upload", action="store_true")
    parser.add_argument("--allow-send", action="store_true")
    args = parser.parse_args(argv)
    try:
        b.require(sys.platform.startswith("linux"), "linux-required")
        os.umask(0o077)
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        config = validate(b.read_json(b.protected(args.config)))
        if args.operation == "initialize":
            b.require(args.allow_initialize, "explicit-initialize-required")
            initialize(config)
            result = "initialized-no-backup"
        elif args.operation == "backup":
            b.require(args.allow_upload, "explicit-upload-required")
            perform(config)
            result = "backup-verified"
        else:
            b.require(args.allow_send, "explicit-send-required")
            if args.operation == "check":
                b.require(config["monitor_enabled"], "monitor-disabled")
                event = assessment(config, time.time())
            else:
                event = "test"
            result = mail.notify(mail.load(config["mail_config"]), event)
            print(json.dumps({"event": event, "email": result}), flush=True)
            return 0 if event in ("healthy", "test") else 1
        print(json.dumps({"status": result}), flush=True)
        return 0
    except Exception:
        # Configuration/SMTP/provider errors may contain secrets. Never echo them.
        print("CityGo backup operations: failed; inspect protected status/configuration", file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise b.BackupError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
