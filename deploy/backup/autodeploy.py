#!/usr/bin/env python3
"""Restricted main-deployment entrypoint; installed by the owner, not by CI.

This is a NEW standing authorization mode. Stage approval files are machine-issued
capabilities under a protected server policy, NOT independent human reviews.
The existing manual controller remains available and fail-closed.
"""
import io
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

# -I ignores the caller's Python environment. Only this root-installed directory
# is importable; never add a downloaded candidate directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup as b
import control as ctl
import finish as f
import image_gate as g
import migration_job as m
import prepare as p
import start as s
import target as t
import worker as w

POLICY_PATH = "/etc/citygo/autodeploy.json"
WORKFLOW = ".github/workflows/deploy-main.yml"
ARCHIVE_LIMIT = 8 * 1024 * 1024
SECRET_ROLES = {"api", "migration", "worker", "backup"}


def event(code):
    b.require(t.matches(code, r"[a-z0-9-]{1,80}"), "event-code")
    print("CityGo deploy: " + code, flush=True)


def request(raw):
    value = t.strict_json(raw)
    t.keys(value, {"version", "sha", "run_id", "run_attempt", "artifact_id", "github_token"}, "autodeploy-request")
    b.require(type(value["version"]) is int and value["version"] == 1 and t.matches(value["sha"], t.SHA), "autodeploy-request")
    for key in ("run_id", "run_attempt", "artifact_id"):
        b.require(t.matches(value[key], r"[1-9][0-9]{0,19}"), "autodeploy-identity")
    # GITHUB_TOKEN is opaque, not a fixed GitHub PAT prefix/alphabet. Accept the
    # Bearer credential grammar (RFC 6750 section 2.1), including base64url/JWT
    # punctuation and optional trailing padding, without accepting header data.
    token = value["github_token"]
    b.require(type(token) is str and 1 <= len(token) <= 4096
              and t.matches(token, r"[A-Za-z0-9._~+/-]+=*"), "autodeploy-token")
    return value


def policy(path=POLICY_PATH):
    raw = t.read_file(path, private=True)
    value = t.strict_json(raw)
    t.keys(value, {"version", "purpose", "enabled", "repository", "origin", "profile", "config_path",
        "ingress_directory", "bundles_directory", "initial_bundle", "initial_manifest_sha256", "registry_config",
        "postgres_image", "secret_files", "secret_sha256", "allow_new_migrations", "nginx_config", "nginx_sha256"}, "autodeploy-policy")
    b.require(type(value["version"]) is int and value["version"] == 1 and value["enabled"] is True
              and value["purpose"] == "citygo-main-standing-authorization" and value["repository"] == t.REPOSITORY,
              "autodeploy-disabled")
    b.require(value["profile"] in (s.PROFILE, s.ROUTERAI_PROFILE) and type(value["allow_new_migrations"]) is bool,
              "autodeploy-policy")
    p.hostname(value["origin"])
    for key in ("config_path", "ingress_directory", "bundles_directory", "initial_bundle", "registry_config", "nginx_config"):
        b.require(type(value[key]) is str and f.path_string(value[key]) == str(Path(value[key])), "autodeploy-path")
    t.keys(value["secret_files"], SECRET_ROLES, "autodeploy-secrets")
    t.keys(value["secret_sha256"], SECRET_ROLES, "autodeploy-secrets")
    b.require(len(set(value["secret_files"].values())) == 4, "autodeploy-secrets")
    for role in SECRET_ROLES:
        f.path_string(value["secret_files"][role])
        b.require(t.matches(value["secret_sha256"][role], t.HASH), "autodeploy-secret-pin")
    b.require(t.matches(value["initial_manifest_sha256"], t.HASH) and t.matches(value["nginx_sha256"], t.HASH)
              and t.matches(value["postgres_image"], r"postgres:17-alpine@" + t.DIGEST), "autodeploy-policy")
    return value, raw


def check_pins(value):
    for role, path in value["secret_files"].items():
        b.require(t.sha256(t.read_file(path)) == value["secret_sha256"][role], "autodeploy-secret-changed")
    b.require(t.sha256(t.read_file(value["nginx_config"])) == value["nginx_sha256"], "autodeploy-nginx-changed")
    s.api_secret(value["secret_files"]["api"], value["profile"])
    f.worker_secret(value["secret_files"]["worker"])
    m.secret_bytes(Path(value["secret_files"]["migration"]))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class GitHub:
    def __init__(self, token):
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def api(self, path, *, location=False):
        b.require(path.startswith("/repos/" + t.REPOSITORY + "/") or path == "/repos/" + t.REPOSITORY,
                  "github-path")
        req = urllib.request.Request("https://api.github.com" + path, headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
            "User-Agent": "CityGo-deployment", "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with self.opener.open(req, timeout=30) as response:
                b.require(not location and response.status == 200, "github-status")
                return t.strict_json(response.read(t.LIMIT + 1))
        except urllib.error.HTTPError as error:
            if location and error.code == 302:
                return error.headers.get("Location", "")
            raise b.BackupError("github-request-failed") from None

    def archive(self, artifact_id):
        url = self.api(f"/repos/{t.REPOSITORY}/actions/artifacts/{artifact_id}/zip", location=True)
        parsed = urllib.parse.urlsplit(url)
        # GitHub's signed artifact redirect gets NO Authorization header. Never
        # forward a token to an arbitrary redirect, proxy, HTTP URL or local host.
        host = parsed.hostname or ""
        b.require(parsed.scheme == "https" and parsed.port in (None, 443) and not parsed.username and not parsed.password
                  and (host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com")),
                  "github-artifact-host")
        with self.opener.open(urllib.request.Request(url), timeout=60) as response:
            raw = response.read(ARCHIVE_LIMIT + 1)
            b.require(response.status == 200 and 0 < len(raw) <= ARCHIVE_LIMIT, "github-artifact-size")
            return raw


def verify_github(value, read):
    root = "/repos/" + t.REPOSITORY
    repo = read(root)
    b.require(repo.get("id") == t.REPOSITORY_ID and repo.get("full_name") == t.REPOSITORY
              and repo.get("owner", {}).get("id") == t.ORGANIZATION_ID and repo.get("private") is True
              and repo.get("default_branch") == "main", "github-repository")
    b.require(read(root + "/git/ref/heads/main").get("object", {}).get("sha") == value["sha"], "main-moved")
    run = read(root + "/actions/runs/" + value["run_id"])
    b.require(str(run.get("id")) == value["run_id"] and str(run.get("run_attempt")) == value["run_attempt"]
              and run.get("head_sha") == value["sha"] and run.get("head_branch") == "main"
              and run.get("event") in ("push", "workflow_dispatch") and run.get("path") == WORKFLOW
              and run.get("repository", {}).get("id") == t.REPOSITORY_ID
              and run.get("head_repository", {}).get("id") == t.REPOSITORY_ID
              and run.get("status") == "in_progress" and run.get("conclusion") is None, "github-deploy-run")
    jobs = read(root + f'/actions/runs/{value["run_id"]}/attempts/{value["run_attempt"]}/jobs?per_page=100')
    b.require(type(jobs.get("total_count")) is int and jobs["total_count"] <= 100, "github-jobs")
    publish = [job for job in jobs.get("jobs", []) if job.get("name") == "publish-candidate"]
    b.require(len(publish) == 1 and publish[0].get("status") == "completed"
              and publish[0].get("conclusion") == "success", "github-publish-incomplete")
    checks = []
    for workflow in ("ci.yml", "container-smoke.yml"):
        runs = read(root + f'/actions/workflows/{workflow}/runs?head_sha={value["sha"]}&branch=main&event=push&per_page=100')
        b.require(type(runs.get("total_count")) is int and runs["total_count"] <= 100, "github-checks")
        matches = [r for r in runs.get("workflow_runs", []) if r.get("head_sha") == value["sha"]
                   and r.get("head_branch") == "main" and r.get("event") == "push"
                   and r.get("path") == ".github/workflows/" + workflow and r.get("repository", {}).get("id") == t.REPOSITORY_ID]
        matches.sort(key=lambda r: (r["id"], r["run_attempt"]), reverse=True)
        b.require(matches and matches[0].get("status") == "completed" and matches[0].get("conclusion") == "success", "github-check-not-green")
        checks.append({"workflow": workflow, "id": matches[0]["id"], "attempt": matches[0]["run_attempt"]})
    artifact = read(root + "/actions/artifacts/" + value["artifact_id"])
    identity = f'{value["sha"]}-{value["run_id"]}-{value["run_attempt"]}'
    link = artifact.get("workflow_run", {})
    b.require(str(artifact.get("id")) == value["artifact_id"] and artifact.get("expired") is False
              and artifact.get("name") == "citygo-candidate-" + identity and link.get("head_sha") == value["sha"]
              and str(link.get("id")) == value["run_id"] and link.get("repository_id") == t.REPOSITORY_ID
              and t.matches(artifact.get("digest"), t.DIGEST)
              and type(artifact.get("size_in_bytes")) is int and 0 < artifact["size_in_bytes"] <= ARCHIVE_LIMIT,
              "github-artifact-binding")
    return artifact, checks


def unpack(raw, artifact, value, checks):
    b.require(len(raw) == artifact["size_in_bytes"] and "sha256:" + t.sha256(raw) == artifact["digest"], "artifact-digest")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        b.require(0 < len(entries) <= 256 and len({i.filename for i in entries}) == len(entries)
                  and sum(i.file_size for i in entries) <= ARCHIVE_LIMIT, "artifact-tree")
        files = {}
        for entry in entries:
            b.require(not entry.is_dir() and entry.filename in t.FILES | {"release.json"}
                      and entry.file_size <= t.LIMIT and not entry.flag_bits & 1
                      and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG), "artifact-file")
            files[entry.filename] = archive.read(entry)
    b.require(set(files) == t.FILES | {"release.json"}, "artifact-files")
    manifest = t.manifest(files["release.json"])
    b.require(manifest["sourceSha"] == value["sha"] and manifest["run"]["id"] == value["run_id"]
              and manifest["run"]["attempt"] == value["run_attempt"]
              and sorted(manifest["run"]["checks"], key=lambda c: c["workflow"]) == sorted(checks, key=lambda c: c["workflow"]),
              "artifact-manifest-binding")
    for entry in manifest["runtimeFiles"]:
        b.require(t.sha256(files[entry["path"]]) == entry["sha256"], "artifact-file-digest")
    return manifest, files


def stage_bundle(directory, manifest, files):
    parent = b.protected(directory, directory=True)
    dest = parent / manifest["releaseId"]
    digest = t.sha256(files["release.json"])
    if not os.path.lexists(dest):
        with tempfile.TemporaryDirectory(prefix=".incoming-", dir=parent) as temporary:
            root = Path(temporary)
            for name, raw in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                f.write_new(path, raw)
            t.bundle(root, digest)
            os.rename(root, dest)
            b.sync_directory(parent)
    t.bundle(dest, digest)
    return dest


def current_bundle(value, config, state):
    pointer = state / "current.json"
    if os.path.lexists(pointer):
        record = t.strict_json(t.read_file(pointer, private=True))
        t.keys(record, {"source_sha", "bundle", "manifest_sha256"}, "autodeploy-current")
        directory, digest = Path(record["bundle"]), record["manifest_sha256"]
        b.require(directory.parent == Path(value["bundles_directory"]) and record["source_sha"] == config["source_sha"], "autodeploy-current")
    else:
        directory, digest = Path(value["initial_bundle"]), value["initial_manifest_sha256"]
    manifest = t.bundle(directory, digest, current=True)
    b.require(manifest["sourceSha"] == config["source_sha"] and manifest["bases"]["postgres"] == value["postgres_image"], "autodeploy-current")
    return directory, digest, manifest


def stage_capabilities(value, req, config, current, target, directory, host, store):
    """Machine-issued capabilities; audit explicitly names the standing policy."""
    old_dir, old_hash, old = current
    new = t.bundle(target, t.sha256(t.read_file(target / "release.json")))
    b.require(new["bases"]["postgres"] == value["postgres_image"] and new["migrations"][:len(old["migrations"])] == old["migrations"], "autodeploy-schema-history")
    b.require(value["allow_new_migrations"] or new["migrations"] == old["migrations"], "autodeploy-migration-not-authorized")
    local = {role: g.verify_image(store, old["images"][role], old["imageIds"][role], old["sourceSha"])["local_id"] for role in t.ROLES}
    pg = store.inspect("postgres@" + value["postgres_image"].split("@")[1])["Id"]
    images = {"api": local["api"], "web": local["web"], "worker": local["jobs"], "migrator": local["jobs"], "postgres": pg, "backup": pg}
    inventory = host.inventory()
    # Old completed one-shot jobs are inert, never selected for execution.
    retained = [p.evidence(v) for v in inventory if v.get("Labels", {}).get("com.docker.compose.oneoff") in ("True", "true")
                and v.get("State", {}).get("Status") == "exited"]
    t.retained_jobs(retained)
    p.validate_inventory(inventory, config["project"], images, initial=True, retained_jobs=retained)
    network, web_network = host.database_network(), host.web_network()
    now = int(time.time())
    times = {"approved_at": now, "expires_at": now + 3600}
    fingerprint = b.configuration_fingerprint(config)
    prep = {"version": 2, "purpose": "citygo-release-preparation", "repository_id": t.REPOSITORY_ID,
        "organization_id": t.ORGANIZATION_ID, "artifact_id": req["artifact_id"], "current_manifest_sha256": old_hash,
        "target_manifest_sha256": t.sha256(t.read_file(target / "release.json")), "target_release_id": new["releaseId"],
        "target_sha": req["sha"], "project": config["project"], "origin": value["origin"], "configuration_sha256": fingerprint,
        "current_images": images, "retained_jobs": retained, "allow_preparation": True, "allow_migration": False, **times}
    prep_path, migrate_path, start_path, finish_path = [directory / (name + ".json") for name in ("preparation", "migration", "startup", "finish")]
    f.write_new(prep_path, m.wire(prep))
    migration = {"version": 1, "purpose": "citygo-release-migration", "preparation_sha256": t.sha256(t.read_file(prep_path)),
        "target_manifest_sha256": prep["target_manifest_sha256"], "configuration_sha256": fingerprint, "project": config["project"],
        "origin": value["origin"], "network_id": network["id"], "allow_migration": True, "allow_start": False, "allow_traffic": False, **times}
    f.write_new(migrate_path, m.wire(migration))
    startup = {"version": 1 if value["profile"] == s.PROFILE else 2, "purpose": "citygo-release-start", "profile": value["profile"],
        "migration_approval_sha256": t.sha256(t.read_file(migrate_path)), "api_secret_sha256": value["secret_sha256"]["api"],
        "web_network_id": web_network["id"], "allow_start": True, "allow_traffic": False, **times}
    f.write_new(start_path, m.wire(startup))
    selection = t.Selection(old_dir, target, prep_path)
    verified = selection.verify(config, req["sha"], value["origin"], images)
    selected_images = g.verify(store, verified, images)
    paths = value["secret_files"]
    plan = f.generation(config, req["sha"], value["origin"], selected_images, paths["api"], paths["worker"], paths["backup"], value["profile"])
    finish = {"version": 1, "purpose": "citygo-release-finish", "profile": f.PROFILE,
        "startup_approval_sha256": t.sha256(t.read_file(start_path)), "config_path": value["config_path"],
        "config_file_sha256": t.sha256(t.read_file(value["config_path"], private=True)), "generation_sha256": plan["sha256"],
        "allow_finish": True, "allow_traffic": False, "allow_worker": False, "allow_restart": False, **times}
    f.write_new(finish_path, m.wire(finish))
    return {"version": 1, "config_path": value["config_path"], "origin": value["origin"], "target_sha": req["sha"],
        "ingress_directory": value["ingress_directory"], "current_bundle": str(old_dir), "target_bundle": str(target),
        "preparation_approval": str(prep_path), "migration_approval": str(migrate_path), "startup_approval": str(start_path),
        "finish_approval": str(finish_path), **{role + "_secret": paths[role] for role in SECRET_ROLES}}


def resume(value, source_sha, *, worker_was_open):
    config = b.load_config(value["config_path"])
    active = f.active_release(config)
    b.require(active["source_sha"] == source_sha, "autodeploy-not-committed")
    state = b.protected(config["state_dir"], directory=True)
    with b.lock(state), b.lock(state, "worker-admission.lock"):
        b.assert_current_config(config); b.assert_operation_idle(state); check_pins(value)
        host = s.Host(config, state, value["ingress_directory"], value["origin"])
        host.assert_closed(); host.probe()
        # Health/runtime was verified before the closed commit; pin those exact
        # processes again, then explicitly authorize persistent restart.
        identities = active["startup"]["apps"]
        b.require(set(identities) == {"api", "web"}, "autodeploy-start-record")
        ids = []
        for role, item in identities.items():
            detail = host.detail(item["id"])
            b.require(detail["Id"] == item["id"] and detail["Image"] == item["image"]
                      and detail["State"].get("StartedAt") == item["started_at"]
                      and detail["State"].get("Health", {}).get("Status") == "healthy"
                      and detail["State"].get("Running") is True and detail["RestartCount"] == 0, "autodeploy-process-changed")
            ids.append(item["id"])
        host.capture(["update", "--restart", "unless-stopped", *ids])
        host.probe()
        # No automatic enabling of a previously paused Worker.
        if worker_was_open:
            b.atomic_json(state / w.ADMISSION, w.admission(config))
        marker = Path(value["ingress_directory"]) / "traffic-open"
        f.write_new(marker, ("Automatic main release " + source_sha + "\n").encode(), public_script=True)
        try:
            connection = p._LoopbackTLS(p.hostname(value["origin"]), timeout=10)
            try:
                connection.request("GET", "/api/ready", headers={"Connection": "close"})
                response = connection.getresponse()
                s.health(response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(4097), ready=True)
            finally:
                connection.close()
        except BaseException:
            marker.unlink(); b.sync_directory(marker.parent)
            if os.path.lexists(state / w.ADMISSION):
                (state / w.ADMISSION).unlink(); b.sync_directory(state)
            raise


def apply(req, *, policy_path=POLICY_PATH):
    value, policy_raw = policy(policy_path)
    config = b.load_config(value["config_path"])
    root_state = b.protected(config["state_dir"], directory=True)
    state = root_state / "autodeploy"
    state.mkdir(mode=0o700, exist_ok=True)
    b.protected(state, directory=True)
    # The shared helper permits only its fixed lock names. This lock lives in
    # the autodeploy subdirectory, separate from the DB maintenance lock.
    with b.lock(state):
        b.require(not os.path.lexists(state / "pending.json"), "autodeploy-pending-inspect-required")
        b.assert_operation_idle(root_state)
        check_pins(value)
        client = GitHub(req["github_token"])
        event("verify-github")
        artifact, checks = verify_github(req, client.api)
        current = current_bundle(value, config, state)
        if config["source_sha"] == req["sha"]:
            b.require(os.path.lexists(Path(value["ingress_directory"]) / "traffic-open"), "autodeploy-current-closed")
            s.Host(config, state, value["ingress_directory"], value["origin"]).probe()
            event("already-current")
            return
        manifest, files = unpack(client.archive(req["artifact_id"]), artifact, req, checks)
        b.require(manifest["bases"]["postgres"] == value["postgres_image"], "autodeploy-postgres-changed")
        b.require(shutil.disk_usage(root_state).free >= 4 * 1024**3, "autodeploy-insufficient-disk")
        target = stage_bundle(value["bundles_directory"], manifest, files)
        # Read-only GHCR credential already held on this server. No login, token
        # rotation, pruning, DB restart or use of candidate-supplied commands.
        b.protected(value["registry_config"], directory=True)
        env = b.clean_env(state)
        event("pull-verified-images")
        for role in sorted(t.ROLES):
            b.run([b.executable("docker"), "--config", value["registry_config"], "pull", "--quiet", "--platform", "linux/amd64", manifest["images"][role]], env, timeout=600)
        b.require(shutil.disk_usage(root_state).free >= b.MIN_FREE, "autodeploy-insufficient-disk")
        # Last remote/policy check before any downtime. A newer push cannot
        # interrupt an already-started migration; it waits for this transaction.
        verify_github(req, client.api)
        b.require(policy(policy_path)[1] == policy_raw, "autodeploy-policy-changed")
        check_pins(value)
        audit = {"version": 1, "authorization": "standing-main-policy-not-human-review",
            "policy_sha256": t.sha256(policy_raw), "source_sha": req["sha"], "run_id": req["run_id"],
            "run_attempt": req["run_attempt"], "artifact_id": req["artifact_id"], "artifact_digest": artifact["digest"],
            "started_at": int(time.time()), "status": "preflight"}
        run_dir = state / manifest["releaseId"]
        run_dir.mkdir(mode=0o700)  # A failed attempt is never silently replayed.
        b.sync_directory(state)
        b.atomic_json(run_dir / "audit.json", audit)
        host = s.Host(config, state, value["ingress_directory"], value["origin"])
        command = stage_capabilities(value, req, config, current, target, run_dir, host, g.Store(state))
        ctl.preflight(command, verify_finish=True)
        f.write_new(run_dir / "request.json", m.wire(command))
        worker_open = os.path.lexists(root_state / w.ADMISSION)
        b.require(os.path.lexists(Path(value["ingress_directory"]) / "traffic-open"), "autodeploy-traffic-was-closed")
        b.atomic_json(state / "pending.json", {"source_sha": req["sha"], "run_directory": str(run_dir)})
        try:
            event("backup-migrate-start")
            ctl.apply(command)
            event("reopen-healthy-release")
            resume(value, req["sha"], worker_was_open=worker_open)
            b.atomic_json(state / "current.json", {"source_sha": req["sha"], "bundle": str(target),
                                                   "manifest_sha256": t.sha256(files["release.json"])})
            b.atomic_json(run_dir / "audit.json", {**audit, "status": "deployed", "finished_at": int(time.time())})
            (state / "pending.json").unlink(); b.sync_directory(state)
        except BaseException:
            # Never pretend a failed DDL is rollback-safe or retry it on the next
            # push. Preserve evidence, pending, old volumes/images and backups.
            # Also close after a failure between reopening and final fsync.
            host.close_ingress()
            w.pause(b.load_config(value["config_path"]))
            b.atomic_json(run_dir / "audit.json", {**audit, "status": "failed-inspect-required"})
            raise


def main():
    try:
        b.require(len(sys.argv) == 1 and sys.platform.startswith("linux") and sys.version_info >= (3, 11)
                  and os.geteuid() == 0, "autodeploy-root-linux-required")
        os.umask(0o077)
        def interrupted(_signal, _frame):
            raise b.BackupError("interrupted")
        signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
        signal.signal(signal.SIGALRM, interrupted); signal.alarm(40 * 60)
        value = request(sys.stdin.buffer.readline(16385))
        apply(value)
        print("CityGo deployed: " + value["sha"], flush=True)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, b.BackupError) else "unexpected-failure-details-hidden"
        event(code if re.fullmatch(r"[a-z0-9-]{1,80}", code) else "failure-details-hidden")
        return 1


if __name__ == "__main__":
    sys.exit(main())
