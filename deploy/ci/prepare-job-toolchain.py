#!/usr/bin/python3
"""Trusted provisioning of a NEW disposable CI guest, before registration.

No internet/downloader, no host access, no base mutation. Input is one already
host-verified PUBLIC PowerShell archive. The future native adapter must provide
it before boot/listener and independently accept this guest's result.
Microsoft's official binary archive installation method:
https://learn.microsoft.com/powershell/scripting/install/alternate-install-methods
https://github.com/PowerShell/PowerShell/releases/tag/v7.6.7
"""
import hashlib
import os
import re
import stat
import subprocess
import sys
import tarfile

VERSION = "7.6.7"
SIZE = 75913191
SHA256 = "6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431"
ARCHIVE = "powershell-7.6.7-linux-x64.tar.gz"
DESTINATION = "/opt/citygo-job-pwsh"
SUDOERS = "/etc/sudoers.d/citygo-ci-runner"
PUBLIC = "/run/citygo-ci-job-tools/" + ARCHIVE
ENV = {"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/root"}


def require(value, code):
    if not value:
        raise ValueError("ci_job_tools_" + code)


def check_archive(stream):
    item = os.fstat(stream.fileno())
    require(stat.S_ISREG(item.st_mode) and item.st_size == SIZE, "archive_size")
    require(hashlib.file_digest(stream, "sha256").hexdigest() == SHA256, "archive_hash")
    stream.seek(0)


def command(args, timeout=30):
    result = subprocess.run(args, env=ENV, cwd="/", stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=timeout, check=False)
    require(result.returncode == 0 and len(result.stdout) < 16384, "command_failed")
    return result.stdout


def install(path, operation):
    require(sys.platform == "linux" and os.geteuid() == 0, "linux_root_required")
    require(command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
            command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() ==
            ("citygo-runner-canary-" + operation).encode("ascii"), "instance_mismatch")
    for parent in ("/run", "/run/citygo-ci-job-tools"):
        item = os.lstat(parent)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022, "public_parent")
    require(path == PUBLIC and not os.path.lexists(DESTINATION) and
            not os.path.lexists("/usr/local/bin/pwsh") and not os.path.lexists(SUDOERS), "previous_attempt")
    import pwd
    account = pwd.getpwnam("ci-runner")
    require(account.pw_uid >= 1000 and account.pw_dir == "/home/ci-runner", "runner_account")
    # This lease is intentionally not inherited from the canary image. The
    # native controller must create its own fresh off/disconnected disk copy.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb", closefd=False) as stream:
            require(os.fstat(fd).st_uid == 0 and not os.fstat(fd).st_mode & 0o022, "archive_owner")
            check_archive(stream)
            with tarfile.open(fileobj=stream, mode="r:gz") as source:
                members = source.getmembers()
                require(len(members) <= 30000 and sum(x.size for x in members) <= 1024**3, "archive_bounds")
                os.mkdir(DESTINATION, 0o755)
                source.extractall(DESTINATION, members=members, filter="data")
    finally:
        os.close(fd)
    executable = DESTINATION + "/pwsh"
    item = os.lstat(executable)
    require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1, "executable")
    os.chmod(executable, 0o755)
    os.symlink(executable, "/usr/local/bin/pwsh")
    require(command([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                     "$PSVersionTable.PSVersion.ToString()"], 20).strip() == VERSION.encode("ascii"), "pwsh_version")
    # Already a Docker member (guest-root equivalent). Passwordless sudo is
    # scoped to this disposable guest, required by unchanged apt/Playwright
    # steps; it must never be installed on Windows, the gateway or production.
    fd = os.open(SUDOERS, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o440)
    with os.fdopen(fd, "wb") as target:
        target.write(b"ci-runner ALL=(ALL:ALL) NOPASSWD: ALL\n")
        target.flush()
        os.fsync(target.fileno())
    command(["/usr/sbin/visudo", "-c", "-f", SUDOERS])
    command(["/usr/sbin/runuser", "-u", "ci-runner", "--", "/usr/bin/sudo", "-n", "/usr/bin/true"])
    command(["/usr/sbin/runuser", "-u", "ci-runner", "--", executable,
             "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"])


def main(args):
    if args == ["--plan"]:
        print('{"stage":"plan_only_unverified","guestChanged":false}')
        return 0
    # No default apply, arbitrary executable, URL, shell eval or downloaded code.
    if not (len(args) == 7 and args[:2] == ["--apply", "--operation-id"] and
            re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", args[2]) and
            args[3:5] == ["--verified-public-archive", PUBLIC] and
            args[5:] == ["--acknowledge", "PREPARE_DISPOSABLE_CI:" + args[2]]):
        print('{"stage":"refused","guestChanged":false}')
        return 2
    try:
        install(args[4], args[2])
        print('{"stage":"pwsh_and_sudo_verified","nativeFactoryAcceptanceRequired":true}')
        return 0
    except Exception:
        print('{"stage":"failed_preserved","nativeFactoryAcceptanceRequired":true}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
