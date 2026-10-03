#!/usr/bin/env python3
"""One-time owner-run installation, never invoked by GitHub's restricted key.

Run from an inspected source tree on the server as root. Existing server secrets,
AI settings, PostgreSQL, DNS and Nginx are not changed. No deployment is started.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

MODULES = ("autodeploy", "backup", "control", "finish", "image_gate", "migrate", "migration_job",
           "prepare", "recovery", "release", "start", "target", "worker")
CONFIG = Path("/etc/citygo/backup.json")
INSTALL_ROOT = Path("/opt/citygo")
USER = "citygo-deploy"


def require(value, code):
    if not value: raise RuntimeError(code)


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
    require(result.returncode == 0, "install-command-failed")
    return result.stdout


def write_once(path, data, mode):
    if os.path.lexists(path):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) in (mode, mode & ~0o077) and path.read_bytes() == data, "staged-file-changed")
        path.chmod(mode)
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fchmod(stream.fileno(), mode); os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--public-key", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--allow-main-migrations", action="store_true", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and sys.version_info >= (3, 11), "root-python311-required")
    os.umask(0o077)
    source = args.source.resolve()
    public_key = args.public_key.read_text().strip()
    require(re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]{68}=?(?: [a-zA-Z0-9_.-]{1,80})?", public_key), "ed25519-key-required")
    require(not Path("/etc/citygo/autodeploy.json").exists(), "already-installed-do-not-overwrite")
    require(not Path("/etc/sudoers.d/citygo-deploy").exists(), "sudoers-already-exists")
    try:
        pwd.getpwnam(USER)
    except KeyError:
        pass
    else:
        raise RuntimeError("deploy-user-already-exists")
    files = {"deploy/backup/" + name + ".py": (source / "deploy/backup" / (name + ".py")).read_bytes() for name in MODULES}
    files["deploy/postgres/dump.sh"] = (source / "deploy/postgres/dump.sh").read_bytes()
    digest = hashlib.sha256(json.dumps({k: hashlib.sha256(v).hexdigest() for k, v in files.items()}, sort_keys=True).encode()).hexdigest()
    dest = INSTALL_ROOT / ("autodeploy-controller-" + digest[:16])
    dest.mkdir(mode=0o755, exist_ok=True)
    require(not dest.is_symlink() and dest.stat().st_uid == 0 and not dest.stat().st_mode & 0o022, "controller-permissions")
    for name, raw in files.items():
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        write_once(target, raw, 0o644)
    sys.path.insert(0, str(dest / "deploy/backup"))
    import autodeploy as a
    import backup as b
    import target as t
    config = b.load_config(CONFIG)
    b.assert_operation_idle(b.protected(config["state_dir"], directory=True))
    a.p.hostname(args.origin)
    # Initial enrollment is allowed only for the original delivered Compose.
    # A running newer generation must be inspected/enrolled explicitly instead.
    current = Path(config["compose_file"]).parent.parent
    raw = t.read_file(current / "release.json")
    manifest = t.manifest(raw, current=True)
    # The original boot legitimately left delivery-status.json / __pycache__
    # alongside the bundle. Preserve those files and its live Compose; create
    # a separate exact, hash-verified baseline for the strict selection gate.
    baseline = dest / "initial-bundle"
    baseline.mkdir(mode=0o700, exist_ok=True)
    for item in manifest["runtimeFiles"]:
        data = t.read_file(current / item["path"])
        require(t.sha256(data) == item["sha256"], "initial-runtime-hash")
        target = baseline / item["path"]
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_once(target, data, 0o600)
    write_once(baseline / "release.json", raw, 0o600)
    t.bundle(baseline, t.sha256(raw), current=True)
    require(manifest["sourceSha"] == config["source_sha"], "initial-release-mismatch")
    secrets = {"api": "/etc/citygo/secrets/api.json", "migration": "/etc/citygo/secrets/migrate.json",
               "worker": "/etc/citygo/secrets/worker.json", "backup": "/etc/citygo/secrets/db_backup_password"}
    api = t.strict_json(t.read_file(secrets["api"]))
    profile = a.s.ROUTERAI_PROFILE if "ROUTERAI_API_KEY" in api else a.s.PROFILE
    host = a.s.Host(config, Path(config["state_dir"]), "/var/lib/citygo/ingress", args.origin)
    values = host.inventory()
    app = next(v for v in values if v["Labels"].get("com.docker.compose.service") == "api")
    environment = dict(item.split("=", 1) for item in host.detail(app["Id"])["Config"]["Env"])
    require(environment.get("LLM_PROVIDER") == ("disabled" if profile == a.s.PROFILE else "routerai"), "ai-profile-mismatch")
    nginx = "/etc/nginx/sites-available/citygo-pilot"
    bundles = INSTALL_ROOT / "autodeploy-bundles"
    bundles.mkdir(mode=0o700, exist_ok=True); b.protected(bundles, directory=True)
    policy = {"version": 1, "purpose": "citygo-main-standing-authorization", "enabled": True, "repository": t.REPOSITORY,
        "origin": args.origin, "profile": profile, "config_path": str(CONFIG), "ingress_directory": "/var/lib/citygo/ingress",
        "bundles_directory": str(bundles), "initial_bundle": str(baseline), "initial_manifest_sha256": t.sha256(raw),
        "registry_config": "/etc/citygo/registry-read-only", "postgres_image": manifest["bases"]["postgres"],
        "secret_files": secrets, "secret_sha256": {k: t.sha256(t.read_file(v)) for k, v in secrets.items()},
        "allow_new_migrations": args.allow_main_migrations, "nginx_config": nginx, "nginx_sha256": t.sha256(t.read_file(nginx))}
    a.check_pins(policy); host.probe()
    require(Path(policy["ingress_directory"], "traffic-open").is_file(), "traffic-not-open")
    entry = dest / "deploy/backup/autodeploy.py"
    sudo_line = f"{USER} ALL=(root) NOPASSWD: /usr/bin/python3 -I -B {entry}\n"
    sudo_check = dest / "sudoers.check"
    write_once(sudo_check, sudo_line.encode(), 0o440)
    command(["/usr/sbin/visudo", "-cf", str(sudo_check)])
    # Validate metadata/hash bindings before granting any new capability.
    preview = dest / "policy.preview.json"
    write_once(preview, (json.dumps(policy, sort_keys=True) + "\n").encode(), 0o600)
    a.policy(preview)
    command(["/usr/sbin/useradd", "--system", "--user-group", "--home-dir", "/var/lib/citygo-deploy",
             "--no-create-home", "--shell", "/bin/sh", USER])
    home = Path("/var/lib/citygo-deploy"); home.mkdir(mode=0o755)
    ssh = home / ".ssh"; ssh.mkdir(mode=0o755)
    home.chmod(0o755); ssh.chmod(0o755)
    # Home and authorized_keys stay ROOT-owned, not writable by deploy account.
    line = f'restrict,command="/usr/bin/sudo -n /usr/bin/python3 -I -B {entry}" {public_key}\n'
    write_once(ssh / "authorized_keys", line.encode(), 0o644)
    write_once(Path("/etc/sudoers.d/citygo-deploy"), sudo_line.encode(), 0o440)
    command(["/usr/sbin/visudo", "-c"])
    # Preserve original bytes for an operator rollback of enrollment only. This
    # is NOT a rollback of deployed application data or schema.
    write_once(dest / "backup.before-install.json", t.read_file(CONFIG, private=True), 0o600)
    b.atomic_json(CONFIG, {**config, "upload_enabled": True})
    write_once(Path(a.POLICY_PATH), preview.read_bytes(), 0o600)
    b.sync_directory(Path("/etc/citygo"))
    print(json.dumps({"installed": True, "controller_sha256": digest, "entrypoint": str(entry),
        "ssh_user": USER, "postgres_image": manifest["bases"]["postgres"], "ai_profile": profile,
        "backup_before_each_release": True, "scheduled_backups_changed": False, "deployed": False}))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        code = str(error) if type(error).__name__ in ("RuntimeError", "BackupError") else "details-hidden"
        if not re.fullmatch(r"[a-z0-9-]{1,80}", code): code = "details-hidden"
        print("Installation stopped: " + code + "; inspect enrollment files before retrying.", file=sys.stderr)
        sys.exit(1)
