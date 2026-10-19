#!/usr/bin/python3
"""Bounded, secret-safe decoding of one GitHub JIT config from host KVP.

Never emits config values. Runner 2.338.0 Runner.cs loads this same base64
JSON map. Admitting only three fixed filenames avoids argv secrets and prevents
the upstream generic map decoder from accepting arbitrary relative paths.
https://github.com/actions/runner/blob/v2.338.0/src/Runner.Listener/Runner.cs
"""
import base64
import datetime
import hashlib
import json
import re

RECORD = 2560
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
FILES = {".runner", ".credentials", ".credentials_rsaparams"}


def require(value, code):
    if not value:
        raise ValueError("ci_job_jit_" + code)


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, "constant"))
    except (ValueError, UnicodeError, TypeError):
        raise ValueError("ci_job_jit_json") from None


def canonical64(value, maximum):
    require(type(value) is str and 0 < len(value) <= maximum and value.isascii(), "base64_bounds")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ValueError("ci_job_jit_base64") from None
    require(base64.b64encode(raw).decode("ascii") == value, "base64_canonical")
    return raw


def pool_records(raw, operation):
    require(type(operation) is str and re.fullmatch(UUID, operation) and type(raw) is bytes and
            len(raw) <= RECORD * 400 and len(raw) % RECORD == 0, "pool")
    prefix = ("CityGoJobJit-" + operation + "-").encode("ascii")
    result = {}
    for offset in range(0, len(raw), RECORD):
        key, value = raw[offset:offset + 512], raw[offset + 512:offset + RECORD]
        require(b"\0" in key, "pool_name")
        key = key.split(b"\0", 1)[0]
        if not key.startswith(prefix):
            continue
        require(b"\0" in value and len(key) < 512, "pool_value")
        value = value.split(b"\0", 1)[0]
        require(len(value) <= 1022 and value.isascii(), "pool_value")
        suffix = key[len(prefix):].decode("ascii")
        require(suffix == "meta" or re.fullmatch(r"[0-9]{3}", suffix), "pool_key")
        require(suffix not in result, "pool_duplicate")
        result[suffix] = value.decode("ascii")
    return result


def assemble(raw, plan, plan_sha, now):
    records = pool_records(raw, plan["operationId"])
    if not records:
        return None
    # Host writes data chunks FIRST and meta LAST; no partial set is consumed.
    if "meta" not in records:
        return None
    meta = unique_json(records["meta"])
    require(type(meta) is dict and set(meta) == {"operationId", "jobPlanSha256", "runnerId", "runnerGroupId", "sha256",
                                              "chunks", "length", "expiresAt"}, "meta")
    require(meta["operationId"] == plan["operationId"] and meta["jobPlanSha256"] == plan_sha and
            type(meta["runnerGroupId"]) is int and meta["runnerGroupId"] == plan["runnerGroupId"] and
            type(meta["runnerId"]) is int and 0 < meta["runnerId"] <= 9007199254740991 and
            type(meta["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", meta["sha256"]), "binding")
    require(type(meta["chunks"]) is int and 1 <= meta["chunks"] <= 146 and
            type(meta["length"]) is int and 64 <= meta["length"] <= 131072, "bounds")
    require(type(meta["expiresAt"]) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", meta["expiresAt"]), "expiry")
    try:
        expiry = datetime.datetime.strptime(meta["expiresAt"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        raise ValueError("ci_job_jit_expiry") from None
    require(0 < (expiry - now).total_seconds() <= 120, "expired")
    require(set(records) == {"meta"} | {str(n).zfill(3) for n in range(meta["chunks"])}, "incomplete_or_extra")
    encoded = "".join(records[str(n).zfill(3)] for n in range(meta["chunks"]))
    require(len(encoded) == meta["length"] and hashlib.sha256(encoded.encode("ascii")).hexdigest() == meta["sha256"], "hash")
    return decode_config(encoded, plan, meta["runnerId"])


def decode_config(encoded, plan, runner_id):
    config = unique_json(canonical64(encoded, 131072).decode("utf-8-sig"))
    require(type(config) is dict and set(config) == FILES, "files")
    result = {key: canonical64(value, 65536) for key, value in config.items()}
    require(all(2 <= len(value) <= 49152 for value in result.values()), "file_size")
    settings = unique_json(result[".runner"].decode("utf-8-sig"))
    require(type(settings) is dict and settings.get("agentName") == "citygo-ci-job-" + plan["operationId"] and
            type(settings.get("agentId")) is int and settings["agentId"] == runner_id and
            settings.get("ephemeral") is True and settings.get("disableUpdate") is True and
            settings.get("workFolder") == "_work" and settings.get("gitHubUrl") == "https://github.com/CityGo-Tech", "settings")
    # Contents may contain credentials. Validate JSON/shape, never echo values.
    for key in (".credentials", ".credentials_rsaparams"):
        require(type(unique_json(result[key].decode("utf-8-sig"))) is dict, "credential_json")
    return result, runner_id
