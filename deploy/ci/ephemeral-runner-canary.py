#!/usr/bin/python3
"""One unique-label, one-job GitHub canary in an externally disposable guest.

The public seed NEVER contains GitHub credentials. The host injects a scoped
one-hour registration token over KVP only after independently accepting the
network witness. This script cannot access the host management credential.
No CI/deploy routing, application keys, checkout or paid services are enabled.
"""
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import time
import types


SCRIPT = "/usr/local/sbin/citygo-ephemeral-runner-canary.py"
NETWORK = "/usr/local/lib/citygo-ci/private-network-canary.py"
HELPER = "/usr/local/lib/citygo-ci/offline-clone-canary.py"
CONFIG = "/var/lib/citygo-ci-runner/config.json"
NETWORK_SHA = "e8422c658bb08c456db75b248d74c74a911a0dedf0b2019da842d5e6d85ae1ef"
HELPER_SHA = "c10465066ce2908fa72d6416811a6bc426c96aef90584b8c0639e9a45a97e0b4"
REPOSITORY = "CityGo-Tech/citygo-platform"
VERSION = "2.338.0"
ARCHIVE_SIZE = 227660598
ARCHIVE_SHA = "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"
DOWNLOAD = "https://github.com/actions/runner/releases/download/v" + VERSION + "/actions-runner-linux-x64-" + VERSION + ".tar.gz"
ROOT = "/opt/citygo-actions-runner"
POOL = "/var/lib/hyperv/.kvp_pool_0"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
ENV = {"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/home/ci-runner"}


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(value, code):
    if not value:
        raise Refused(code)


def read_root(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "root_file_required")
        raw = os.read(fd, limit + 1)
        require(len(raw) <= limit, "file_too_large")
        return raw
    finally:
        os.close(fd)


def load(path, expected, name):
    raw = read_root(path, 131072)
    require(hashlib.sha256(raw).hexdigest() == expected, "library_pin_invalid")
    module = types.ModuleType(name)
    exec(compile(raw, path, "exec"), module.__dict__)
    return module


def config(value, network):
    require(type(value) is dict and set(value) == {"schemaVersion", "operationId", "gatewayOperationId", "hostSnapshotSha256", "mac", "hostIPv4", "productionIPv4"}, "config_invalid")
    network.client_config(value)
    return value


def validate_seed(guest, value):
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
            guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() == ("citygo-runner-canary-" + value["operationId"]).encode("ascii"), "instance_invalid")
    seed = guest.seed()
    require(type(seed) is dict and set(seed) == {"write_files", "runcmd"}, "seed_invalid")
    paths = ((SCRIPT, "0700"), (NETWORK, "0600"), (HELPER, "0600"), (CONFIG, "0600"))
    require(type(seed["write_files"]) is list and len(seed["write_files"]) == len(paths), "seed_invalid")
    for item, (path, mode) in zip(seed["write_files"], paths):
        require(type(item) is dict and set(item) == {"path", "owner", "permissions", "encoding", "content"} and
                item["path"] == path and item["owner"] == "root:root" and item["permissions"] == mode and item["encoding"] == "b64", "seed_invalid")
        try:
            raw = base64.b64decode(item["content"], validate=True)
        except (ValueError, TypeError):
            raise Refused("seed_invalid") from None
        require(raw == read_root(path, 131072), "seed_changed")
    require(seed["runcmd"] == [["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", value["operationId"],
                                  "--acknowledge", "RUN_EPHEMERAL_CANARY:" + value["operationId"]]], "seed_command_invalid")


def auth_record(raw, operation, now, unique_json):
    """Only one exact host KVP record, never pool 1 or an arbitrary file."""
    require(type(raw) is bytes and len(raw) <= 2560 * 400 and len(raw) % 2560 == 0, "kvp_shape_invalid")
    key = ("CityGoRunnerAuth-" + operation).encode("ascii")
    found = []
    for offset in range(0, len(raw), 2560):
        name = raw[offset:offset + 512]
        require(b"\0" in name, "kvp_name_invalid")
        if name.split(b"\0", 1)[0] == key:
            data = raw[offset + 512:offset + 2560]
            require(b"\0" in data, "kvp_value_invalid")
            found.append(data.split(b"\0", 1)[0])
    require(len(found) <= 1, "kvp_auth_duplicate")
    if not found:
        return None
    require(len(found[0]) <= 1022 and found[0].isascii(), "kvp_auth_invalid")
    value = unique_json(found[0].decode("ascii"))
    require(type(value) is dict and set(value) == {"operationId", "repository", "token", "expiresAt"} and
            value["operationId"] == operation and value["repository"] == REPOSITORY and
            type(value["token"]) is str and re.fullmatch(r"[A-Za-z0-9_-]{20,512}", value["token"]), "kvp_auth_invalid")
    try:
        expiry = datetime.datetime.strptime(value["expiresAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        raise Refused("kvp_auth_time_invalid") from None
    require(30 <= (expiry - now).total_seconds() <= 3660, "kvp_auth_expired")
    return value["token"]


def read_auth(operation, unique_json):
    # The daemon uses POSIX record locking. Never mutate the host KVP pool.
    import fcntl
    fd = os.open(POOL, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "kvp_owner_invalid")
        end = time.monotonic() + 3
        while True:
            try:
                fcntl.lockf(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < end, "kvp_lock_timeout")
                time.sleep(0.05)
        path = os.lstat(POOL)
        require(path.st_ino == item.st_ino and path.st_dev == item.st_dev, "kvp_path_changed")
        return auth_record(os.pread(fd, 2560 * 400 + 1, 0), operation, datetime.datetime.now(datetime.timezone.utc), unique_json)
    finally:
        os.close(fd)


def registration_args(operation, token):
    require(type(operation) is str and re.fullmatch(UUID, operation) and type(token) is str and
            re.fullmatch(r"[A-Za-z0-9_-]{20,512}", token), "registration_arguments_invalid")
    return [ROOT + "/config.sh", "--unattended", "--url", "https://github.com/" + REPOSITORY, "--token", token,
            "--name", "citygo-ci-canary-" + operation, "--labels", "citygo-ci-canary-" + hashlib.sha256(operation.encode("ascii")).hexdigest()[:16],
            "--no-default-labels", "--ephemeral", "--disableupdate", "--work", "_work"]


def native(args, timeout, uid=None, gid=None, groups=None, cwd="/"):
    try:
        done = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                              timeout=timeout, env=ENV, cwd=cwd, user=uid, group=gid, extra_groups=groups, check=False)
    except subprocess.TimeoutExpired:
        raise Refused("runner_command_timeout") from None
    except OSError:
        raise Refused("runner_command_unavailable") from None
    require(done.returncode == 0, "runner_command_failed")


def install_runner():
    require(not os.path.lexists(ROOT) and not os.path.lexists("/home/ci-runner"), "runner_namespace_exists")
    os.mkdir(ROOT, 0o700)
    archive = ROOT + "/runner.tar.gz"
    native(["/usr/bin/curl", "--disable", "--silent", "--fail", "--location", "--max-redirs", "3", "--proto", "=https",
            "--proto-redir", "=https", "--noproxy", "*", "--connect-timeout", "15", "--max-time", "240",
            "--max-filesize", str(ARCHIVE_SIZE), "--output", archive, DOWNLOAD], 245)
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_size == ARCHIVE_SIZE, "runner_archive_size_invalid")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            require(hashlib.file_digest(stream, "sha256").hexdigest() == ARCHIVE_SHA, "runner_archive_hash_invalid")
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode="r:gz") as source:
                members = source.getmembers()
                require(len(members) <= 30000 and sum(x.size for x in members) <= 2 * 1024**3, "runner_archive_bounds")
                # Python 3.12 data filter also rejects traversal, device nodes,
                # escaping links and unsafe attributes in the hash-pinned tar.
                source.extractall(ROOT, members=members, filter="data")
    finally:
        os.close(fd)
    os.unlink(archive)
    native(["/usr/sbin/useradd", "--create-home", "--shell", "/usr/sbin/nologin", "--groups", "docker", "ci-runner"], 10)
    import grp
    import pwd
    account = pwd.getpwnam("ci-runner")
    require(account.pw_uid >= 1000 and account.pw_uid != 0 and account.pw_dir == "/home/ci-runner", "runner_uid_invalid")
    native(["/usr/bin/chown", "--recursive", "--no-dereference", "ci-runner:ci-runner", ROOT], 20)
    os.chmod(ROOT, 0o700)
    return account.pw_uid, account.pw_gid, [grp.getgrnam("docker").gr_gid]


def main(arguments):
    if len(arguments) == 3 and arguments[:2] == ["--plan", "--operation-id"] and re.fullmatch(UUID, arguments[2]):
        print('{"stage":"plan_only_unverified","runnerRegistered":false}')
        return 0
    if not (len(arguments) == 5 and arguments[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, arguments[2]) and
            arguments[3:] == ["--acknowledge", "RUN_EPHEMERAL_CANARY:" + arguments[2]]):
        print('{"stage":"refused","runnerRegistered":false}')
        return 2
    guest, phase, operation = None, "identity", arguments[2]
    try:
        require(sys.platform == "linux" and os.geteuid() == 0 and sys.version_info[:2] == (3, 12), "trusted_linux_required")
        helper = load(HELPER, HELPER_SHA, "citygo_runner_kvp")
        network = load(NETWORK, NETWORK_SHA, "citygo_runner_network")
        guest = network.connected_client_type(helper)()
        value = config(helper.unique_json(read_root(CONFIG, 32768).decode("ascii")), network)
        require(value["operationId"] == operation, "operation_changed")
        validate_seed(guest, value)
        phase = "synthetic_network_probes"
        proof = network.probe_client(guest, value, True)
        # A waiting report is not permission to register: only the external
        # controller can supply the operation-scoped token after its witness.
        phase = "install_public_runner"
        uid, gid, groups = install_runner()
        report = dict(version=1, scope="ephemeral_ci_runner_canary", operationId=operation, stage="waiting_host_registration",
                      gatewayOperationId=value["gatewayOperationId"], hostSnapshotSha256=value["hostSnapshotSha256"],
                      versionInstalled=VERSION, archiveSha256=ARCHIVE_SHA, runnerRegistered=False, ciJobsAdmitted=False,
                      negativeProbeCount=proof["negativeProbeCount"], linkProbeFramesSent=proof["linkProbeFramesSent"],
                      observedGatewayMac=proof["observedGatewayMac"])
        guest.publish(operation, helper.report_bytes(report))
        phase = "wait_host_registration"
        end, token = time.monotonic() + 120, None
        while time.monotonic() < end:
            token = read_auth(operation, helper.unique_json)
            if token:
                break
            time.sleep(1)
        require(token is not None, "registration_not_supplied")
        phase = "configure_ephemeral"
        native(registration_args(operation, token), 75, uid, gid, groups, ROOT)
        token = None
        report.update(stage="configured_ephemeral", runnerRegistered=True)
        guest.publish(operation, helper.report_bytes(report))
        phase = "run_one_job"
        native([ROOT + "/run.sh"], 300, uid, gid, groups, ROOT)
        report.update(stage="runner_process_exited")
        guest.publish(operation, helper.report_bytes(report))
        print('{"stage":"runner_process_exited","githubJobConclusionRequiresHostReadback":true}')
        return 0
    except Exception as error:
        if guest is not None:
            try:
                code = getattr(error, "code", "runner_native_failed")
                if type(code) is not str or not re.fullmatch(r"[a-z_]{1,64}", code):
                    code = "runner_native_failed"
                guest.publish(operation, json.dumps(dict(version=1, scope="ephemeral_ci_runner_canary", operationId=operation,
                    stage="failed_preserved", phase=phase, code=code, ciJobsAdmitted=False), separators=(",", ":")).encode("ascii"))
            except Exception:
                pass
        # Never print an exception, command line, token, environment or logs.
        print('{"stage":"failed_preserved","ciJobsAdmitted":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
