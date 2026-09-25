"""Internal one-shot migration transport/evidence, NOT a deployment command.

Only a future trusted controller may call this inside the live release window,
after independent migration approval, image selection, closed ingress and drain.
The mandatory guard must recheck those conditions; a backup is NOT permission.
No CLI, approval writer, resume, retry, cleanup of containers or traffic opening.
"""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

import backup as b
import image_gate as g
import release as r
import target as t
import worker as w

INPUT_LIMIT = 524288
OUTPUT_LIMIT = 262144
MEMORY = 256 * 1024 * 1024
INSPECT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
           '"RestartCount":{{json .RestartCount}},"State":{{json .State}},'
           '"Config":{"Image":{{json .Config.Image}},"User":{{json .Config.User}},'
           '"WorkingDir":{{json .Config.WorkingDir}},"Entrypoint":{{json .Config.Entrypoint}},'
           '"Cmd":{{json .Config.Cmd}},"OpenStdin":{{json .Config.OpenStdin}},'
           '"Tty":{{json .Config.Tty}},"Labels":{{json .Config.Labels}}},'
           '"HostConfig":{{json .HostConfig}},"Mounts":{{json .Mounts}}}')


def wire(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def inventory(value):
    b.require(type(value) is list and 1 <= len(value) <= 1000, "migration-inventory")
    previous = 0
    for item in value:
        t.keys(item, {"name", "sha256"}, "migration-inventory")
        b.require(t.matches(item["name"], r"[0-9]{4}_[a-z0-9_]+\.sql")
                  and t.matches(item["sha256"], t.HASH), "migration-inventory")
        number = int(item["name"][:4])
        b.require(number > previous, "migration-order")
        previous = number


def request(value, operation):
    t.keys(value, {"version", "kind", "operationId", "targetSha", "currentMigrations",
                   "targetMigrations", "grantsSha256"}, "migration-request")
    b.require(type(value["version"]) is int and value["version"] == 1
              and value["kind"] == "citygo-release-migration", "migration-request")
    b.require(t.matches(value["operationId"], r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
              and value["operationId"] == str(uuid.UUID(operation["id"])) and value["targetSha"] == operation["target_sha"]
              and t.matches(value["targetSha"], t.SHA) and t.matches(value["grantsSha256"], t.HASH), "migration-binding")
    inventory(value["currentMigrations"]); inventory(value["targetMigrations"])
    b.require(value["targetMigrations"][:len(value["currentMigrations"])] == value["currentMigrations"], "migration-prefix")
    data = wire(value)
    b.require(len(data) <= INPUT_LIMIT, "migration-input-size")
    return data


def result(data, plan, request_bytes):
    value = t.strict_json(data)
    expected = {"version": 1, "kind": "citygo-release-migration-result", "operationId": plan["operationId"],
                "targetSha": plan["targetSha"], "requestSha256": t.sha256(request_bytes),
                "applied": plan["targetMigrations"][len(plan["currentMigrations"]):],
                "grantsSha256": plan["grantsSha256"], "committed": True, "trafficAuthorized": False}
    # Serialized comparison distinguishes bool from int (Python True == 1).
    b.require(json.dumps(value, sort_keys=True) == json.dumps(expected, sort_keys=True), "migration-result")
    return expected


def secret_bytes(path):
    data = t.read_file(path)  # Root-owned/read-only is permitted for Docker secrets.
    b.require(len(data) <= 16384, "migration-secret")
    value = t.strict_json(data)
    t.keys(value, {"DATABASE_URL"}, "migration-secret")
    url = value["DATABASE_URL"]
    b.require(type(url) is str and not re.search(r"[\x00-\x20]", url), "migration-secret")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in ("postgres", "postgresql") and parsed.username == "citygo_migrator"
                 and bool(parsed.password) and parsed.hostname == "postgres" and parsed.port == 5432
                 and parsed.path == "/citygo_pilot" and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    b.require(valid, "migration-secret")
    return data


def container(value, expected, *, phase):
    b.require(type(value) is dict, "migration-container")
    b.require(value.get("Id") == expected["container_id"] and value.get("Name") == "/" + expected["container_name"]
              and value.get("Image") in (expected["image"]["local_id"], expected["image"]["config_id"]), "migration-container-identity")
    b.require(type(value.get("RestartCount")) is int and value["RestartCount"] == 0, "migration-container-restarted")
    cfg, host, state = value.get("Config", {}), value.get("HostConfig", {}), value.get("State", {})
    b.require(cfg.get("Image") == expected["image"]["local_id"] and cfg.get("User") == "1000:1000"
              and cfg.get("WorkingDir") == "/app" and cfg.get("Entrypoint") == ["node"]
              and cfg.get("Cmd") == ["scripts/container-runtime.mjs", "migrate-release"]
              and cfg.get("OpenStdin") is True and cfg.get("Tty") is False, "migration-command")
    labels = cfg.get("Labels", {})
    for key, val in labels_for(expected).items():
        b.require(labels.get(key) == val, "migration-labels")
    b.require(host.get("NetworkMode") == expected["network_id"] and host.get("ReadonlyRootfs") is True
              and host.get("Init") is True and host.get("Privileged") is False and host.get("AutoRemove") is False
              and host.get("Memory") == MEMORY and host.get("MemorySwap") == MEMORY
              and host.get("PidsLimit") == 128 and host.get("RestartPolicy", {}).get("Name") == "no"
              and host.get("CapDrop") == ["ALL"] and host.get("SecurityOpt") == ["no-new-privileges"], "migration-runtime")
    mounts = value.get("Mounts")
    b.require(type(mounts) is list and len(mounts) == 1, "migration-mounts")
    mount = mounts[0]
    b.require(mount.get("Type") == "bind" and mount.get("Source") == expected["secret_snapshot"]
              and mount.get("Destination") == "/run/secrets/migrate.json" and mount.get("RW") is False, "migration-mounts")
    b.require(phase in ("created", "running", "exited")
              and state.get("Status") == phase and state.get("Running") is (phase == "running")
              and all(state.get(key) is False for key in ("Paused", "Restarting", "OOMKilled", "Dead"))
              and state.get("Error") == "", "migration-state")
    if phase != "created":
        w.timestamp(state.get("StartedAt"))
    if phase == "exited":
        b.require(type(state.get("ExitCode")) is int and state["ExitCode"] == 0, "migration-exit")
        b.require(w.timestamp(state.get("FinishedAt")) >= w.timestamp(state.get("StartedAt")), "migration-timestamps")
    return value


def labels_for(expected):
    return {"com.docker.compose.project": expected["project"], "com.docker.compose.service": "migrator",
            "com.docker.compose.oneoff": "True", "citygo.operation": expected["operation_id"],
            "citygo.request-sha256": expected["request_sha256"]}


def output_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT, OUTPUT_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


class Docker(w.Docker):
    def create(self, expected):
        args = ["create", "--pull", "never", "--name", expected["container_name"], "--interactive",
                "--init", "--read-only", "--user", "1000:1000", "--workdir", "/app",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--restart", "no",
                "--memory", str(MEMORY), "--memory-swap", str(MEMORY), "--pids-limit", "128",
                "--stop-timeout", "30", "--network", expected["network_id"],
                "--tmpfs", "/tmp:size=64m,mode=1777", "--log-driver", "json-file",
                "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--no-healthcheck",
                "--env", "CITYGO_MOUNTED_CONFIG=1", "--mount",
                "type=bind,src=" + expected["secret_snapshot"] + ",dst=/run/secrets/migrate.json,readonly"]
        for key, value in labels_for(expected).items(): args += ["--label", key + "=" + value]
        # Use the verified immutable LOCAL ID, not a tag or a registry resolution.
        return self.capture([*args, "--entrypoint", "node", expected["image"]["local_id"],
                             "scripts/container-runtime.mjs", "migrate-release"])

    def inspect(self, target):
        return t.strict_json(self.capture(["inspect", "--format", INSPECT, target]).encode())

    def execute(self, expected, data, output):
        # Bounded file instead of an unbounded stdout pipe. A timeout kills only
        # the CLI, NOT proof of container termination or rollback. Never retry.
        request_path = output.parent / "request.json"
        fd = os.open(request_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream: stream.write(data)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        child = None
        begun = time.monotonic()
        with os.fdopen(fd, "wb") as stream, request_path.open("rb") as source:
            try:
                child = subprocess.Popen([self.executable, "start", "--attach", "--interactive", expected["container_id"]],
                    stdin=source, env=self.env, stdout=stream, stderr=subprocess.DEVNULL,
                    start_new_session=True, preexec_fn=output_limits)
                # Capture the first running OR already-exited process, then bind
                # the final evidence to its StartedAt (fast jobs are supported).
                while True:
                    observed = self.inspect(expected["container_id"])
                    phase = observed.get("State", {}).get("Status")
                    if phase in ("running", "exited"):
                        started = container(observed, expected, phase=phase)
                        break
                    container(observed, expected, phase="created")
                    b.require(time.monotonic() - begun < 10 and child.poll() is None, "migration-start-unconfirmed")
                    time.sleep(0.1)
                b.require(child.wait(timeout=max(0.1, 180 - (time.monotonic() - begun))) == 0, "migration-transport")
                stream.flush(); os.fsync(stream.fileno())
            finally:
                b.stop(child)  # Docker client only. The container remains.
        return t.read_file(output, private=True), started


def _execute_in_window(window, plan, reference, tested_id, network_id, secret_file, *,
                       allow_migration=False, guard=None, transport_factory=Docker, image_store_factory=g.Store):
    """Trusted-controller primitive only. `guard` must reverify independent
    approval, exact selected inventory, ingress/drain/network before every step.
    Current prepare() does not call this; no production entrypoint is exposed.
    """
    b.require(allow_migration is True and callable(guard), "explicit-migration-permission-required")
    b.require(sys.platform.startswith("linux") and type(window) is r._Window, "migration-live-window-required")
    window._check_owner()
    b.require(not window._migration_attempted, "migration-already-attempted")
    window._migration_attempted = True  # Observed drift also poisons this attempt.
    window._check()
    checkpoint = copy.deepcopy(window._checkpoint)
    operation, config, state = copy.deepcopy(window._operation), copy.deepcopy(window._config), window._state
    b.require(type(checkpoint) is dict and checkpoint["operation_id"] == operation["id"]
              and checkpoint["target_sha"] == operation["target_sha"]
              and 0 <= time.time() - checkpoint["verified_at"] <= 900, "migration-fresh-backup-required")
    b.require(t.matches(reference, r"ghcr\.io/citygo-tech/citygo-platform-jobs@" + t.DIGEST)
              and t.matches(tested_id, t.DIGEST) and t.matches(network_id, t.HASH), "migration-target")
    plan = copy.deepcopy(plan)
    data = request(plan, operation)
    secret_file = Path(secret_file)
    secret = secret_bytes(secret_file)
    store = image_store_factory(state)
    image = g.verify_image(store, reference, tested_id, operation["target_sha"])

    def check():
        window._check()
        b.require(window._checkpoint == checkpoint and b.read_json(b.protected(state / "release-backup.json")) == checkpoint
                  and 0 <= time.time() - checkpoint["verified_at"] <= 900, "migration-backup-changed")
        b.require(secret_bytes(secret_file) == secret, "migration-secret-changed")
        b.require(g.verify_image(store, reference, tested_id, operation["target_sha"]) == image, "migration-image-changed")
        guard()
        window._check()
        b.require(0 <= time.time() - checkpoint["verified_at"] <= 900, "migration-backup-changed")

    check()
    expected = {"version": 1, "operation_id": operation["id"], "project": config["project"],
                "container_name": "citygo-migrate-" + operation["id"].replace("-", ""),
                "target_sha": operation["target_sha"], "image": image, "network_id": network_id,
                "request_sha256": t.sha256(data)}
    intent = state / ("migration-" + operation["id"] + ".intent.json")
    intent_record = copy.deepcopy(expected)
    intent_bytes = wire(intent_record)
    for suffix in ("container", "success"):
        b.require(not os.path.lexists(state / ("migration-" + operation["id"] + "." + suffix + ".json")), "migration-prior-evidence")
    # Exclusive, fsynced intent BEFORE Docker create/start. Retained even if
    # creation, transport, COMMIT acknowledgement or receipt persistence fails.
    fd = os.open(intent, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(intent_bytes); stream.flush(); os.fsync(stream.fileno())
    b.sync_directory(state)
    with tempfile.TemporaryDirectory(prefix=".migration-", dir=state) as temp:
        directory = Path(temp)
        snapshot = directory / "migrate.json"
        snapshot.write_bytes(secret); snapshot.chmod(0o444)
        expected["secret_snapshot"] = str(snapshot)
        b.require(not re.search(r"[,\x00-\x1f]", str(snapshot)), "migration-mount-path")
        transport = transport_factory(config, directory)
        check()
        b.require(t.read_file(intent, private=True) == intent_bytes, "migration-intent-changed")
        ident = transport.create(expected)
        b.require(t.matches(ident, t.HASH), "migration-container-id")
        expected["container_id"] = ident
        before = container(transport.inspect(ident), expected, phase="created")
        b.require(t.read_file(intent, private=True) == intent_bytes, "migration-intent-changed")
        b.atomic_json(state / ("migration-" + operation["id"] + ".container.json"), {**intent_record, "container_id": ident})
        check()
        raw, started = transport.execute(expected, data, directory / "result.json")
        container(started, expected, phase=started.get("State", {}).get("Status"))
        after = container(transport.inspect(ident), expected, phase="exited")
        b.require(before["Image"] == after["Image"] == started["Image"]
                  and started["State"]["StartedAt"] == after["State"]["StartedAt"], "migration-container-replaced")
        received = result(raw, plan, data)
        check()
        proof = {"version": 1, "operation_id": operation["id"], "target_sha": operation["target_sha"],
                 "container_id": ident, "image": image, "request_sha256": t.sha256(data),
                 "started_at": after["State"]["StartedAt"], "finished_at": after["State"]["FinishedAt"],
                 "result": received, "traffic_authorized": False}
    check()  # Failed local cleanup must not publish success either.
    b.require(t.read_file(intent, private=True) == intent_bytes, "migration-intent-changed")
    b.atomic_json(state / ("migration-" + operation["id"] + ".success.json"), proof)
    return copy.deepcopy(proof)
