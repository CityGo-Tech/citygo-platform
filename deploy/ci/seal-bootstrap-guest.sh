#!/bin/sh
# Trusted first-boot guest ONLY, after the owner has checked the tools replay.
# Transport through an already pinned SSH connection; never put keys in argv.
# This removes bootstrap authentication, not host ACLs, the seed ISO or a VM.
# The owner must gracefully power off, detach the ISO and verify a fresh clone.
exec python3 -I -B - "$@" <<'PY_SEAL_BOOTSTRAP'
import hashlib, json, os, platform, re, stat, subprocess, sys

USER = "citygo-bootstrap"
HOME = "/home/citygo-bootstrap"
AUTH = HOME + "/.ssh/authorized_keys"
SUDO = "/etc/sudoers.d/90-cloud-init-users"
REPORT = "/var/lib/citygo-bootstrap/toolchain-report.json"
RECEIPT = "/var/lib/citygo-bootstrap/seal-report.json"
CLOUD = "/var/lib/cloud"
HOST_KEYS = tuple("/etc/ssh/ssh_host_%s_key%s" % (kind, suffix) for kind in ("ed25519", "ecdsa", "rsa") for suffix in ("", ".pub"))
LOGS = ("/var/log/cloud-init.log", "/var/log/cloud-init-output.log")
ENV = {"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}

class Refused(Exception):
    def __init__(self, code):
        self.code = code

def require(condition, code):
    if not condition:
        raise Refused(code)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def options(arguments):
    require(len(arguments) in (5, 7), "arguments_invalid")
    require(arguments[0] in ("--plan", "--apply"), "arguments_invalid")
    require(arguments[1] == "--operation-id" and arguments[3] == "--expected-report-sha256", "arguments_invalid")
    operation, report_hash = arguments[2], arguments[4]
    require(bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", operation)), "operation_invalid")
    require(bool(re.fullmatch(r"[0-9a-f]{64}", report_hash)), "report_hash_invalid")
    apply = arguments[0] == "--apply"
    require(not apply and len(arguments) == 5 or apply and len(arguments) == 7 and arguments[5] == "--acknowledge" and arguments[6] == "SEAL_BOOTSTRAP_AUTH:" + operation + ":" + report_hash, "acknowledgement_required")
    return apply, operation, report_hash

def sudo_without_bootstrap(raw):
    # Keep all other rules and comments byte-for-byte, including line endings.
    require(len(raw) <= 65536 and b"\x00" not in raw, "sudo_shape_invalid")
    expected = b"citygo-bootstrap ALL=(ALL) NOPASSWD:ALL"
    lines = raw.splitlines(keepends=True)
    selected = [index for index, line in enumerate(lines) if line.rstrip(b"\r\n") == expected]
    require(len(selected) == 1, "sudo_rule_not_unique")
    for index, line in enumerate(lines):
        if index != selected[0] and not line.lstrip().startswith(b"#"):
            require(b"citygo-bootstrap" not in line, "unexpected_bootstrap_sudo_rule")
    return b"".join(line for index, line in enumerate(lines) if index != selected[0])

def valid_authorized_key(raw):
    # Only the dedicated template's single, source-bound public key is owned.
    try:
        text = raw.decode("ascii")
        match = re.fullmatch(r'from="([0-9]{1,3}(?:\.[0-9]{1,3}){3})",restrict ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [A-Za-z0-9._@ -]{1,200})?\n?', text)
        if not match or any(int(part) > 255 for part in match[1].split(".")):
            return False
        import base64
        key = base64.b64decode(match[2], validate=True)
        return len(key) == 51 and key[:19] == b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
    except (ValueError, UnicodeError):
        return False

def status_done(raw):
    try:
        item = json.loads(raw)
        require(isinstance(item, dict) and item.get("status") == "done", "cloud_init_not_done")
        require(item.get("errors") == [] and item.get("recoverable_errors", {}) == {}, "cloud_init_has_errors")
    except (ValueError, TypeError):
        raise Refused("cloud_init_status_invalid")

class Guest:
    def facts(self):
        import pwd
        account = pwd.getpwnam(USER)
        return os.geteuid(), platform.machine(), sys.version_info[:2], platform.freedesktop_os_release(), account.pw_uid, account.pw_dir

    def info(self, path):
        try:
            item = os.lstat(path)
        except FileNotFoundError:
            return None
        return (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid, item.st_size, item.st_nlink)

    def names(self, path):
        names = os.listdir(path)
        require(len(names) <= 4096, "directory_inventory_exceeded")
        return names

    def read(self, path, bound):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            current = os.fstat(fd)
            require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1, "ordinary_file_required")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(bound + 1)
            require(len(raw) <= bound, "file_size_exceeded")
            return raw
        finally:
            os.close(fd)

    def resolved(self, path):
        return os.path.realpath(path)

    def command(self, arguments, data=None, timeout=15):
        try:
            io = {"stdin": subprocess.DEVNULL} if data is None else {"input": data}
            result = subprocess.run(arguments, cwd="/", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, env=ENV, check=False, **io)
        except subprocess.TimeoutExpired:
            raise Refused("command_timeout")
        except OSError:
            raise Refused("command_unavailable")
        require(result.returncode == 0 and len(result.stdout) <= 65536, "command_failed")
        return result.stdout

    def unlink(self, path, before):
        require(self.info(path) == before, "target_changed")
        os.unlink(path)
        self.sync_parent(path)

    def write_new(self, path, raw, mode):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(raw)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        self.sync_parent(path)

    def sync_parent(self, path):
        fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def replace_sudo(self, raw, before, operation):
        # A dot-prefixed candidate is ignored by sudo's includedir. Validate it
        # before atomically replacing ONLY the known cloud-init users file.
        candidate = "/etc/sudoers.d/.citygo-bootstrap-seal-" + operation
        self.write_new(candidate, raw, 0o440)
        self.command(["/usr/sbin/visudo", "--check", "--file", candidate])
        require(self.info(SUDO) == before, "sudo_target_changed")
        os.replace(candidate, SUDO)
        self.sync_parent(SUDO)

def directory(guest, path, owners=(0,)):
    item = guest.info(path)
    require(item is not None and stat.S_ISDIR(item[2]) and item[3] in owners and item[2] & 0o022 == 0, "trusted_directory_required")

def ordinary(guest, path, owners=(0,), exact_mode=None):
    item = guest.info(path)
    require(item is not None and stat.S_ISREG(item[2]) and item[3] in owners and item[6] == 1 and item[2] & 0o022 == 0, "trusted_file_required")
    require(exact_mode is None or stat.S_IMODE(item[2]) == exact_mode, "file_mode_unexpected")
    return item

def selected_workspace_inventory(guest):
    # A bounded inventory of the known bootstrap/workspace roots, not a claim
    # that arbitrary guest files or host/guest isolation were verified.
    denied = {".git", ".runner", ".credentials", ".credentials_rsaparams", "actions-runner", "_work", "citygo-platform", "package.json"}
    roots = (HOME, "/root", "/opt", "/srv", "/workspace", "/work", "/_work", "/actions-runner", "/var/lib/github-actions")
    excluded = {HOME + "/.ssh", HOME + "/.cache", HOME + "/.npm", "/root/.ssh", "/root/.cache", "/root/.npm", "/opt/citygo-toolchain"}
    pending = [(path, 0) for path in roots if guest.info(path) is not None]
    count = 0
    while pending:
        path, depth = pending.pop()
        require(os.path.basename(path) not in denied, "checkout_or_runner_present")
        item = guest.info(path)
        require(item is not None and stat.S_ISDIR(item[2]), "workspace_inventory_unverified")
        for name in guest.names(path):
            count += 1
            require(count <= 4096, "workspace_inventory_exceeded")
            require(name not in denied, "checkout_or_runner_present")
            child = path + "/" + name
            child_item = guest.info(child)
            require(child_item is not None, "workspace_inventory_changed")
            if child not in excluded and stat.S_ISDIR(child_item[2]):
                require(depth < 4, "workspace_inventory_depth_exceeded")
                pending.append((child, depth + 1))

def preflight(guest, operation, report_hash):
    uid, machine, python, release, user_uid, user_home = guest.facts()
    require(uid == 0 and machine == "x86_64" and python == (3, 12) and release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "24.04", "trusted_ubuntu_root_required")
    require(user_uid >= 1000 and user_home == HOME, "bootstrap_user_unexpected")
    for path in ("/etc/ssh", "/etc/sudoers.d", CLOUD, "/var/lib/citygo-bootstrap"):
        directory(guest, path)
    directory(guest, HOME, (0, user_uid))
    directory(guest, HOME + "/.ssh", (0, user_uid))
    require(guest.info(RECEIPT) is None, "seal_receipt_already_exists")
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud", "nocloud_required")
    require(guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() == ("citygo-bootstrap-" + operation).encode("ascii"), "instance_identity_mismatch")
    status_done(guest.command(["/usr/bin/cloud-init", "status", "--format", "json"]))
    require(guest.command(["/usr/bin/systemctl", "show", "cloud-final.service", "--property=Result", "--value"]).strip() == b"success", "cloud_final_not_successful")
    require(guest.command(["/usr/bin/systemctl", "show", "cloud-final.service", "--property=ExecMainStatus", "--value"]).strip() == b"0", "cloud_final_not_successful")
    help_text = guest.command(["/usr/bin/cloud-init", "clean", "--help"])
    require(all(flag in help_text for flag in (b"--logs", b"--seed", b"--machine-id")), "cloud_init_clean_flags_unavailable")
    clean_dir = "/etc/cloud/clean.d"
    if guest.info(clean_dir) is not None:
        directory(guest, clean_dir)
        for name in guest.names(clean_dir):
            item = guest.info(clean_dir + "/" + name)
            require(item is not None and stat.S_ISREG(item[2]) and item[2] & 0o111 == 0, "custom_clean_hook_refused")
    mountinfo = guest.read("/proc/self/mountinfo", 262144)
    require(any(line.split(" - ")[0].split()[4:5] == ["/run"] and line.split(" - ")[1].split()[:1] == ["tmpfs"] for line in mountinfo.decode("ascii").splitlines() if " - " in line), "run_tmpfs_required")
    dbus = guest.info("/var/lib/dbus/machine-id")
    require(dbus is None or stat.S_ISLNK(dbus[2]) and guest.resolved("/var/lib/dbus/machine-id") == "/etc/machine-id", "separate_dbus_machine_id_refused")
    ordinary(guest, "/etc/machine-id")
    require(bool(re.fullmatch(rb"[0-9a-f]{32}\n?", guest.read("/etc/machine-id", 64))), "machine_id_unexpected")
    ordinary(guest, REPORT)
    report_raw = guest.read(REPORT, 32768)
    require(digest(report_raw) == report_hash, "installer_report_hash_mismatch")
    report = json.loads(report_raw)
    require(type(report) is dict and report.get("version") == 1 and report.get("toolchainInstalled") is True and report.get("node") == "24.22.0" and report.get("pnpm") == "10.15.0" and report.get("playwright") == "1.63.0", "installer_report_invalid")
    auth_stat = ordinary(guest, AUTH, (0, user_uid))
    require(valid_authorized_key(guest.read(AUTH, 4096)), "bootstrap_authorized_key_unexpected")
    require(set(guest.names(HOME + "/.ssh")) == {"authorized_keys"}, "additional_user_ssh_files_refused")
    for path in ("/root/.ssh/authorized_keys", "/root/.ssh/authorized_keys2", HOME + "/.ssh/authorized_keys2"):
        item = guest.info(path)
        require(item is None or stat.S_ISREG(item[2]) and item[5] == 0, "additional_ssh_auth_refused")
    for account in (USER, "root"):
        fields = guest.command(["/usr/bin/passwd", "--status", account]).split()
        require(len(fields) >= 2 and fields[0] == account.encode("ascii") and fields[1] == b"L", "password_account_not_locked")
    sudo_stat = ordinary(guest, SUDO, exact_mode=0o440)
    sudo_raw = guest.read(SUDO, 65536)
    sudo_next = sudo_without_bootstrap(sudo_raw)
    guest.command(["/usr/sbin/visudo", "--check", "--file", SUDO])
    require(not any(name.startswith("ssh_host_") and "/etc/ssh/" + name not in HOST_KEYS for name in guest.names("/etc/ssh")), "unexpected_host_key_path")
    keys = {}
    for path in HOST_KEYS:
        item = guest.info(path)
        if item is not None:
            keys[path] = ordinary(guest, path, exact_mode=0o644 if path.endswith(".pub") else 0o600)
    require(HOST_KEYS[0] in keys and HOST_KEYS[1] in keys, "expected_ed25519_host_pair_missing")
    for index in range(0, len(HOST_KEYS), 2):
        require((HOST_KEYS[index] in keys) == (HOST_KEYS[index + 1] in keys), "host_key_pair_incomplete")
    selected_workspace_inventory(guest)
    socket = guest.info("/var/run/docker.sock")
    require(socket is not None and stat.S_ISSOCK(socket[2]) and socket[3] == 0, "native_docker_socket_unverified")
    require(guest.command(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.OSType}}"]).strip() == b"linux", "native_docker_unverified")
    require(guest.command(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "container", "ls", "--all", "--quiet"]).strip() == b"", "docker_containers_present")
    return {"authStat": auth_stat, "sudoStat": sudo_stat, "sudoNext": sudo_next, "keys": keys}

def base_receipt(operation, report_hash):
    return {"version": 1, "scope": "trusted_bootstrap_auth_seal", "operationId": operation, "installerReportSha256": report_hash, "ok": False, "mutationsStarted": False, "bootstrapAuthorizedKeyAbsent": False, "bootstrapSudoRuleRemovedOtherEntriesPreserved": False, "fixedHostKeysAbsent": False, "persistentCloudArtifactsAbsent": False, "machineIdUninitialized": False, "cloudInitLogsAbsent": False, "installerReportPreserved": False, "volatileRuntimeDataMayRemainUntilPoweroff": True, "vmPoweredOff": False, "seedIsoDetached": False, "guestIsolationVerified": False, "githubJobsAuthorized": False, "goldenImageSealed": False, "freshCloneIdentityVerified": False}

def seal(guest, operation, report_hash, apply):
    receipt = base_receipt(operation, report_hash)
    try:
        inventory = preflight(guest, operation, report_hash)
        receipt["preflightPassed"] = True
        if not apply:
            receipt.update(ok=True, code="plan_only_no_changes")
            return receipt
        receipt["mutationsStarted"] = True
        guest.replace_sudo(inventory["sudoNext"], inventory["sudoStat"], operation)
        guest.unlink(AUTH, inventory["authStat"])
        for path, before in inventory["keys"].items():
            guest.unlink(path, before)
        guest.command(["/usr/bin/cloud-init", "clean", "--logs", "--seed", "--machine-id"], timeout=60)
        receipt["bootstrapAuthorizedKeyAbsent"] = guest.info(AUTH) is None
        receipt["bootstrapSudoRuleRemovedOtherEntriesPreserved"] = guest.read(SUDO, 65536) == inventory["sudoNext"]
        receipt["fixedHostKeysAbsent"] = all(guest.info(path) is None for path in HOST_KEYS) and not any(name.startswith("ssh_host_") for name in guest.names("/etc/ssh"))
        receipt["persistentCloudArtifactsAbsent"] = guest.info(CLOUD) is not None and guest.names(CLOUD) == []
        receipt["machineIdUninitialized"] = guest.read("/etc/machine-id", 64) == b"uninitialized\n"
        receipt["cloudInitLogsAbsent"] = all(guest.info(path) is None for path in LOGS)
        receipt["installerReportPreserved"] = digest(guest.read(REPORT, 32768)) == report_hash
        require(all(receipt[field] for field in ("bootstrapAuthorizedKeyAbsent", "bootstrapSudoRuleRemovedOtherEntriesPreserved", "fixedHostKeysAbsent", "persistentCloudArtifactsAbsent", "machineIdUninitialized", "cloudInitLogsAbsent", "installerReportPreserved")), "seal_readback_failed")
        receipt.update(ok=True, code="guest_auth_sealed_poweroff_required")
        guest.write_new(RECEIPT, (json.dumps(receipt, sort_keys=True) + "\n").encode("ascii"), 0o600)
    except Refused as error:
        receipt.update(ok=False, code=error.code)
    except Exception:
        receipt.update(ok=False, code="seal_unavailable")
    return receipt

def main(arguments):
    try:
        apply, operation, report_hash = options(arguments)
        result = seal(Guest(), operation, report_hash, apply)
    except Refused as error:
        result = {"version": 1, "scope": "trusted_bootstrap_auth_seal", "ok": False, "code": error.code, "mutationsStarted": False, "goldenImageSealed": False, "githubJobsAuthorized": False}
    except Exception:
        result = {"version": 1, "scope": "trusted_bootstrap_auth_seal", "ok": False, "code": "seal_unavailable", "mutationsStarted": False, "goldenImageSealed": False, "githubJobsAuthorized": False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
PY_SEAL_BOOTSTRAP
