import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(
  new URL("../deploy/ci/seal-bootstrap-guest.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const match = script.match(
  /<<'PY_SEAL_BOOTSTRAP'\n([\s\S]*?)\nPY_SEAL_BOOTSTRAP\s*$/,
);
assert(match);
const source = match[1];
const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable =
  spawnSync(python, ["-I", "-B", "--version"], { encoding: "utf8" }).status ===
  0;

// Changing __name__ before the source prevents its CLI from constructing Guest
// or inspecting the host machine. Only the in-memory FakeGuest is used below.
const definitions = `__name__ = 'synthetic_seal_tests'\n${source}\n`;
function synthetic(code) {
  const result = spawnSync(
    python,
    ["-I", "-B", "-c", definitions + fixture + "\n" + code],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

// Everything below is a fake filesystem and a fixed-command dispatcher in
// memory. No root filesystem, actual commands, keys, services or VM are used.
const fixture = String.raw`
OP = "11111111-2222-4333-8444-555555555555"
import base64
PUBLIC_KEY = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32
AUTH_BYTES = b'from="192.0.2.9",restrict ssh-ed25519 ' + base64.b64encode(PUBLIC_KEY) + b" synthetic-public-test\n"
REPORT_BYTES = json.dumps({"version":1,"toolchainInstalled":True,"node":"24.22.0","pnpm":"10.15.0","playwright":"1.63.0"}).encode("ascii")
HASH = digest(REPORT_BYTES)
SUDO_BYTES = b"# Created by cloud-init\r\ncitygo-bootstrap ALL=(ALL) NOPASSWD:ALL\r\n# preserve other rule\r\nother-user ALL=(ALL) NOPASSWD:/usr/bin/true\r\n"

class FakeGuest:
    def __init__(self):
        self.nodes, self.data, self.commands, self.mutations = {}, {}, [], []
        self.command_overrides = {}
        self.fail_clean = False
        self.leave_cloud_artifact = False
        self.fail_receipt = False
        for path in ("/etc/ssh", "/etc/sudoers.d", CLOUD, "/var/lib/citygo-bootstrap", HOME, HOME + "/.ssh", "/root", "/opt", "/opt/citygo-toolchain", "/srv", "/etc/cloud/clean.d"):
            self.add(path, stat.S_IFDIR | 0o700, 1000 if path.startswith(HOME) else 0)
        self.file(AUTH, AUTH_BYTES, 0o600, 1000)
        self.file(SUDO, SUDO_BYTES, 0o440)
        self.file(REPORT, REPORT_BYTES, 0o644)
        self.file("/etc/machine-id", b"a" * 32 + b"\n", 0o444)
        self.file("/proc/self/mountinfo", b"25 1 0:25 / /run rw,nosuid,nodev - tmpfs tmpfs rw\n", 0o444)
        self.add("/var/lib/dbus/machine-id", stat.S_IFLNK | 0o777)
        for path in HOST_KEYS[:2]:
            # Fake bytes exist but read() explicitly refuses any host-key read.
            self.file(path, b"synthetic-opaque-not-a-key", 0o644 if path.endswith(".pub") else 0o600)
        self.file(CLOUD + "/instance-data.json", b"synthetic-private-cache", 0o600)
        for path in LOGS:
            self.file(path, b"synthetic-private-log", 0o600)
        self.add("/var/run/docker.sock", stat.S_IFSOCK | 0o660)

    def add(self, path, mode, uid=0):
        self.nodes[path] = (1, len(self.nodes) + 1, mode, uid, 0, 0, 1)

    def file(self, path, raw, mode, uid=0):
        self.add(path, stat.S_IFREG | mode, uid)
        self.data[path] = raw
        item = list(self.nodes[path]); item[5] = len(raw); self.nodes[path] = tuple(item)

    def facts(self):
        return 0, "x86_64", (3, 12), {"ID":"ubuntu", "VERSION_ID":"24.04"}, 1000, HOME

    def info(self, path):
        return self.nodes.get(path)

    def names(self, path):
        prefix = path.rstrip("/") + "/"
        return sorted({name[len(prefix):].split("/")[0] for name in self.nodes if name.startswith(prefix)})

    def read(self, path, bound):
        assert path not in HOST_KEYS, "NEVER read/hash private or public host-key contents"
        assert path not in LOGS and not path.startswith(CLOUD + "/"), "NEVER read cache/log contents"
        raw = self.data[path]
        assert len(raw) <= bound
        return raw

    def resolved(self, path):
        return "/etc/machine-id"

    def command(self, args, data=None, timeout=15):
        self.commands.append(args)
        if tuple(args) in self.command_overrides:
            return self.command_overrides[tuple(args)]
        if args == ["/usr/bin/cloud-id"]: return b"nocloud\n"
        if args == ["/usr/bin/cloud-init", "query", "v1.instance_id"]: return ("citygo-bootstrap-" + OP + "\n").encode("ascii")
        if args == ["/usr/bin/cloud-init", "status", "--format", "json"]: return b'{"status":"done","errors":[],"recoverable_errors":{}}'
        if args[0] == "/usr/bin/systemctl": return b"success\n" if "--property=Result" in args else b"0\n"
        if args == ["/usr/bin/cloud-init", "clean", "--help"]: return b"--logs --seed --machine-id --reboot --configs"
        if args[0] == "/usr/bin/passwd": return (args[-1] + " L 2026-10-19 0 99999 7 -1\n").encode("ascii")
        if args[0] == "/usr/sbin/visudo": return b"parsed OK\n"
        if args[0] == "/usr/bin/docker": return b"linux\n" if "info" in args else b""
        if args == ["/usr/bin/cloud-init", "clean", "--logs", "--seed", "--machine-id"]:
            self.mutations.append("cloud_init_clean")
            if self.fail_clean: raise Refused("command_failed")
            for path in list(self.nodes):
                if path in LOGS or path.startswith(CLOUD + "/"):
                    del self.nodes[path]; self.data.pop(path, None)
            if self.leave_cloud_artifact: self.file(CLOUD + "/.unexpected-hidden-cache", b"hidden", 0o600)
            self.file("/etc/machine-id", b"uninitialized\n", 0o444)
            return b""
        raise AssertionError("Unexpected fixed command")

    def replace_sudo(self, raw, before, operation):
        assert self.info(SUDO) == before and operation == OP
        self.mutations.append("replace_sudo")
        self.file(SUDO, raw, 0o440)

    def unlink(self, path, before):
        assert self.info(path) == before
        assert path == AUTH or path in HOST_KEYS
        self.mutations.append("unlink_bootstrap_auth" if path == AUTH else "unlink_fixed_host_key")
        del self.nodes[path]; self.data.pop(path, None)

    def write_new(self, path, raw, mode):
        assert path == RECEIPT and mode == 0o600 and self.info(path) is None
        if self.fail_receipt: raise OSError("SYNTHETIC_SECRET_MUST_NOT_APPEAR")
        self.mutations.append("write_seal_receipt")
        self.file(path, raw, mode)
`;

test(
  "shell contains only embedded Python, and embedded Python compiles",
  { skip: !pythonAvailable },
  () => {
    assert.equal(script.split("\n")[0], "#!/bin/sh");
    assert.match(script, /exec python3 -I -B - "\$@"/);
    const result = spawnSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        "import sys; compile(sys.argv[1], 'public-seal-source', 'exec')",
        source,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "canonical operation/report and exact apply acknowledgement are required",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
assert options(["--plan", "--operation-id", OP, "--expected-report-sha256", HASH]) == (False, OP, HASH)
ack = "SEAL_BOOTSTRAP_AUTH:" + OP + ":" + HASH
assert options(["--apply", "--operation-id", OP, "--expected-report-sha256", HASH, "--acknowledge", ack]) == (True, OP, HASH)
for args in (["--apply", "--operation-id", OP, "--expected-report-sha256", HASH], ["--apply", "--operation-id", OP, "--expected-report-sha256", HASH, "--acknowledge", "yes"], ["--plan", "--operation-id", "../../arbitrary", "--expected-report-sha256", HASH], ["--plan", "--operation-id", OP.upper(), "--expected-report-sha256", "untrusted"], ["--plan", "--operation-id", "00000000-0000-0000-0000-000000000000", "--expected-report-sha256", HASH]):
    try: options(args); raise AssertionError("must refuse")
    except Refused: pass
`);
  },
);

test(
  "sudo transform removes one known rule, preserving every other byte and refusing ambiguity",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
expected = b"# Created by cloud-init\r\n# preserve other rule\r\nother-user ALL=(ALL) NOPASSWD:/usr/bin/true\r\n"
assert sudo_without_bootstrap(SUDO_BYTES) == expected
for raw in (expected, SUDO_BYTES + b"citygo-bootstrap ALL=(ALL) NOPASSWD:ALL\n", SUDO_BYTES + b"citygo-bootstrap ALL=(ALL) ALL\n", SUDO_BYTES + b"%other citygo-bootstrap=ALL\n", SUDO_BYTES + b"\x00"):
    try: sudo_without_bootstrap(raw); raise AssertionError("must refuse")
    except Refused: pass
assert valid_authorized_key(AUTH_BYTES)
for raw in (AUTH_BYTES + AUTH_BYTES, AUTH_BYTES.replace(b",restrict", b""), AUTH_BYTES.replace(b"192.0.2.9", b"999.0.0.1"), b"ssh-ed25519 AAAA"):
    assert not valid_authorized_key(raw)
`);
  },
);

test(
  "complete synthetic plan is read-only and never claims sealed/golden/isolation readiness",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
guest = FakeGuest()
result = seal(guest, OP, HASH, False)
assert result["ok"] and result["preflightPassed"] and result["code"] == "plan_only_no_changes", result
assert guest.mutations == [] and guest.info(RECEIPT) is None
assert not any(args == ["/usr/bin/cloud-init", "clean", "--logs", "--seed", "--machine-id"] for args in guest.commands)
for field in ("mutationsStarted", "bootstrapAuthorizedKeyAbsent", "goldenImageSealed", "vmPoweredOff", "seedIsoDetached", "guestIsolationVerified", "githubJobsAuthorized", "freshCloneIdentityVerified"):
    assert result[field] is False
`);
  },
);

test(
  "complete synthetic apply changes only reviewed targets and verifies persistent clean/readback",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
guest = FakeGuest()
result = seal(guest, OP, HASH, True)
assert result["ok"] and result["code"] == "guest_auth_sealed_poweroff_required", result
assert guest.mutations == ["replace_sudo", "unlink_bootstrap_auth", "unlink_fixed_host_key", "unlink_fixed_host_key", "cloud_init_clean", "write_seal_receipt"]
assert guest.data[SUDO] == sudo_without_bootstrap(SUDO_BYTES)
assert guest.data[REPORT] == REPORT_BYTES and guest.info(HOME) is not None
assert guest.data["/etc/machine-id"] == b"uninitialized\n"
assert guest.names(CLOUD) == []
assert json.loads(guest.data[RECEIPT]) == result
assert result["volatileRuntimeDataMayRemainUntilPoweroff"] is True
for field in ("vmPoweredOff", "seedIsoDetached", "guestIsolationVerified", "githubJobsAuthorized", "goldenImageSealed", "freshCloneIdentityVerified"):
    assert result[field] is False
assert seal(guest, OP, HASH, True)["code"] == "seal_receipt_already_exists"
`);
  },
);

test(
  "identity, dirty state, unsupported auth/files and clean hooks all refuse before mutation",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
cases = []
def case(change, expected): cases.append((change, expected))
case(lambda g: g.command_overrides.update({("/usr/bin/cloud-id",): b"azure\n"}), "nocloud_required")
case(lambda g: g.command_overrides.update({("/usr/bin/cloud-init", "query", "v1.instance_id"): b"citygo-bootstrap-wrong\n"}), "instance_identity_mismatch")
case(lambda g: g.command_overrides.update({("/usr/bin/cloud-init", "status", "--format", "json"): b'{"status":"running","errors":[]}'}), "cloud_init_not_done")
case(lambda g: g.command_overrides.update({("/usr/bin/cloud-init", "status", "--format", "json"): b'{"status":"done","errors":[],"recoverable_errors":{"x":["secret"]}}'}), "cloud_init_has_errors")
case(lambda g: g.command_overrides.update({("/usr/bin/cloud-init", "clean", "--help"): b"--logs --seed"}), "cloud_init_clean_flags_unavailable")
case(lambda g: g.file("/etc/cloud/clean.d/foreign-hook", b"do not execute", 0o755), "custom_clean_hook_refused")
case(lambda g: g.file("/var/lib/dbus/machine-id", b"separate", 0o444), "separate_dbus_machine_id_refused")
case(lambda g: g.file("/proc/self/mountinfo", b"25 1 0:25 / /run rw - ext4 none rw\n", 0o444), "run_tmpfs_required")
case(lambda g: g.file(REPORT, b"changed", 0o644), "installer_report_hash_mismatch")
case(lambda g: g.file(AUTH, AUTH_BYTES + AUTH_BYTES, 0o600, 1000), "bootstrap_authorized_key_unexpected")
case(lambda g: g.file(HOME + "/.ssh/id_ed25519", b"NEVER READ", 0o600, 1000), "additional_user_ssh_files_refused")
case(lambda g: g.file("/root/.ssh/authorized_keys", b"foreign auth", 0o600), "additional_ssh_auth_refused")
case(lambda g: g.file("/etc/ssh/ssh_host_foreign_key", b"NEVER READ", 0o600), "unexpected_host_key_path")
case(lambda g: g.add(HOST_KEYS[0], stat.S_IFLNK | 0o777), "trusted_file_required")
case(lambda g: g.file(HOME + "/.git", b"checkout", 0o600, 1000), "checkout_or_runner_present")
case(lambda g: g.command_overrides.update({("/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "container", "ls", "--all", "--quiet"): b"some-container\n"}), "docker_containers_present")
for change, expected in cases:
    guest = FakeGuest(); change(guest)
    result = seal(guest, OP, HASH, True)
    assert result["ok"] is False and result["code"] == expected, (expected, result)
    assert guest.mutations == [] and result["mutationsStarted"] is False
`);
  },
);

test(
  "partial clean/readback/receipt failures remain failures with conservative external flags",
  { skip: !pythonAvailable },
  () => {
    synthetic(String.raw`
for field, expected in (("fail_clean", "command_failed"), ("leave_cloud_artifact", "seal_readback_failed"), ("fail_receipt", "seal_unavailable")):
    guest = FakeGuest(); setattr(guest, field, True)
    result = seal(guest, OP, HASH, True)
    assert result["ok"] is False and result["code"] == expected and result["mutationsStarted"] is True, result
    assert guest.info(RECEIPT) is None
    assert "SYNTHETIC_SECRET" not in json.dumps(result)
    for flag in ("vmPoweredOff", "seedIsoDetached", "guestIsolationVerified", "githubJobsAuthorized", "goldenImageSealed", "freshCloneIdentityVerified"):
        assert result[flag] is False
guest = FakeGuest(); guest.leave_cloud_artifact = True
result = seal(guest, OP, HASH, True)
assert result["persistentCloudArtifactsAbsent"] is False
`);
  },
);

test("source has only fixed destructive targets and no power/service/network/container execution", () => {
  assert.match(
    source,
    /\["\/usr\/bin\/cloud-init", "clean", "--logs", "--seed", "--machine-id"\]/,
  );
  assert.match(source, /os\.O_EXCL/);
  assert.match(source, /os\.O_NOFOLLOW/);
  assert.match(source, /os\.fsync/);
  assert.match(source, /current\.st_nlink == 1/);
  assert.match(source, /--host", "unix:\/\/\/var\/run\/docker\.sock/);
  assert.doesNotMatch(
    source,
    /shutil|rmtree|os\.remove|os\.rmdir|os\.system|shell=True|sudo\s+-n|ssh-keygen/,
  );
  assert.doesNotMatch(
    source,
    /"(?:reboot|poweroff|shutdown|restart|stop|start|pull|run|exec)"|"--reboot"|"--configs"/,
  );
  assert.doesNotMatch(
    source,
    /os\.environ|journalctl|history|traceback|str\(error\)|\.message/,
  );
  assert.equal((source.match(/guest\.unlink\(/g) || []).length, 2);
});
