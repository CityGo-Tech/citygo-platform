"""Durable closed-ingress sequencing. Only the disposable adapter is wired today."""
from dataclasses import dataclass
import os
from pathlib import Path
import re

from backup import atomic_json
from web_switch import strict_json


class TransitionError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise TransitionError(reason)


@dataclass(frozen=True)
class Epoch:
    link: str
    loaded: str
    boot_id: str
    master: tuple
    workers: frozenset

    def pins(self):
        return {"boot_id": self.boot_id, "master": list(self.master),
                "workers": [list(pin) for pin in sorted(self.workers)]}


PROFILES = {"install": ("legacy", "switch"), "restore": ("switch", "legacy")}
PHASES = ("link-intent", "hup-intent", "verified-closed")


def valid_pid(pin):
    return type(pin) is list and len(pin) == 2 and all(type(n) is int and n > 0 for n in pin)


def valid_pins(pins):
    if type(pins) is not dict or set(pins) != {"boot_id", "master", "workers"}:
        return False
    boot, master, workers = pins["boot_id"], pins["master"], pins["workers"]
    return (type(boot) is str and re.fullmatch("[a-f0-9]{32}", boot) and valid_pid(master)
            and type(workers) is list and 1 <= len(workers) <= 128 and all(valid_pid(pin) for pin in workers)
            and workers == sorted(workers) and len({pin[0] for pin in workers}) == len(workers)
            and master[0] not in {pin[0] for pin in workers})


def observe(host):
    epoch = host.observe_closed()
    require(type(epoch) is Epoch and epoch.link in ("legacy", "switch")
            and epoch.loaded in ("legacy", "switch") and valid_pins(epoch.pins()), "closed-evidence")
    return epoch


def converged(epoch, before, destination):
    current = epoch.pins()
    return (epoch.link == epoch.loaded == destination and current["boot_id"] == before["boot_id"]
            and current["master"] == before["master"]
            and not {tuple(pin) for pin in before["workers"]} & epoch.workers)


def read_record(path, binding):
    require(path.is_file() and not path.is_symlink(), "journal-file")
    with path.open("rb") as stream:
        raw = stream.read(32769)
    require(0 < len(raw) <= 32768, "journal-file")
    record = strict_json(raw)
    require(type(record) is dict and set(record) == {"version", "binding", "phase", "before", "after"}
            and type(record["version"]) is int and record["version"] == 1
            and record["binding"] == binding and record["phase"] in PHASES
            and valid_pins(record["before"])
            and (valid_pins(record["after"]) if record["phase"] == "verified-closed"
                 else record["after"] is None), "journal-binding")
    return record


def transition(path, *, operation, review_sha256, direction, host, resume=False, checkpoint=None):
    """Run under a caller-owned exclusive lock, with fixed trusted paths.

    The adapter owns secure/pinned file operations and live checks. A generic
    503 cannot be treated as a loaded profile. At hup-intent, recovery can only
    record a proven result; it cannot issue or repeat a signal.
    """
    require(type(operation) is str and re.fullmatch("[a-f0-9]{32}", operation)
            and type(review_sha256) is str and re.fullmatch("[a-f0-9]{64}", review_sha256)
            and type(direction) is str and direction in PROFILES, "operation-binding")
    path = Path(path)
    origin, destination = PROFILES[direction]
    binding = {"operation": operation, "review_sha256": review_sha256, "direction": direction}

    def save(record, label):
        atomic_json(path, record)
        if checkpoint is not None:
            checkpoint(label)

    if resume:
        record = read_record(path, binding)
    else:
        require(not os.path.lexists(path), "journal-exists")
        epoch = observe(host)
        require(epoch.link == epoch.loaded == origin, "unexpected-initial-epoch")
        record = {"version": 1, "binding": binding, "phase": "link-intent",
                  "before": epoch.pins(), "after": None}
        save(record, "link-intent")

    before = record["before"]
    if record["phase"] == "link-intent":
        epoch = observe(host)
        require(epoch.pins() == before and epoch.loaded == origin, "initial-epoch-changed")
        if epoch.link == origin:
            host.replace_link(origin, destination)
            if checkpoint is not None:
                checkpoint("link-replaced")
        epoch = observe(host)
        require(epoch.link == destination and epoch.loaded == origin and epoch.pins() == before,
                "link-readback")
        host.test_config()
        require(observe(host) == epoch, "before-hup-changed")
        record["phase"] = "hup-intent"
        save(record, "hup-intent")
        require(observe(host) == epoch, "before-hup-changed")
        host.hup()
        if checkpoint is not None:
            checkpoint("hup-sent")
        host.wait_for_workers(before)

    epoch = observe(host)
    require(converged(epoch, before, destination), "reload-unconfirmed")
    if record["phase"] == "verified-closed":
        require(epoch.pins() == record["after"], "final-epoch-changed")
    else:
        record.update(phase="verified-closed", after=epoch.pins())
        save(record, "verified-closed")
    return record
