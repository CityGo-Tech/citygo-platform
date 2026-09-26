#!/usr/bin/env python3
"""Explicit Linux operator entrypoint. No approval writer, downloads or auto-retry.

Use a protected request file with paths, never secrets on the command line.
plan/verify do not stop containers or change release/admission records.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import sys

import backup as b
import finish as f
import image_gate as g
import migrate as c
import migration_job as m
import prepare as p
import start as s
import target as t

PATHS = {"config_path", "ingress_directory", "current_bundle", "target_bundle", "preparation_approval",
         "migration_approval", "startup_approval", "finish_approval", "migration_secret", "api_secret",
         "worker_secret", "backup_secret"}
FIELDS = PATHS | {"version", "target_sha", "origin"}


def request(path):
    path = Path(f.path_string(path))
    raw = t.read_file(path, private=True)
    value = t.strict_json(raw)
    t.keys(value, FIELDS, "operator-request")
    b.require(type(value["version"]) is int and value["version"] == 1
              and t.matches(value["target_sha"], t.SHA), "operator-request")
    p.hostname(value["origin"])
    for key in PATHS:
        b.require(type(value[key]) is str, "operator-path")
        f.path_string(value[key])
        b.require(str(PurePosixPath(value[key])) == value[key], "operator-path")
    b.require(len({value[k] for k in PATHS}) == len(PATHS), "operator-path-alias")
    b.require(all(not path.is_relative_to(Path(value[k])) for k in ("current_bundle", "target_bundle")), "operator-self-request")
    return value, raw


def inputs(value):
    config = b.load_config(value["config_path"])
    selected = t.Selection(value["current_bundle"], value["target_bundle"], value["preparation_approval"])
    preparation = t.approval(t.read_file(value["preparation_approval"], private=True), s.time.time())
    return config, preparation["current_images"], {"selection": selected,
        "authorization": c.Approval(value["migration_approval"]),
        "startup_authorization": s.Approval(value["startup_approval"]),
        "finish_authorization": f.Approval(value["finish_approval"])}


def preflight(value, *, verify_finish=False, image_store_factory=g.Store):
    config, images, auth = inputs(value)
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state):
        b.assert_operation_idle(state)
        selected = auth["selection"].verify(config, value["target_sha"], value["origin"], images)
        local = g.verify(image_store_factory(state), selected, images)
        started = auth["startup_authorization"].verify(auth["selection"], auth["authorization"], config,
                         value["target_sha"], value["origin"], images, value["api_secret"])
        m.secret_bytes(Path(value["migration_secret"]))
        plan = f.generation(config, value["target_sha"], value["origin"], local,
                            value["api_secret"], value["worker_secret"], value["backup_secret"])
        b.require(not Path(config._binding.path).is_relative_to(state), "finish-config-location")
        b.require(not os.path.lexists(plan["directory"]), "finish-generation-exists")
        raw = b._config_bytes(config._binding.path)
        if verify_finish:
            approved = auth["finish_authorization"].verify(auth["selection"], auth["authorization"],
                           auth["startup_authorization"], config._binding.path, raw, plan)
            b.require(not os.path.lexists(state / ("finish-approval-" + approved + ".used.json")), "finish-approval-used")
        b.assert_current_config(config)
        # Use public verified hashes, not private pin representations (finish
        # intentionally pins raw bytes, while earlier stages pin digests).
        authorities = [(auth["selection"].approval_file, t.approval, selected["approval_sha256"]),
                       (auth["authorization"].path, c.approval, started["migration"]["approval_sha256"]),
                       (auth["startup_authorization"].path, s.approval, started["approval_sha256"])]
        if verify_finish: authorities.append((auth["finish_authorization"].path, f.approval, approved))
        pins = []
        for path, parser, digest in authorities:
            latest = t.read_file(path, private=True)
            b.require(t.sha256(latest) == digest, "operator-approval-changed")
            pins.append((parser, latest))
        now = s.time.time()
        for parser, latest in pins: parser(latest, now)
        # These non-secret bindings support independent manual approval. They do
        # not write an approval or attest runtime readiness/backup compatibility.
        return {"status": "verified-not-deployed" if verify_finish else "planned-not-approved",
                "target_sha": value["target_sha"], "config_path": value["config_path"],
                "config_file_sha256": t.sha256(raw), "generation_sha256": plan["sha256"],
                "startup_approval_sha256": started["approval_sha256"], "runtime_checked": False}


def apply(value):
    config, images, auth = inputs(value)
    result = f.finish(config, value["target_sha"], value["origin"], value["ingress_directory"], images,
                      value["migration_secret"], value["api_secret"], value["worker_secret"], value["backup_secret"],
                      allow_stop=True, allow_upload=True, allow_migration=True, allow_start=True, allow_finish=True, **auth)
    return {"status": "closed-release-committed", "source_sha": result["finish"]["source_sha"],
            "operation_id": result["finish"]["operation_id"], "traffic_authorized": False,
            "worker_authorized": False, "restart_authorized": False}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        # argparse's default echoes unrecognized arguments (possibly pasted keys).
        self.exit(2, "CityGo release: invalid arguments; use --help\n")


def main(argv=None):
    parser = Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument("operation", choices=("plan", "verify", "apply", "inspect-recovery", "recover-commit"))
    parser.add_argument("--request", required=True)
    parser.add_argument("--recovery-approval")
    for verb in ("stop", "upload", "migration", "start", "finish", "settle"):
        parser.add_argument("--allow-" + verb, action="store_true")
    args = parser.parse_args(argv)
    permissions = {verb for verb in ("stop", "upload", "migration", "start", "finish", "settle") if getattr(args, "allow_" + verb)}
    wanted = {"stop", "upload", "migration", "start", "finish"} if args.operation == "apply" else ({"settle"} if args.operation == "recover-commit" else set())
    def interrupted(_signum, _frame): raise b.BackupError("interrupted")
    try:
        b.require(permissions == wanted and bool(args.recovery_approval) is (args.operation == "recover-commit"), "operator-explicit-permission")
        b.require(sys.platform.startswith("linux") and sys.version_info >= (3, 11), "operator-linux-python-required")
        os.umask(0o077)
        signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
        value, raw = request(args.request)
        if args.operation in ("plan", "verify"):
            result = preflight(value, verify_finish=args.operation == "verify")
            b.require(t.read_file(args.request, private=True) == raw, "operator-request-changed")
        elif args.operation == "apply":
            result = apply(value)
        else:
            import recovery
            result = (recovery.inspect(args.request) if args.operation == "inspect-recovery" else
                      recovery.settle(args.request, args.recovery_approval, allow_settle=True))
        print(json.dumps(result, sort_keys=True))
        return 0
    except b.BackupError as error:
        code = str(error)
        if not re.fullmatch(r"[a-z0-9-]{1,80}", code): code = "failed-details-hidden"
        print("CityGo release: " + code, file=sys.stderr)
        return 1
    except Exception:
        print("CityGo release: failed-details-hidden", file=sys.stderr)
        return 1


if __name__ == "__main__": sys.exit(main())
