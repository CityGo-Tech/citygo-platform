#!/usr/bin/python3
"""HTTPS Ubuntu sources in ONE new Ubuntu 24.04 disposable CI guest only.

No downloads, repository/key additions, TLS/signature bypass or host changes.
Preserves suites/components/Signed-By and refuses unexpected sources/options.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

SOURCE = "/etc/apt/sources.list.d/ubuntu.sources"
PART = "/etc/apt/sources.list.d/.citygo-job-ubuntu.sources.part"
ROOT = "/var/lib/citygo-ci-runner"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"


def require(value, code):
    if not value:
        raise ValueError("ci_job_apt_" + code)


def rewrite(raw):
    require(type(raw) is bytes and 2 <= len(raw) <= 32768 and raw.isascii() and
            b"\r" not in raw and b"\0" not in raw and raw.endswith(b"\n"), "bytes")
    lines = raw.decode("ascii").splitlines(keepends=True)
    replacements = {}
    stanza = {}
    count = 0

    def finish():
        nonlocal count
        if not stanza:
            return
        require({"types", "uris", "suites", "components", "signed-by"} <= set(stanza) and
                set(stanza) <= {"types", "uris", "suites", "components", "signed-by", "architectures", "enabled"}, "fields")
        require(set(stanza["types"][1].split()) <= {"deb", "deb-src"} and stanza["types"][1].split(), "types")
        require(stanza["signed-by"][1] == "/usr/share/keyrings/ubuntu-archive-keyring.gpg", "signature")
        require(set(stanza["suites"][1].split()) <= {"noble", "noble-updates", "noble-backports", "noble-security"} and
                stanza["suites"][1].split(), "suites")
        require(set(stanza["components"][1].split()) <= {"main", "restricted", "universe", "multiverse"} and
                stanza["components"][1].split(), "components")
        require("architectures" not in stanza or stanza["architectures"][1] == "amd64", "architecture")
        require("enabled" not in stanza or stanza["enabled"][1] in ("yes", "no"), "enabled")
        index, value = stanza["uris"]
        uris = value.split()
        require(1 <= len(uris) <= 4 and len(set(uris)) == len(uris), "uris")
        targets = []
        for value in uris:
            try:
                url = urlsplit(value)
                port = url.port
            except ValueError:
                raise ValueError("ci_job_apt_uri") from None
            require(url.scheme in ("http", "https") and url.username is None and url.password is None and
                    port is None and not url.query and not url.fragment and url.path in ("/ubuntu", "/ubuntu/") and
                    url.hostname is not None and re.fullmatch(r"(?:security|archive|[a-z0-9-]+\.archive)\.ubuntu\.com", url.hostname), "uri")
            host = "security.ubuntu.com" if url.hostname == "security.ubuntu.com" else "archive.ubuntu.com"
            target = "https://" + host + "/ubuntu/"
            if target not in targets:
                targets.append(target)
        header = lines[index].split(":", 1)[0]
        replacements[index] = header + ": " + " ".join(targets) + "\n"
        count += 1
        stanza.clear()

    for index, line in enumerate(lines):
        if not line.strip():
            finish()
            continue
        if line.lstrip().startswith("#"):
            continue
        require(not line.startswith((" ", "\t")), "continuation")
        match = re.fullmatch(r"([A-Za-z][A-Za-z-]*):[ \t]*([^\n]*)\n", line)
        require(match is not None, "line")
        name = match[1].lower()
        require(name not in stanza and match[2].strip(), "duplicate_or_empty")
        stanza[name] = (index, match[2].strip())
    finish()
    require(1 <= count <= 4, "stanzas")
    return "".join(replacements.get(index, line) for index, line in enumerate(lines)).encode("ascii")


def root_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "owner")
        raw = os.read(fd, 32769)
        require(len(raw) <= 32768, "size")
        return raw, item
    finally:
        os.close(fd)


def record(name, value):
    require(name in ("apt-https-intent.json", "apt-https-result.json"), "record")
    fd = os.open(ROOT + "/" + name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(json.dumps(value, separators=(",", ":")).encode("ascii"))
        stream.flush()
        os.fsync(stream.fileno())


def prepare(operation):
    require(type(operation) is str and re.fullmatch(UUID, operation), "operation")
    require(sys.platform == "linux" and os.geteuid() == 0, "linux_root")
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
    def command(args):
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=15, env=env, cwd="/", check=False)
        require(result.returncode == 0 and len(result.stdout) <= 1024, "identity_command")
        return result.stdout.strip()
    require(command(["/usr/bin/cloud-id"]) == b"nocloud" and
            command(["/usr/bin/cloud-init", "query", "v1.instance_id"]) ==
            ("citygo-runner-canary-" + operation).encode("ascii"), "instance")
    for path in ("/etc", "/etc/apt", "/etc/apt/sources.list.d", "/var", "/var/lib", ROOT):
        item = os.lstat(path)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022, "directory")
    old, before = root_read(SOURCE)
    new = rewrite(old)
    require(not os.path.lexists(PART), "partial_attempt")
    value = dict(version=1, scope="disposable_ci_apt_https", operationId=operation,
                 oldSha256=hashlib.sha256(old).hexdigest(), newSha256=hashlib.sha256(new).hexdigest())
    record("apt-https-intent.json", value)
    if new != old:
        fd = os.open(PART, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "wb") as stream:
            stream.write(new)
            stream.flush()
            os.fsync(stream.fileno())
        again, current = root_read(SOURCE)
        require(again == old and (current.st_dev, current.st_ino, current.st_mtime_ns) ==
                (before.st_dev, before.st_ino, before.st_mtime_ns), "concurrent_source_change")
        os.replace(PART, SOURCE)
    require(root_read(SOURCE)[0] == new, "readback")
    record("apt-https-result.json", dict(value, stage="https_sources_verified"))
    return True


def main(args):
    if args == ["--plan"]:
        print('{"stage":"plan_only_unverified","guestChanged":false}')
        return 0
    if not (len(args) == 5 and args[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, args[2]) and
            args[3:] == ["--acknowledge", "PREPARE_DISPOSABLE_APT_HTTPS:" + args[2]]):
        print('{"stage":"refused","guestChanged":false}')
        return 2
    try:
        prepare(args[2])
        print('{"stage":"https_sources_verified","nativeAcceptanceRequired":true}')
        return 0
    except Exception:
        print('{"stage":"failed_preserved","nativeAcceptanceRequired":true}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
