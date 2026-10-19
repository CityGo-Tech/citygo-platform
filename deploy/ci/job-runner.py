#!/usr/bin/python3
"""One full CI/Container job in a NEW externally disposable Ubuntu guest.

The seed carries only pinned PUBLIC code/archives and a credential-free plan.
One-agent JIT arrives later over bounded host KVP, never argv/environment/ISO.
Host admission, watchdogs and independent GitHub job readback remain mandatory.
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

SCRIPT = "/usr/local/sbin/citygo-job-runner.py"
CANARY = "/usr/local/lib/citygo-ci/ephemeral-runner-canary.py"
CANARY_SHA = "951198c8648128fc2a48ae4e7dd0bd374eda05449f1d9d346fcc441982cfbaeb"
LEASE = "/usr/local/lib/citygo-ci/job-lease.py"
LEASE_SHA = "5e410154ff5eec081b07f22c5288e5299a4ea5756ec02711409f741455cbbdd0"
JIT = "/usr/local/lib/citygo-ci/job-jit.py"
JIT_SHA = "55bdd58ea5b1216c190f9e85c7b1015f4dd8cc5dfa6d79999a50de6c652cbda4"
TOOLS = "/usr/local/lib/citygo-ci/prepare-job-toolchain.py"
TOOLS_SHA = "ec30af76c82b1350a909053d6a43dec21fec18ce3293792c967aa4873b182b57"
APT = "/usr/local/lib/citygo-ci/job-apt-https.py"
APT_SHA = "357d8d9b3384a442f5164ca423f3cc1adb168d4139dadca2d5dddd86d52b6579"
PLAN = "/var/lib/citygo-ci-runner/job-plan.json"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"


def require(value, code):
    if not value:
        raise ValueError("ci_job_runner_" + code)


def read_root(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "root_file")
        raw = os.read(fd, maximum + 1)
        require(len(raw) <= maximum, "file_size")
        return raw
    finally:
        os.close(fd)


def load(path, sha, name):
    raw = read_root(path, 131072)
    require(hashlib.sha256(raw).hexdigest() == sha, "source_pin")
    module = types.ModuleType(name)
    exec(compile(raw, path, "exec"), module.__dict__)
    return module


def command(operation, sha):
    return ["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", operation,
            "--expected-job-plan-sha256", sha, "--acknowledge", "RUN_ONE_CI_JOB:" + operation + ":" + sha]


def validate_seed(guest, canary, plan, sha):
    operation = plan["operationId"]
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
            guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() ==
            ("citygo-runner-canary-" + operation).encode("ascii"), "instance")
    seed = guest.seed()
    require(type(seed) is dict and set(seed) == {"write_files", "runcmd"}, "seed")
    paths = [(SCRIPT, "0700"), (CANARY, "0600"), (canary.NETWORK, "0600"), (canary.HELPER, "0600"),
             (canary.CONFIG, "0600"), (TOOLS, "0600"), (LEASE, "0600"), (JIT, "0600"), (APT, "0600"), (PLAN, "0600")]
    require(type(seed["write_files"]) is list and len(seed["write_files"]) == len(paths), "seed_files")
    for item, (path, mode) in zip(seed["write_files"], paths):
        require(type(item) is dict and set(item) == {"path", "owner", "permissions", "encoding", "content"} and
                item["path"] == path and item["owner"] == "root:root" and item["permissions"] == mode and item["encoding"] == "b64", "seed_file")
        try:
            raw = base64.b64decode(item["content"], validate=True)
        except (ValueError, TypeError):
            raise ValueError("ci_job_runner_seed_encoding") from None
        require(raw == read_root(path, 131072), "seed_changed")
    require(seed["runcmd"] == [command(operation, sha)], "seed_command")


def install_public(canary, tools, guest, helper, operation):
    require(not os.path.lexists(canary.ROOT) and not os.path.lexists("/home/ci-runner") and
            not os.path.lexists(canary.BUNDLE) and stat.S_ISBLK(os.lstat("/dev/sr0").st_mode), "fresh_guest")
    os.mkdir(canary.ROOT, 0o700)
    os.mkdir(canary.BUNDLE, 0o700)
    canary.native(["/usr/bin/mount", "--types", "iso9660", "--options", "ro,nodev,nosuid,noexec", "/dev/sr0", canary.BUNDLE], 15)
    try:
        require(set(os.listdir(canary.BUNDLE)) == {"user-data", "meta-data", "network-config", canary.ARCHIVE_NAME, tools.ARCHIVE}, "public_files")
        canary.bundle_identity(guest.read(canary.BUNDLE + "/meta-data", 4096), operation, helper.unique_json)
        fd = os.open(canary.BUNDLE + "/" + canary.ARCHIVE_NAME, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode) and os.fstat(stream.fileno()).st_size == canary.ARCHIVE_SIZE and
                    hashlib.file_digest(stream, "sha256").hexdigest() == canary.ARCHIVE_SHA, "runner_archive")
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode="r:gz") as archive:
                members = archive.getmembers()
                require(len(members) <= 30000 and sum(x.size for x in members) <= 2 * 1024**3, "runner_archive_bounds")
                archive.extractall(canary.ROOT, members=members, filter="data")
        directory = "/run/citygo-ci-job-tools"
        require(not os.path.lexists(directory), "tools_attempt")
        os.mkdir(directory, 0o700)
        fd = os.open(canary.BUNDLE + "/" + tools.ARCHIVE, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            tools.check_archive(stream)
            target_fd = os.open(tools.PUBLIC, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(target_fd, "wb") as target:
                total = 0
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= tools.SIZE, "tools_copy_bounds")
                    target.write(chunk)
                require(total == tools.SIZE, "tools_copy_size")
                target.flush()
                os.fsync(target.fileno())
    finally:
        canary.native(["/usr/bin/umount", "--", canary.BUNDLE], 15)
    os.rmdir(canary.BUNDLE)
    canary.native(["/usr/sbin/useradd", "--create-home", "--shell", "/usr/sbin/nologin", "--groups", "docker", "ci-runner"], 10)
    import grp
    import pwd
    account = pwd.getpwnam("ci-runner")
    require(account.pw_uid >= 1000 and account.pw_dir == "/home/ci-runner", "account")
    public = os.lstat("/opt/citygo-toolchain")
    require(stat.S_ISDIR(public.st_mode) and public.st_uid == 0, "public_toolchain")
    canary.native(["/usr/bin/chmod", "--recursive", "a+rX,go-w", "--", "/opt/citygo-toolchain"], 20)
    canary.native(["/usr/bin/chown", "--recursive", "--no-dereference", "ci-runner:ci-runner", canary.ROOT], 20)
    tools.install(tools.PUBLIC, operation)
    os.unlink(tools.PUBLIC)
    os.rmdir(directory)
    return account.pw_uid, account.pw_gid, [grp.getgrnam("docker").gr_gid]


def read_pool(canary):
    import fcntl
    fd = os.open(canary.POOL, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "pool_owner")
        until = time.monotonic() + 3
        while True:
            try:
                fcntl.lockf(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < until, "pool_lock")
                time.sleep(0.05)
        path = os.lstat(canary.POOL)
        require(path.st_ino == item.st_ino and path.st_dev == item.st_dev, "pool_path")
        return os.pread(fd, 2560 * 400 + 1, 0)
    finally:
        os.close(fd)


def read_go(raw, plan, sha, jit, now):
    # Shares only framing validation; this is a distinct, non-secret host permit.
    jit.pool_records(raw, plan["operationId"])
    key = ("CityGoJobGo-" + plan["operationId"]).encode("ascii")
    matches = []
    for offset in range(0, len(raw), 2560):
        if raw[offset:offset + 512].split(b"\0", 1)[0] == key:
            value = raw[offset + 512:offset + 2560]
            require(b"\0" in value, "go_value")
            matches.append(value.split(b"\0", 1)[0])
    require(len(matches) <= 1, "go_duplicate")
    if not matches:
        return False
    value = jit.unique_json(matches[0])
    require(type(value) is dict and set(value) == {"operationId", "jobPlanSha256", "action", "expiresAt"} and
            value["operationId"] == plan["operationId"] and value["jobPlanSha256"] == sha and value["action"] == "listen", "go_binding")
    require(type(value["expiresAt"]) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value["expiresAt"]), "go_time")
    expires = datetime.datetime.strptime(value["expiresAt"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)
    require(0 < (expires - now).total_seconds() <= 60, "go_expired")
    return True


def main(args):
    if args == ["--plan"]:
        print('{"stage":"plan_only_unverified","runnerRegistered":false}')
        return 0
    if not (len(args) == 7 and args[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, args[2]) and
            args[3] == "--expected-job-plan-sha256" and re.fullmatch(r"[a-f0-9]{64}", args[4]) and
            args[5:] == ["--acknowledge", "RUN_ONE_CI_JOB:" + args[2] + ":" + args[4]]):
        print('{"stage":"refused","runnerRegistered":false}')
        return 2
    guest = None
    phase = "identity"
    try:
        require(sys.platform == "linux" and os.geteuid() == 0 and sys.version_info[:2] == (3, 12), "trusted_linux")
        canary = load(CANARY, CANARY_SHA, "job_runner_canary")
        lease_lib = load(LEASE, LEASE_SHA, "job_runner_lease")
        jit = load(JIT, JIT_SHA, "job_runner_jit")
        tools = load(TOOLS, TOOLS_SHA, "job_runner_tools")
        apt = load(APT, APT_SHA, "job_runner_apt")
        plan = lease_lib.parse_plan(read_root(PLAN, 16384), args[4], args[2], "client")
        lease = lease_lib.Lease(plan, args[2], "client")
        bootstrap_end = lease_lib.timestamp(plan["createdAt"]) + datetime.timedelta(seconds=600)

        def live_bootstrap():
            lease.require_live()
            require(datetime.datetime.now(datetime.timezone.utc) < bootstrap_end, "bootstrap_expired")

        helper = canary.load(canary.HELPER, canary.HELPER_SHA, "job_runner_helper")
        network = canary.load(canary.NETWORK, canary.NETWORK_SHA, "job_runner_network")
        guest = network.connected_client_type(helper)()
        value = canary.config(helper.unique_json(read_root(canary.CONFIG, 32768).decode("ascii")), network)
        require(value["operationId"] == plan["operationId"] and value["gatewayOperationId"] == plan["gatewayOperationId"], "config_binding")
        live_bootstrap()
        validate_seed(guest, canary, plan, args[4])
        phase = "network_probes"
        proof = network.probe_client(guest, value, True)
        phase = "install_public_archives"
        live_bootstrap()
        uid, gid, groups = install_public(canary, tools, guest, helper, args[2])
        live_bootstrap()
        for command, pattern in ((["/usr/local/bin/node", "--version"], r"v24\.[0-9]+\.[0-9]+"),
                                 (["/usr/local/bin/pnpm", "--version"], r"10\.15\.0"),
                                 (["/usr/bin/python3", "--version"], r"Python 3\.12\.[0-9]+"),
                                 (["/usr/local/bin/pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], r"7\.6\.7"),
                                 (["/usr/bin/docker", "info", "--format", "{{.OSType}}"], r"linux"),
                                 (["/usr/bin/docker", "compose", "version", "--short"], r"v?[0-9]+\.[0-9]+\.[0-9]+"),
                                 (["/usr/bin/docker", "buildx", "version"], r"github\.com/docker/buildx v[0-9]+\.[0-9]+\.[0-9]+.*"),
                                 (["/usr/bin/git", "--version"], r"git version [0-9]+\.[0-9]+\.[0-9]+"),
                                 (["/usr/bin/age", "--version"], r"v?[0-9]+\.[0-9]+\.[0-9]+")):
            live_bootstrap()
            done = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=20, env=canary.ENV, cwd=canary.ROOT, user=uid, group=gid, extra_groups=groups, check=False)
            require(done.returncode == 0 and len(done.stdout) < 4096 and re.fullmatch(pattern, done.stdout.decode("ascii").strip()), "toolchain")
        phase = "prepare_guest_apt_https"
        live_bootstrap()
        require(apt.prepare(args[2]) is True, "apt_https_unverified")
        live_bootstrap()
        report = dict(version=1, scope="ephemeral_ci_job_runner", operationId=args[2], gatewayOperationId=plan["gatewayOperationId"],
                      jobPlanSha256=args[4], hostSnapshotSha256=value["hostSnapshotSha256"], stage="waiting_host_jit", ciJobsAdmitted=False,
                      **{key: proof[key] for key in ("negativeProbeCount", "gatewayProbeCount", "dnsOk", "httpsOk", "sourceSpoofSent", "ipv6DefaultRouteAbsent", "linkProbeFramesSent", "observedGatewayMac")})
        guest.publish(args[2], helper.report_bytes(report))
        phase = "wait_scoped_jit"
        until = time.monotonic() + 120
        configured = None
        while time.monotonic() < until:
            live_bootstrap()
            configured = jit.assemble(read_pool(canary), plan, args[4], datetime.datetime.now(datetime.timezone.utc))
            if configured is not None:
                break
            time.sleep(1)
        require(configured is not None, "jit_missing")
        configs, agent_id = configured
        for name, raw in configs.items():
            fd = os.open(canary.ROOT + "/" + name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as target:
                os.fchown(target.fileno(), uid, gid)
                target.write(raw)
                target.flush()
                os.fsync(target.fileno())
            require(guest.read(canary.ROOT + "/" + name, 65536) == raw, "jit_config_readback")
        configs = configured = raw = None
        report.update(stage="configured_ephemeral", agentId=agent_id, ephemeralReadback=True, disableUpdateReadback=True)
        guest.publish(args[2], helper.report_bytes(report))
        phase = "wait_host_cleanup_and_go"
        until = time.monotonic() + 60
        permitted = False
        while time.monotonic() < until:
            live_bootstrap()
            raw_pool = read_pool(canary)
            if not jit.pool_records(raw_pool, args[2]) and read_go(raw_pool, plan, args[4], jit, datetime.datetime.now(datetime.timezone.utc)):
                permitted = True
                break
            raw_pool = None
            time.sleep(1)
        require(permitted, "host_go_missing")
        raw_pool = None
        phase = "listen_one_job"
        timeout = min(plan["jobSeconds"] + 30, int(lease.remaining()) - 30)
        require(timeout > 0, "listener_deadline")
        canary.native([canary.ROOT + "/run.sh"], timeout, uid, gid, groups, canary.ROOT)
        report.update(stage="runner_process_exited")
        guest.publish(args[2], helper.report_bytes(report))
        print('{"stage":"runner_process_exited","githubReadbackRequired":true}')
        return 0
    except Exception:
        if guest is not None:
            try:
                guest.publish(args[2], json.dumps(dict(version=1, scope="ephemeral_ci_job_runner", operationId=args[2],
                              stage="failed_preserved", phase=phase, ciJobsAdmitted=False), separators=(",", ":")).encode("ascii"))
            except Exception:
                pass
        print('{"stage":"failed_preserved","ciJobsAdmitted":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
