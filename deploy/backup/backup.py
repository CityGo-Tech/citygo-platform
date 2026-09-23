#!/usr/bin/env python3
"""Linux operator tool: pg_dump -> age -> explicit Cloud.ru S3 upload.

No shell, dotenv, plaintext spool, remote deletion, scheduler or restore-to-live.
Only public age recipient lives on the server. Production activation is manual.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager

MAX_BYTES = 1024 ** 3  # Deliberately no multipart upload: pilot limit is 1 GiB.
MIN_FREE = 8 * 1024 ** 3
MAX_AGE = 7200
ENDPOINT = "https://s3.cloud.ru"
SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"
FIELDS = {
    "version", "upload_enabled", "source_sha", "project", "compose_file",
    "compose_env", "state_dir", "recipient", "storage_credentials_file",
    "endpoint", "bucket", "prefix",
}


class BackupError(Exception):
    """Deliberately contains only a fixed, non-sensitive failure code."""


def require(condition, code="configuration"):
    if not condition:
        raise BackupError(code)


def validate(config):
    require(type(config) is dict and set(config) == FIELDS)
    require(type(config["version"]) is int and config["version"] == 1)
    require(type(config["upload_enabled"]) is bool)
    for key in FIELDS - {"version", "upload_enabled"}:
        require(type(config[key]) is str and not re.search(r"[\x00-\x1f]", config[key]))
    require(re.fullmatch(r"[0-9a-f]{40}", config["source_sha"]))
    require(re.fullmatch(r"citygo-[a-z0-9][a-z0-9-]{0,62}", config["project"]))
    # Native X25519 recipient only; no plugins, shell commands, passphrases or SSH.
    require(re.fullmatch(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}", config["recipient"]))
    require(config["endpoint"] == ENDPOINT)
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", config["bucket"]))
    require(re.fullmatch(r"citygo/[a-z0-9][a-z0-9-]{0,62}", config["prefix"]))
    for key in ("compose_file", "compose_env", "state_dir", "storage_credentials_file"):
        require(PurePosixPath(config[key]).is_absolute() and ".." not in PurePosixPath(config[key]).parts)
    return config


def protected(path, directory=False, private=True):
    """The operator owns the inputs; reject writable ancestors and symlinks."""
    path = Path(path)
    require(path.is_absolute(), "permissions")
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), "permissions")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "permissions")
    require(info.st_uid == os.geteuid(), "permissions")
    require(not info.st_mode & (0o077 if private else 0o022), "permissions")
    for parent in path.parents:
        p = parent.lstat()
        require(stat.S_ISDIR(p.st_mode) and p.st_uid in (0, os.geteuid()), "permissions")
        # A private, owned child in sticky /tmp is safe for the disposable CI fixture.
        require(not p.st_mode & 0o022 or bool(p.st_mode & stat.S_ISVTX), "permissions")
    return path


def read_json(path):
    require(path.stat().st_size <= 65536, "configuration")
    return json.loads(path.read_text(encoding="utf-8"))


def load_config(path):
    require(sys.platform.startswith("linux"), "linux-required")
    return validate(read_json(protected(path)))


def clean_env(home):
    # No inherited credentials, proxies, custom CAs, Docker hosts or CLI plugins.
    return {
        "PATH": SAFE_PATH, "HOME": str(home), "LANG": "C.UTF-8", "TZ": "UTC",
        "DOCKER_CONFIG": str(home / "docker"), "DOCKER_HOST": "unix:///var/run/docker.sock",
    }


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def stop(child):
    if child and child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def run(args, env, timeout=600):
    child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, preexec_fn=limits)
    try:
        require(child.wait(timeout=timeout) == 0, "command-failed")
    finally:
        stop(child)


def executable(name):
    value = shutil.which(name, path=SAFE_PATH)
    require(value is not None, "tool-missing")
    return value


def digest(path):
    sha, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(block)
            require(size <= MAX_BYTES, "size-limit")
            sha.update(block)
            md5.update(block)
    require(size > 0, "empty-file")
    return size, sha.hexdigest(), base64.b64encode(md5.digest()).decode("ascii")


class S3:
    def __init__(self, config, directory):
        credentials = read_json(protected(config["storage_credentials_file"]))
        require(type(credentials) is dict and set(credentials) == {"access_key_id", "secret_access_key"})
        require(all(type(v) is str and 1 <= len(v) <= 512 and not re.search(r"[\x00-\x20]", v)
                    for v in credentials.values()))
        self.env = {
            "PATH": SAFE_PATH, "HOME": str(directory), "LANG": "C.UTF-8",
            "AWS_ACCESS_KEY_ID": credentials["access_key_id"],
            "AWS_SECRET_ACCESS_KEY": credentials["secret_access_key"],
            "AWS_CONFIG_FILE": str(directory / "aws-config"),
            "AWS_SHARED_CREDENTIALS_FILE": str(directory / "unused-credentials"),
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_PAGER": "",
            "AWS_MAX_ATTEMPTS": "2", "AWS_RETRY_MODE": "standard",
            "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
            "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
        }
        (directory / "aws-config").write_text("[default]\ns3 =\n    addressing_style = path\n", encoding="utf-8")
        self.args = [executable("aws"), "--endpoint-url", ENDPOINT, "--region", "ru-central-1",
                     "--no-cli-pager", "--cli-connect-timeout", "15", "--cli-read-timeout", "60", "s3api"]
        self.bucket = config["bucket"]

    def put(self, key, path):
        size, sha, md5 = digest(path)
        run([*self.args, "put-object", "--bucket", self.bucket, "--key", key,
             "--body", str(path), "--content-length", str(size), "--content-md5", md5,
             "--metadata", f"sha256={sha}", "--content-type", "application/octet-stream"], self.env)

    def get(self, key, path):
        run([*self.args, "get-object", "--bucket", self.bucket, "--key", key, str(path)], self.env)


def encrypt(config, destination, env, *, timeout=900):
    docker, age = executable("docker"), executable("age")
    name = "citygo-backup-" + uuid.uuid4().hex
    args = [docker, "compose", "--env-file", config["compose_env"], "-p", config["project"],
            "-f", config["compose_file"], "--profile", "ops", "run", "--rm", "--no-deps",
            "--pull", "never", "--name", name, "-T", "backup"]
    producer = consumer = None
    started = time.monotonic()
    try:
        producer = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=limits)
        with destination.open("xb") as output:
            consumer = subprocess.Popen([age, "--encrypt", "--recipient", config["recipient"]],
                                        env=env, stdin=producer.stdout, stdout=output,
                                        stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=limits)
            producer.stdout.close()
            require(consumer.wait(timeout=timeout) == 0, "encrypt-failed")
            remaining = max(0.1, timeout - (time.monotonic() - started))
            # age can succeed on partial stdin. Never upload until pg_dump also exits 0.
            require(producer.wait(timeout=remaining) == 0, "dump-failed")
            output.flush()
            os.fsync(output.fileno())
        require(destination.stat().st_size > 100, "empty-file")
    finally:
        stop(consumer)
        stop(producer)
        # A killed Docker CLI does not necessarily stop its container. Exact random name only.
        try:
            run([docker, "rm", "-f", name], env, timeout=20)
        except (BackupError, OSError, subprocess.SubprocessError):
            pass  # --rm already removed it in the normal path.


@contextmanager
def lock(state, name="maintenance.lock"):
    import fcntl
    require(name in ("maintenance.lock", "worker-admission.lock"), "lock-name")
    state = protected(state, directory=True)
    fd = os.open(state / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077 and info.st_nlink == 1, "lock-permissions")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("already-running") from None
        yield
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def assert_operation_idle(state):
    # Even corrupt/dangling markers fail closed; never infer success from a PID
    # disappearing or a released flock (the Docker container can outlive its CLI).
    require(not os.path.lexists(state / "operation-pending.json"), "operation-unsettled")


def begin_operation(state, kind, fingerprint, **details):
    assert_operation_idle(state)
    record = {"version": 1, "operation": kind, "id": uuid.uuid4().hex,
              "configuration_sha256": fingerprint, **details}
    path = state / "operation-pending.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(record, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(state)  # Durable BEFORE the first external side effect.
    return record


def complete_operation(state, record):
    path = protected(state / "operation-pending.json")
    require(read_json(path) == record, "operation-changed")
    path.unlink()
    sync_directory(state)


def atomic_json(path, data):
    # Unique private sibling + atomic replace: failed writes never refresh success.
    fd, temp = tempfile.mkstemp(prefix=".status-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def configuration_fingerprint(config):
    # A receipt for another release/DB volume/recipient/storage must not look fresh.
    files = {}
    for key in ("compose_file", "compose_env"):
        path = protected(config[key], private=key != "compose_file")
        require(path.stat().st_size <= 65536, "configuration")
        files[key] = digest(path)[1]
    return hashlib.sha256(json.dumps({"config": config, "files": files}, sort_keys=True).encode()).hexdigest()


def perform_backup(config, *, storage_factory=S3, encryptor=encrypt, min_free=MIN_FREE):
    """Dependency arguments are for isolated tests, never CLI/config overrides."""
    require(config["upload_enabled"], "upload-disabled")
    state = protected(config["state_dir"], directory=True)
    protected(config["compose_file"], private=False)
    protected(config["compose_env"])
    with lock(state):
        assert_operation_idle(state)
        started = time.time()
        stage = "preflight"
        try:
            fingerprint = configuration_fingerprint(config)
            require(shutil.disk_usage(state).free >= min_free, "disk-space")
            operation = begin_operation(state, "backup", fingerprint)
            with tempfile.TemporaryDirectory(prefix=".attempt-", dir=state) as temp:
                directory = Path(temp)
                storage = storage_factory(config, directory)
                archive, downloaded = directory / "database.dump.age", directory / "readback.age"
                stage = "dump-encrypt"
                encryptor(config, archive, clean_env(directory))
                size, sha, _ = digest(archive)
                # Unique object names; no overwritten latest pointer and no remote deletion.
                backup_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(started)) + "-" + uuid.uuid4().hex
                key = config["prefix"] + "/" + backup_id + ".dump.age"
                stage = "upload"
                storage.put(key, archive)
                stage = "readback"
                storage.get(key, downloaded)
                require(digest(downloaded)[:2] == (size, sha), "readback-mismatch")
                manifest = {
                    "version": 1, "backup_id": backup_id, "snapshot_started_at": started,
                    "source_sha": config["source_sha"], "postgres_major": 17,
                    "configuration_sha256": fingerprint,
                    "format": "pg_dump-custom+age-x25519", "key": key, "bytes": size, "sha256": sha,
                    "recipient_sha256": hashlib.sha256(config["recipient"].encode()).hexdigest(),
                }
                marker = directory / "complete.json"
                atomic_json(marker, manifest)
                stage = "manifest"
                marker_key = config["prefix"] + "/" + backup_id + ".complete.json"
                storage.put(marker_key, marker)
                downloaded.unlink()
                storage.get(marker_key, downloaded)
                require(digest(downloaded)[:2] == digest(marker)[:2], "manifest-mismatch")
                stage = "status"
                atomic_json(state / "last-success.json", {**manifest, "verified_at": time.time()})
                complete_operation(state, operation)
                return manifest
        except Exception:
            atomic_json(state / "last-failure.json", {"failed_at": time.time(), "stage": stage})
            raise BackupError("backup-failed-" + stage) from None


def check_freshness(config, *, now=None):
    require(config["upload_enabled"], "upload-disabled")
    state = protected(config["state_dir"], directory=True)
    now = time.time() if now is None else now
    try:
        success = read_json(protected(state / "last-success.json"))
        require(success.get("configuration_sha256") == configuration_fingerprint(config), "configuration-changed")
        start, verified = success["snapshot_started_at"], success["verified_at"]
        require(type(start) in (int, float) and type(verified) in (int, float) and 0 < start <= verified <= now, "invalid-status")
        require(now - start <= MAX_AGE, "stale-backup")
        failure = state / "last-failure.json"
        if failure.exists():
            failed = read_json(protected(failure))["failed_at"]
            require(type(failed) in (int, float) and 0 < failed <= now, "invalid-status")
            require(failed < start, "last-attempt-failed")
        assert_operation_idle(state)
    except (KeyError, ValueError, OSError):
        raise BackupError("missing-or-invalid-status") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["backup", "check"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--allow-upload", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_signum, _frame):
        raise BackupError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        config = load_config(args.config)
        if args.operation == "backup":
            require(args.allow_upload, "explicit-upload-required")
            perform_backup(config)
        else:
            check_freshness(config)
        print("CityGo backup: " + ("verified" if args.operation == "backup" else "fresh"))
        return 0
    except BackupError as error:
        print("CityGo backup: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        # Never print arbitrary exception text, paths, URLs, credentials or child output.
        print("CityGo backup: failed (details hidden)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
