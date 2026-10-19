#!/usr/bin/python3
"""Real toolchain rehearsal on one NEW disconnected disposable job clone.

No repository checkout, runner registration, listener, network calls, GitHub
credentials or host keys. Two pinned PUBLIC archives arrive on read-only ISO.
The external watchdog owns stop/removal; this guest only reports observations.
"""
import base64
import hashlib
import os
import re
import stat
import subprocess
import sys
import types

SCRIPT = "/usr/local/sbin/citygo-offline-job-tools.py"
RUNNER = "/usr/local/sbin/citygo-job-runner.py"
RUNNER_SHA = "149df29764e0a96776d491b055f2722459bc70234a507e17017ab066db72cc8c"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"


def require(value, code):
    if not value:
        raise ValueError("ci_offline_job_tools_" + code)


def load_runner():
    fd = os.open(RUNNER, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "source_owner")
        raw = os.read(fd, 131073)
        require(len(raw) <= 131072 and hashlib.sha256(raw).hexdigest() == RUNNER_SHA, "source_pin")
    finally:
        os.close(fd)
    module = types.ModuleType("offline_job_runner")
    exec(compile(raw, RUNNER, "exec"), module.__dict__)
    return module


def main(args):
    if args == ["--plan"]:
        print('{"stage":"plan_only_unverified","runnerRegistered":false}')
        return 0
    if not (len(args) == 5 and args[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, args[2]) and
            args[3:] == ["--acknowledge", "PREPARE_OFFLINE_JOB_TOOLS:" + args[2]]):
        print('{"stage":"refused","runnerRegistered":false}')
        return 2
    guest = None
    phase = "identity"
    try:
        require(sys.platform == "linux" and os.geteuid() == 0 and sys.version_info[:2] == (3, 12), "linux_root")
        runner = load_runner()
        canary = runner.load(runner.CANARY, runner.CANARY_SHA, "offline_job_canary")
        tools = runner.load(runner.TOOLS, runner.TOOLS_SHA, "offline_job_tools")
        helper = canary.load(canary.HELPER, canary.HELPER_SHA, "offline_job_helper")
        guest = helper.Guest()
        uid, architecture, release = guest.facts()
        require(uid == 0 and architecture == "x86_64" and release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "24.04", "guest")
        require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
                guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() ==
                ("citygo-runner-canary-" + args[2]).encode("ascii"), "instance")
        seed = guest.seed()
        require(type(seed) is dict and set(seed) == {"write_files", "runcmd"}, "seed")
        paths = [(SCRIPT, "0700"), (RUNNER, "0700"), (runner.CANARY, "0600"), (runner.TOOLS, "0600"), (canary.HELPER, "0600")]
        require(type(seed["write_files"]) is list and len(seed["write_files"]) == len(paths), "seed_files")
        for record, (path, mode) in zip(seed["write_files"], paths):
            require(type(record) is dict and set(record) == {"path", "owner", "permissions", "encoding", "content"} and
                    record["path"] == path and record["owner"] == "root:root" and record["permissions"] == mode and
                    record["encoding"] == "b64", "seed_file")
            require(base64.b64decode(record["content"], validate=True) == runner.read_root(path, 131072), "seed_bytes")
        require(seed["runcmd"] == [["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", args[2],
                                    "--acknowledge", "PREPARE_OFFLINE_JOB_TOOLS:" + args[2]]], "seed_command")
        helper.validate_mounts(guest.read("/proc/self/mountinfo", 262144))
        guest.workspace_absent()
        for family in ("-4", "-6"):
            require(helper.unique_json(guest.command(["/usr/sbin/ip", "-j", family, "route", "show", "default"])) == [], "external_default_route")
        phase = "install_public_archives"
        uid, gid, groups = runner.install_public(canary, tools, guest, helper, args[2])
        phase = "observe_tools_as_nonroot"
        observed = {}
        probes = [
            ("node", ["/usr/local/bin/node", "--version"], r"v24\.[0-9]+\.[0-9]+"),
            ("pnpm", ["/usr/local/bin/pnpm", "--version"], r"10\.15\.0"),
            ("python", ["/usr/bin/python3", "--version"], r"Python 3\.12\.[0-9]+"),
            ("pwsh", ["/usr/local/bin/pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], r"7\.6\.7"),
            ("runner", [canary.ROOT + "/bin/Runner.Listener", "--version"], r"2\.338\.0"),
            ("docker", ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.OSType}}"], r"linux"),
            ("compose", ["/usr/bin/docker", "compose", "version", "--short"], r"v?[0-9]+\.[0-9]+\.[0-9]+"),
            ("git", ["/usr/bin/git", "--version"], r"git version [0-9]+\.[0-9]+\.[0-9]+"),
            ("age", ["/usr/bin/age", "--version"], r"v?[0-9]+\.[0-9]+\.[0-9]+"),
            ("sudo", ["/usr/bin/sudo", "-n", "/usr/bin/id", "-u"], r"0"),
        ]
        for name, command, pattern in probes:
            done = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=20, env=canary.ENV, cwd=canary.ROOT, user=uid, group=gid, extra_groups=groups, check=False)
            require(done.returncode == 0 and len(done.stdout) < 4096, "probe_failed")
            text = done.stdout.decode("ascii").strip()
            require(re.fullmatch(pattern, text), "probe_version")
            observed[name] = text
        report = dict(version=1, scope="offline_ci_job_toolchain", operationId=args[2], stage="job_tools_observed",
                      ciJobsAdmitted=False, runnerRegistered=False, nativeFactoryAccepted=False, **observed)
        guest.publish(args[2], helper.report_bytes(report))
        print('{"stage":"job_tools_observed","hostReadbackRequired":true}')
        return 0
    except Exception:
        if guest is not None:
            try:
                import json
                guest.publish(args[2], json.dumps(dict(version=1, scope="offline_ci_job_toolchain", operationId=args[2],
                              stage="failed_preserved", phase=phase, ciJobsAdmitted=False), separators=(",", ":")).encode("ascii"))
            except Exception:
                pass
        print('{"stage":"failed_preserved","runnerRegistered":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
