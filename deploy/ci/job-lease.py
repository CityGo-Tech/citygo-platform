#!/usr/bin/python3
"""Credential-free absolute lease for one host-admitted disposable CI job.

This validates lifetime/bindings, NOT GitHub admission or network isolation.
No IO, native calls, threads, clock changes or implicit provisioning at import.
"""
import datetime
import hashlib
import json
import math
import re
import time

UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
FIELDS = {"version", "repositoryId", "runId", "runAttempt", "workflowId", "jobId", "workflowPath", "workflowRef",
          "workflowSha256", "headSha", "jobName", "label", "runnerGroupId", "operationId", "gatewayOperationId",
          "jobKey", "createdAt", "hardDeadline", "bootstrapSeconds", "jobSeconds", "cleanupSeconds", "guestVcpu",
          "guestMemoryGiB", "guestDiskGiB"}
NUMBERS = {"version", "repositoryId", "runId", "runAttempt", "workflowId", "jobId", "runnerGroupId", "bootstrapSeconds",
           "jobSeconds", "cleanupSeconds", "guestVcpu", "guestMemoryGiB", "guestDiskGiB"}
SPECS = {".github/workflows/ci.yml": ("verify", 3600),
         ".github/workflows/container-smoke.yml": ("production-images", 2400)}
UTC = datetime.timezone.utc


def require(value, code):
    if not value:
        raise ValueError("ci_job_lease_" + code)


def timestamp(value):
    require(type(value) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value), "time")
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
    except ValueError:
        raise ValueError("ci_job_lease_time") from None


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_key")
        result[key] = value
    return result


def parse_plan(raw, expected_sha, operation, role):
    require(type(raw) is bytes and 2 <= len(raw) <= 16384 and raw.isascii(), "bytes")
    require(type(expected_sha) is str and re.fullmatch(r"[a-f0-9]{64}", expected_sha) and
            hashlib.sha256(raw).hexdigest() == expected_sha, "hash")
    try:
        plan = json.loads(raw.decode("ascii"), object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: require(False, "constant"))
    except (ValueError, TypeError, UnicodeError):
        raise ValueError("ci_job_lease_json") from None
    validate_plan(plan, operation, role)
    return plan


def validate_plan(plan, operation, role):
    require(type(plan) is dict and set(plan) == FIELDS and role in ("client", "gateway"), "shape")
    require(all(type(plan[key]) is int and 0 < plan[key] <= 9007199254740991 for key in NUMBERS), "number")
    require(all(type(plan[key]) is str for key in FIELDS - NUMBERS), "scalar")
    require(all(re.fullmatch(UUID, plan[key]) for key in ("operationId", "gatewayOperationId")) and
            plan["operationId"] != plan["gatewayOperationId"] and
            operation == plan["gatewayOperationId" if role == "gateway" else "operationId"], "operation")
    require(plan["workflowPath"] in SPECS, "workflow")
    name, seconds = SPECS[plan["workflowPath"]]
    require(plan["jobName"] == name and plan["jobSeconds"] == seconds and plan["version"] == 1 and
            plan["bootstrapSeconds"] == 600 and plan["cleanupSeconds"] == 180 and
            (plan["guestVcpu"], plan["guestMemoryGiB"], plan["guestDiskGiB"]) == (4, 6, 96), "resources")
    require(plan["jobKey"] == "-".join(str(plan[key]) for key in ("workflowId", "runId", "runAttempt", "jobId")) and
            plan["label"] == "citygo-ci-" + str(plan["runId"]) + "-" + str(plan["runAttempt"]) + "-" + name, "job")
    require(re.fullmatch(r"[a-f0-9]{64}", plan["workflowSha256"]) and re.fullmatch(r"[a-f0-9]{40}", plan["headSha"]), "source")
    require(re.fullmatch(re.escape("CityGo-Tech/citygo-platform/" + plan["workflowPath"]) +
                         r"@(?:[a-f0-9]{40}|refs/heads/main|refs/pull/[1-9][0-9]*/merge)", plan["workflowRef"]), "ref")
    created, hard = timestamp(plan["createdAt"]), timestamp(plan["hardDeadline"])
    require((hard - created).total_seconds() == 600 + seconds + 180, "deadline")
    return created, hard - datetime.timedelta(seconds=180)


class Lease:
    """One immutable deadline; UTC AND monotonic bounds can only shorten it.

    Construct once before enabling forwarding/listener. Never reconstruct from
    heartbeats, observed progress, restart time or a new duration from the guest.
    """
    __slots__ = ("__deadline", "__start", "__remaining", "__last_wall", "__last_tick", "__now", "__clock")

    def __init__(self, plan, operation, role, now=None, clock=time.monotonic):
        created, deadline = validate_plan(plan, operation, role)
        self.__now = now or (lambda: datetime.datetime.now(UTC))
        self.__clock = clock
        wall, tick = self.__now(), self.__clock()
        require(type(wall) is datetime.datetime and wall.tzinfo is UTC and type(tick) in (int, float) and math.isfinite(tick), "clock")
        remaining = (deadline - wall).total_seconds()
        require(created <= wall and 0 < remaining <= 600 + plan["jobSeconds"], "expired_or_future")
        self.__deadline, self.__start, self.__remaining = deadline, tick, remaining
        self.__last_wall, self.__last_tick = wall, tick

    @property
    def deadline(self):
        return self.__deadline

    def remaining(self):
        wall, tick = self.__now(), self.__clock()
        require(type(wall) is datetime.datetime and wall.tzinfo is UTC and type(tick) in (int, float) and math.isfinite(tick), "clock")
        require(wall >= self.__last_wall and tick >= self.__last_tick, "clock_rollback")
        self.__last_wall, self.__last_tick = wall, tick
        return max(0, min((self.__deadline - wall).total_seconds(), self.__remaining - (tick - self.__start)))

    def require_live(self):
        require(self.remaining() > 0, "expired")
