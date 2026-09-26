"""Linux operator Worker admission and one-shot runner. Disabled by default.

Shares backup.json's stable state_dir/maintenance.lock with ALL backup entrypoints.
No deployment, scheduler installation, automatic retry/recovery or container removal.
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

import backup as b

ADMISSION = "worker-admission.json"
INSPECT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"RestartCount":{{json .RestartCount}},'
           '"State":{{json .State}},"Labels":{{json .Config.Labels}},'
           '"RestartPolicy":{{json .HostConfig.RestartPolicy.Name}},'
           '"Init":{{json (index .HostConfig "Init")}},'
           '"StopTimeout":{{json (index .Config "StopTimeout")}}}')


def pause(config):
    b.assert_current_config(config)
    state = b.protected(config["state_dir"], directory=True)
    # Independent, short admission lock: pause need not interrupt/wait for an
    # already-admitted transaction or backup. This is NOT a quiescence receipt.
    with b.lock(state, "worker-admission.lock"):
        b.assert_current_config(config)
        path = state / ADMISSION
        if os.path.lexists(path):
            b.protected(path).unlink()
        b.sync_directory(state)


def admission(config, *, inputs=None):
    return {"version": 1, "configuration_sha256": b.configuration_fingerprint(config, inputs=inputs)}


def open_admission(config):
    b.assert_current_config(config)
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state), b.lock(state, "worker-admission.lock"):
        b.assert_current_config(config)
        b.assert_operation_idle(state)
        b.require(not os.path.lexists(state / ADMISSION), "worker-already-open")
        b.atomic_json(state / ADMISSION, admission(config))


def timestamp(value):
    b.require(type(value) is str and value.endswith("Z"), "worker-evidence")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    b.require(parsed.year > 1970, "worker-evidence")
    return parsed


def validate_container(value, project):
    b.require(type(value) is dict, "worker-evidence")
    b.require(re.fullmatch(r"[0-9a-f]{64}", value.get("Id", "")), "worker-evidence")
    b.require(re.fullmatch(r"sha256:[0-9a-f]{64}", value.get("Image", "")), "worker-evidence")
    labels = value.get("Labels", {})
    b.require(labels.get("com.docker.compose.project") == project
              and labels.get("com.docker.compose.service") == "worker"
              and labels.get("com.docker.compose.oneoff") in ("True", "true"), "worker-target")
    b.require(value.get("Init") is True and value.get("StopTimeout") == 90
              and value.get("RestartPolicy") == "no", "worker-runtime")
    b.require(type(value.get("RestartCount")) is int and value["RestartCount"] == 0, "worker-restart")
    state = value.get("State", {})
    b.require(state.get("Status") in ("running", "exited"), "worker-state")
    b.require(state.get("Running") is (state["Status"] == "running"), "worker-state")
    for key in ("Paused", "Restarting", "OOMKilled"):
        b.require(state.get(key) is False, "worker-state")
    b.require(state.get("Error") == "", "worker-state")
    timestamp(state.get("StartedAt"))
    return value


def clean_exit(before, after, project):
    validate_container(before, project)
    validate_container(after, project)
    b.require(all(before[key] == after[key] for key in ("Id", "Image", "RestartCount")), "worker-replaced")
    state = after["State"]
    b.require(before["State"]["StartedAt"] == state["StartedAt"], "worker-replaced")
    b.require(state["Status"] == "exited" and state["Running"] is False
              and type(state.get("ExitCode")) is int and state["ExitCode"] == 0, "worker-failed")
    b.require(timestamp(state.get("FinishedAt")) >= timestamp(state["StartedAt"]), "worker-evidence")


class Docker:
    def __init__(self, config, directory):
        self.env = b.clean_env(directory)
        self.executable = b.executable("docker")
        # Compose must read the bytes that passed admission, not mutable live
        # paths. Preserve the release base directory for relative bind mounts.
        self.compose = ["compose", "--project-directory", str(Path(config["compose_file"]).parent),
                        "--env-file", str(directory / "admitted.env"), "-p", config["project"],
                        "-f", str(directory / "admitted-compose.yml"), "--profile", "ops"]

    def capture(self, args, timeout=30):
        # Only fixed Docker commands; never shell, inherited environment or logs.
        result = subprocess.run([self.executable, *args], env=self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout,
                                start_new_session=True, preexec_fn=b.limits)
        b.require(result.returncode == 0 and len(result.stdout) <= 65536, "worker-transport")
        return result.stdout.decode("utf-8").strip()

    def start(self, name):
        return self.capture([*self.compose, "run", "-d", "--no-deps", "--pull", "never",
                             "--name", name, "-T", "worker"])

    def inspect(self, target):
        return json.loads(self.capture(["inspect", "--format", INSPECT, target]))

    def wait(self, target):
        # Killing/timing out this CLI is NOT proof the container stopped. The
        # durable pending record remains and blocks subsequent managed operations.
        self.capture(["wait", target], timeout=900)


def perform(config, *, transport_factory=Docker):
    b.assert_current_config(config)
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state):
        b.assert_operation_idle(state)
        with b.lock(state, "worker-admission.lock"):
            # A stale caller must not revoke a NEW release's admission marker.
            b.assert_current_config(config)
            b.require(os.path.lexists(state / ADMISSION), "worker-paused")
            marker = b.protected(state / ADMISSION)
            try:
                inputs = b.configuration_inputs(config)
                approved = admission(config, inputs=inputs)
                b.require(b.read_json(marker) == approved, "worker-approval-changed")
            except Exception:
                # Observed configuration drift/invalid input revokes the grant,
                # rather than letting a later file rollback resurrect it.
                marker.unlink()
                b.sync_directory(state)
                raise
            name = "citygo-worker-" + uuid.uuid4().hex
            operation = b.begin_operation(state, "worker", approved["configuration_sha256"], container_name=name)
        # No finally block clears the pending record or retries a failed worker.
        with tempfile.TemporaryDirectory(prefix=".worker-", dir=state) as temp:
            directory = Path(temp)
            for key, filename in (("compose_file", "admitted-compose.yml"), ("compose_env", "admitted.env")):
                fd = os.open(directory / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(inputs[key])
                    stream.flush()
                    os.fsync(stream.fileno())
            docker = transport_factory(config, directory)
            b.assert_current_config(config)
            target = docker.start(name)
            b.require(re.fullmatch(r"[0-9a-f]{64}", target), "worker-target")
            before = validate_container(docker.inspect(target), config["project"])
            b.require(before["Id"] == target and before.get("Name") == "/" + name, "worker-target")
            docker.wait(target)
            after = docker.inspect(target)
            clean_exit(before, after, config["project"])
            # The one-shot may already be exited at first inspect. Exit 0 must
            # still belong to the exact container/process started above.
            receipt = {
                **operation, "container_id": target, "image": after["Image"],
                "started_at": after["State"]["StartedAt"], "finished_at": after["State"]["FinishedAt"],
            }
        b.assert_current_config(config)
        b.verify_operation(state, operation)
        b.atomic_json(state / "worker-last-success.json", receipt)
        b.complete_operation(state, operation)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["pause", "open", "run"])
    parser.add_argument("--config", required=True, help="Same protected backup.json and state_dir as backup/schedule")
    parser.add_argument("--allow-pause", action="store_true")
    parser.add_argument("--allow-open", action="store_true")
    parser.add_argument("--allow-worker", action="store_true")
    args = parser.parse_args(argv)
    try:
        b.require(sys.platform.startswith("linux"), "linux-required")
        os.umask(0o077)
        permission = {"pause": args.allow_pause, "open": args.allow_open, "run": args.allow_worker}[args.operation]
        b.require(permission, "explicit-worker-permission-required")
        config = b.load_config(args.config)
        {"pause": pause, "open": open_admission, "run": perform}[args.operation](config)
        print({"pause": "CityGo Worker: admission paused (active work may remain)",
               "open": "CityGo Worker: admission opened (no job started)",
               "run": "CityGo Worker: verified exit 0"}[args.operation])
        return 0
    except b.BackupError as error:
        # BackupError messages are fixed internal codes, never Docker/driver text.
        print("CityGo Worker: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("CityGo Worker: refused or uncertain; inspect protected state (details hidden)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise b.BackupError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
