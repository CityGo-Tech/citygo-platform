#!/usr/bin/python3
"""One trusted, disconnected clone only; not a runner or an isolation proof.

Default --plan does not write, compile, import images, or start containers.
KVP pool 1 is the documented guest-to-host channel over VMbus, not a network:
https://learn.microsoft.com/windows-server/virtualization/hyper-v/integration-services-data-exchange
Only this operation's key is changed; the daemon's POSIX record lock is used.
"""

import base64
import hashlib
import io
import json
import os
import platform
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


SCRIPT = "/usr/local/sbin/citygo-offline-clone-canary.py"
POOL = "/var/lib/hyperv/.kvp_pool_1"
KEY_BYTES = 512
VALUE_BYTES = 2048
REPORT_ASCII_BOUND = 1022
RECORD_BYTES = KEY_BYTES + VALUE_BYTES
POOL_BOUND = RECORD_BYTES * 400
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
ENV = {"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
MARKER = b"CITYGO_OFFLINE_CANARY_OK\n"
C_SOURCE = b'''#include <unistd.h>
int main(void) {
  const char text[] = "CITYGO_OFFLINE_CANARY_OK\\n";
  if (getuid() != 65534 || geteuid() != 65534) return 7;
  return write(1, text, sizeof(text)-1) == sizeof(text)-1 ? 0 : 8;
}
'''


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(value, code):
    if not value:
        raise Refused(code)


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "json_duplicate_key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, TypeError):
        raise Refused("json_invalid") from None


def options(arguments):
    require(len(arguments) in (3, 5), "arguments_invalid")
    require(arguments[0] in ("--plan", "--apply") and arguments[1] == "--operation-id", "arguments_invalid")
    operation = arguments[2]
    require(re.fullmatch(UUID, operation) is not None, "operation_invalid")
    apply = arguments[0] == "--apply"
    require((not apply and len(arguments) == 3) or
            (apply and len(arguments) == 5 and arguments[3] == "--acknowledge" and
             arguments[4] == "RUN_OFFLINE_CANARY:" + operation), "acknowledgement_required")
    return apply, operation


def report_bytes(report):
    raw = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    # Linux hv_kvp.c caps UTF-8 -> host UTF-16 at (2048 / 2) - 2.
    # https://github.com/torvalds/linux/blob/v6.8/drivers/hv/hv_kvp.c
    require(b"\x00" not in raw and len(raw) <= REPORT_ASCII_BOUND, "report_too_large")
    return raw


def update_pool(raw, key, value):
    """Pure fixed-record transform; every unrelated byte is preserved."""
    require(isinstance(raw, bytes) and len(raw) <= POOL_BOUND and len(raw) % RECORD_BYTES == 0, "kvp_pool_shape")
    require(re.fullmatch(rb"CityGoOfflineCanary-" + UUID.encode("ascii"), key) is not None, "kvp_key_invalid")
    require(len(key) < KEY_BYTES and isinstance(value, bytes) and len(value) < VALUE_BYTES and
            b"\x00" not in value and value.isascii(), "kvp_value_invalid")
    selected = []
    for offset in range(0, len(raw), RECORD_BYTES):
        existing = raw[offset:offset + KEY_BYTES]
        require(b"\x00" in existing, "kvp_key_unterminated")
        if existing.split(b"\x00", 1)[0] == key:
            selected.append(offset)
    require(len(selected) <= 1, "kvp_duplicate_owned_key")
    offset = selected[0] if selected else len(raw)
    require(offset < POOL_BOUND, "kvp_pool_full")
    record = key.ljust(KEY_BYTES, b"\x00") + value.ljust(VALUE_BYTES, b"\x00")
    return raw[:offset] + record + raw[offset + RECORD_BYTES:], offset, record


def validate_network(addresses, routes4, routes6):
    require(isinstance(addresses, list) and 1 <= len(addresses) <= 16 and
            isinstance(routes4, list) and isinstance(routes6, list) and len(routes4) + len(routes6) <= 128,
            "network_inventory_invalid")
    names = []
    for interface in addresses:
        require(isinstance(interface, dict) and isinstance(interface.get("ifname"), str) and
                isinstance(interface.get("addr_info"), list), "network_inventory_invalid")
        name = interface["ifname"]
        require(name not in names, "network_inventory_invalid")
        names.append(name)
        require(name in ("lo", "docker0") or not interface["addr_info"], "nonlocal_interface_address")
    require("lo" in names, "loopback_missing")
    for route in routes4 + routes6:
        require(isinstance(route, dict) and isinstance(route.get("dst"), str), "network_inventory_invalid")
        require(route["dst"] not in ("default", "0.0.0.0/0", "::/0") and "gateway" not in route,
                "default_or_gateway_route_present")


def validate_mounts(raw):
    denied = {"9p", "virtiofs", "vboxsf", "vmhgfs", "cifs", "smb3", "nfs", "nfs4", "drvfs", "prl_fs"}
    require(len(raw) <= 262144, "mount_inventory_too_large")
    run_tmpfs = False
    for line in raw.decode("ascii").splitlines():
        parts = line.split(" - ")
        require(len(parts) == 2 and len(parts[0].split()) >= 6 and len(parts[1].split()) >= 3, "mount_inventory_invalid")
        mountpoint = parts[0].split()[4]
        kind = parts[1].split()[0]
        # fusectl is the kernel's control filesystem, not a shared file mount.
        require(kind not in denied and not (kind.startswith("fuse") and kind != "fusectl"), "shared_host_filesystem_present")
        run_tmpfs |= mountpoint == "/run" and kind == "tmpfs"
    require(run_tmpfs, "run_tmpfs_required")


def public_fingerprint(raw):
    match = re.fullmatch(rb"ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [ -~]{1,200})?\n?", raw)
    require(match is not None, "ed25519_public_key_invalid")
    try:
        key = base64.b64decode(match[1], validate=True)
    except ValueError:
        raise Refused("ed25519_public_key_invalid") from None
    require(len(key) == 51 and key[:19] == b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20", "ed25519_public_key_invalid")
    return "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode("ascii").rstrip("=")


def validate_seed(seed, operation, source):
    require(isinstance(seed, dict) and set(seed) in ({"write_files", "runcmd"}, {"write_files", "runcmd", "preserve_hostname"}), "seed_fields_unexpected")
    require("preserve_hostname" not in seed or seed["preserve_hostname"] is True, "seed_fields_unexpected")
    files = seed["write_files"]
    require(isinstance(files, list) and len(files) == 1 and isinstance(files[0], dict), "seed_files_unexpected")
    item = files[0]
    require(set(item) == {"path", "owner", "permissions", "encoding", "content"} and item["path"] == SCRIPT and
            item["owner"] == "root:root" and item["permissions"] == "0700" and item["encoding"] == "b64" and
            isinstance(item["content"], str) and len(item["content"]) <= 180000, "seed_files_unexpected")
    try:
        embedded = base64.b64decode(item["content"], validate=True)
    except ValueError:
        raise Refused("seed_script_invalid") from None
    require(embedded == source and len(source) <= 131072 and
            b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----" not in source,
            "seed_script_invalid")
    expected = [["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", operation,
                 "--acknowledge", "RUN_OFFLINE_CANARY:" + operation]]
    require(seed["runcmd"] == expected, "seed_command_unexpected")


def docker_container(value, identifier, image, operation, running=None):
    require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict), "container_inspection_invalid")
    item = value[0]
    config, host, state = item.get("Config", {}), item.get("HostConfig", {}), item.get("State", {})
    require(item.get("Id") == identifier and item.get("Name") == "/citygo-offline-canary-" + operation and
            item.get("Image") == image and config.get("Labels", {}).get("citygo.offline-canary") == operation and
            config.get("User") == "65534:65534" and config.get("Entrypoint") == ["/canary"] and
            not config.get("Cmd") and host.get("NetworkMode") == "none" and host.get("ReadonlyRootfs") is True and
            not host.get("Binds") and not item.get("Mounts") and not host.get("PortBindings") and
            host.get("Privileged") is False and host.get("CapDrop") == ["ALL"] and not host.get("CapAdd") and
            host.get("SecurityOpt") == ["no-new-privileges"] and host.get("Memory") == 67108864 and
            host.get("MemorySwap") == 67108864 and host.get("NanoCpus") == 250000000 and host.get("PidsLimit") == 32,
            "container_configuration_changed")
    require(isinstance(state.get("Running"), bool) and (running is None or state["Running"] is running), "container_state_unexpected")
    return item


class Guest:
    def facts(self):
        return os.geteuid(), platform.machine(), platform.freedesktop_os_release()

    def info(self, path):
        try:
            return os.lstat(path)
        except FileNotFoundError:
            return None

    def read(self, path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode), "ordinary_file_required")
            data = os.read(fd, limit + 1)
            require(len(data) <= limit, "file_size_exceeded")
            return data
        finally:
            os.close(fd)

    def command(self, args, data=None, timeout=15, missing_ok=False):
        try:
            done = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=timeout, cwd="/", env=ENV, check=False)
        except subprocess.TimeoutExpired:
            raise Refused("command_timeout") from None
        except OSError:
            raise Refused("command_unavailable") from None
        require(len(done.stdout) <= 262144, "command_output_too_large")
        if missing_ok and done.returncode != 0:
            return None
        require(done.returncode == 0, "command_failed")
        return done.stdout

    def seed(self):
        import yaml
        class Loader(yaml.SafeLoader):
            pass
        def mapping(loader, node):
            result = {}
            for key_node, value_node in node.value:
                key = loader.construct_object(key_node)
                require(isinstance(key, str) and key not in result, "seed_duplicate_key")
                result[key] = loader.construct_object(value_node)
            return result
        Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
        # cloud-init's instance directory is a documented symlink; the leaf
        # read is O_NOFOLLOW. This is trusted bootstrap code, not PR code.
        return yaml.load(self.read("/var/lib/cloud/instance/user-data.txt", 200000), Loader=Loader)

    def workspace_absent(self):
        denied = {".git", ".runner", ".credentials", ".credentials_rsaparams", "actions-runner", "_work", "citygo-platform", "package.json"}
        roots = ("/home/citygo-bootstrap", "/home/ubuntu", "/root", "/opt", "/srv", "/workspace", "/work", "/_work", "/actions-runner", "/var/lib/github-actions")
        exclude = {"/opt/citygo-toolchain", "/root/.cache", "/root/.npm", "/home/citygo-bootstrap/.cache", "/home/citygo-bootstrap/.npm"}
        pending = [(root, 0) for root in roots if self.info(root) is not None]
        count = 0
        while pending:
            path, depth = pending.pop()
            require(os.path.basename(path) not in denied and stat.S_ISDIR(self.info(path).st_mode), "workspace_inventory_unverified")
            for name in os.listdir(path):
                count += 1
                require(count <= 4096 and name not in denied, "checkout_or_runner_present")
                child = path + "/" + name
                item = self.info(child)
                require(item is not None, "workspace_inventory_changed")
                require(not stat.S_ISLNK(item.st_mode), "workspace_symlink_unverified")
                if child not in exclude and stat.S_ISDIR(item.st_mode):
                    require(depth < 4, "workspace_inventory_depth_exceeded")
                    pending.append((child, depth + 1))

    def docker_canary(self, operation):
        image = container = None
        name = "citygo-offline-canary-" + operation
        # Refuse an existing namespace; never adopt or stop another container.
        require(self.command(DOCKER + ["container", "inspect", name], missing_ok=True) is None, "container_namespace_exists")
        before = self.command(DOCKER + ["image", "ls", "--all", "--quiet", "--no-trunc"]).decode("ascii").splitlines()
        require(len(before) <= 1024, "image_inventory_exceeded")
        with tempfile.TemporaryDirectory(prefix="citygo-offline-canary-", dir="/run") as directory:
            source, binary = directory + "/canary.c", directory + "/canary"
            fd = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as target:
                target.write(C_SOURCE)
            self.command(["/usr/bin/gcc", "-static", "-Os", "-s", "-Wl,--build-id=none", "-o", binary, source], timeout=60)
            program = self.read(binary, 2097152)
            require(program[:6] == b"\x7fELF\x02\x01" and program[18:20] == b"\x3e\x00", "static_canary_binary_invalid")
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as target:
                member = tarfile.TarInfo("canary")
                member.size, member.mode, member.uid, member.gid, member.mtime = len(program), 0o555, 65534, 65534, 0
                target.addfile(member, io.BytesIO(program))
            try:
                raw = self.command(DOCKER + ["import", "--change", "USER 65534:65534", "--change", 'ENTRYPOINT ["/canary"]',
                                             "--change", "LABEL citygo.offline-canary=" + operation, "-"], archive.getvalue(), timeout=30).strip().decode("ascii")
                require(re.fullmatch(r"sha256:[0-9a-f]{64}", raw) is not None and raw not in before, "image_not_new")
                image = raw
                raw = self.command(DOCKER + ["create", "--pull=never", "--name", name, "--label", "citygo.offline-canary=" + operation,
                                             "--network", "none", "--read-only", "--user", "65534:65534", "--cap-drop", "ALL",
                                             "--security-opt", "no-new-privileges", "--memory", "64m", "--memory-swap", "64m",
                                             "--cpus", "0.25", "--pids-limit", "32", "--log-driver", "none", image]).strip().decode("ascii")
                require(re.fullmatch(r"[0-9a-f]{64}", raw) is not None, "container_id_invalid")
                container = raw
                docker_container(unique_json(self.command(DOCKER + ["container", "inspect", container])), container, image, operation, False)
                require(self.command(DOCKER + ["start", "--attach", container], timeout=30) == MARKER, "native_docker_canary_output_invalid")
                item = docker_container(unique_json(self.command(DOCKER + ["container", "inspect", container])), container, image, operation, False)
                require(item["State"].get("ExitCode") == 0, "native_docker_canary_failed")
            finally:
                if container:
                    # No force or kill: preserve a running/changed container.
                    docker_container(unique_json(self.command(DOCKER + ["container", "inspect", container])), container, image, operation, False)
                    self.command(DOCKER + ["container", "rm", container])
                if image:
                    inspected = unique_json(self.command(DOCKER + ["image", "inspect", image]))
                    require(isinstance(inspected, list) and len(inspected) == 1 and inspected[0].get("Id") == image and
                            inspected[0].get("Config", {}).get("Labels", {}).get("citygo.offline-canary") == operation and
                            not inspected[0].get("RepoTags"), "image_ownership_changed")
                    self.command(DOCKER + ["image", "rm", image])

    def publish(self, operation, value):
        import fcntl
        for path in ("/var", "/var/lib", "/var/lib/hyperv"):
            item = self.info(path)
            require(item is not None and stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and item.st_mode & 0o022 == 0,
                    "kvp_directory_untrusted")
        fd = os.open(POOL, os.O_RDWR | os.O_NOFOLLOW)
        try:
            item = os.fstat(fd)
            require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and item.st_mode & 0o022 == 0,
                    "kvp_file_untrusted")
            end = time.monotonic() + 5
            while True:
                try:
                    # lockf uses POSIX F_SETLK/F_SETLKW, like hv_kvp_daemon.
                    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < end, "kvp_lock_timeout")
                    time.sleep(0.05)
            require(self.info(POOL).st_ino == item.st_ino and self.info(POOL).st_dev == item.st_dev, "kvp_path_changed")
            raw = os.pread(fd, POOL_BOUND + 1, 0)
            expected, offset, record = update_pool(raw, ("CityGoOfflineCanary-" + operation).encode("ascii"), value)
            remaining = record
            while remaining:
                written = os.pwrite(fd, remaining, offset)
                require(written > 0, "kvp_write_failed")
                remaining, offset = remaining[written:], offset + written
            os.fsync(fd)
            require(os.pread(fd, POOL_BOUND + 1, 0) == expected and self.info(POOL).st_ino == item.st_ino,
                    "kvp_readback_failed")
        finally:
            os.close(fd)


def identity(guest, operation):
    uid, architecture, release = guest.facts()
    require(uid == 0 and architecture == "x86_64" and release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "24.04",
            "trusted_ubuntu_root_required")
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud", "nocloud_required")
    require(guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() == ("citygo-canary-" + operation).encode("ascii"),
            "instance_identity_mismatch")


def wait_local_services(guest):
    """Observe a first-boot service race; never start/reconfigure a service."""
    deadline = time.monotonic() + 30
    while True:
        ready = True
        for args, expected in ((["/usr/bin/systemctl", "is-active", "hv-kvp-daemon.service"], b"active"),
                               (DOCKER + ["info", "--format", "{{.OSType}}"], b"linux")):
            remaining = deadline - time.monotonic()
            require(remaining > 0, "local_services_not_ready")
            try:
                raw = guest.command(args, timeout=min(2, remaining), missing_ok=True)
                ready &= raw is not None and raw.strip() == expected
            except Refused as error:
                require(error.code in ("command_timeout", "command_failed", "command_unavailable"), error.code)
                ready = False
        if ready:
            return
        remaining = deadline - time.monotonic()
        require(remaining > 0, "local_services_not_ready")
        time.sleep(min(1, remaining))


def observe(guest, operation):
    validate_seed(guest.seed(), operation, guest.read(SCRIPT, 131072))
    for path in ("/home/citygo-bootstrap/.ssh/authorized_keys", "/home/citygo-bootstrap/.ssh/authorized_keys2",
                 "/root/.ssh/authorized_keys", "/root/.ssh/authorized_keys2"):
        item = guest.info(path)
        require(item is None or stat.S_ISREG(item.st_mode) and item.st_size == 0, "bootstrap_authorization_present")
    sudo = guest.read("/etc/sudoers.d/90-cloud-init-users", 65536)
    require(not any(b"citygo-bootstrap" in line and not line.lstrip().startswith(b"#") for line in sudo.splitlines()),
            "bootstrap_sudo_rule_present")
    for account in ("citygo-bootstrap", "root"):
        fields = guest.command(["/usr/bin/passwd", "--status", account]).split()
        require(len(fields) >= 2 and fields[0] == account.encode("ascii") and fields[1] == b"L", "password_account_not_locked")
    validate_mounts(guest.read("/proc/self/mountinfo", 262144))
    validate_network(unique_json(guest.command(["/usr/sbin/ip", "-j", "address", "show"])),
                     unique_json(guest.command(["/usr/sbin/ip", "-j", "-4", "route", "show", "table", "all"])),
                     unique_json(guest.command(["/usr/sbin/ip", "-j", "-6", "route", "show", "table", "all"])))
    guest.workspace_absent()
    require(guest.command(["/usr/local/bin/node", "--version"]).strip() == b"v24.22.0" and
            guest.command(["/usr/local/bin/pnpm", "--version"]).strip() == b"10.15.0", "toolchain_version_mismatch")
    require(guest.command(["/usr/bin/systemctl", "is-active", "hv-kvp-daemon.service"]).strip() == b"active", "kvp_daemon_not_active")
    require(guest.command(DOCKER + ["info", "--format", "{{.OSType}}"]).strip() == b"linux" and
            guest.command(DOCKER + ["container", "ls", "--all", "--quiet"]).strip() == b"", "native_docker_not_idle")
    machine_id = guest.read("/etc/machine-id", 64).strip().decode("ascii")
    require(re.fullmatch(r"[0-9a-f]{32}", machine_id) is not None, "machine_id_invalid")
    return {"machineId": machine_id, "ed25519Fingerprint": public_fingerprint(guest.read("/etc/ssh/ssh_host_ed25519_key.pub", 4096)),
            "bootstrapAuthAbsent": True, "bootstrapSudoRuleAbsent": True, "seedContainsOnlyPublicCanary": True,
            "noSharedHostFilesystemObserved": True, "noExternalAddressOrRouteObserved": True,
            "selectedRunnerCheckoutPathsAbsent": True, "node": "24.22.0", "pnpm": "10.15.0", "kvpDaemonActive": True}


def run(guest, operation, apply):
    report = {"version": 1, "scope": "disconnected_local_clone_canary", "operationId": operation,
              "ok": False, "code": "not_started", "dockerOfflineCanaryVerified": False,
              "ciJobsAuthorized": False, "connectedNetworkIsolationVerified": False, "vmPoweredOff": False}
    publication_allowed = False
    try:
        identity(guest, operation)
        publication_allowed = True
        if apply:
            wait_local_services(guest)
        report.update(observe(guest, operation))
        if apply:
            guest.docker_canary(operation)
            report.update(ok=True, code="offline_clone_canary_complete", dockerOfflineCanaryVerified=True)
        else:
            report.update(ok=True, code="plan_only_no_changes")
    except Refused as error:
        report.update(ok=False, code=error.code)
    except Exception:
        report.update(ok=False, code="canary_unavailable")
    if apply and publication_allowed:
        try:
            guest.publish(operation, report_bytes(report))
        except Exception:
            report.update(ok=False, code="kvp_publication_failed")
    return report


def main(arguments):
    try:
        apply, operation = options(arguments)
        report = run(Guest(), operation, apply)
    except Refused as error:
        report = {"version": 1, "ok": False, "code": error.code, "ciJobsAuthorized": False,
                  "connectedNetworkIsolationVerified": False}
    except Exception:
        report = {"version": 1, "ok": False, "code": "canary_unavailable", "ciJobsAuthorized": False,
                  "connectedNetworkIsolationVerified": False}
    print(report_bytes(report).decode("ascii"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
