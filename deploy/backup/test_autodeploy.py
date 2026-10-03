"""Synthetic GitHub/SSH policy and real Linux controller filesystem integration."""
import copy
import io
import sys
import unittest
from unittest.mock import patch
import zipfile

import autodeploy as a
import backup as b
import control as ctl
import finish as f
import target as t
import test_finish as fixture
from test_prepare import ORIGIN
from test_target import encoded, manifest_fixture


def request():
    return {"version": 1, "sha": "b" * 40, "run_id": "123", "run_attempt": "1", "artifact_id": "456", "github_token": "synthetic_secret"}


def archive():
    manifest = manifest_fixture()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for entry in manifest["runtimeFiles"]:
            bundle.writestr(entry["path"], b"# synthetic fixture, never executed\n")
        bundle.writestr("release.json", encoded(manifest))
    return output.getvalue(), manifest


def responses():
    req = request()
    raw, manifest = archive()
    root = "/repos/" + t.REPOSITORY
    values = {
        root: {"id": t.REPOSITORY_ID, "owner": {"id": t.ORGANIZATION_ID}, "full_name": t.REPOSITORY, "private": True, "default_branch": "main"},
        root + "/git/ref/heads/main": {"object": {"sha": req["sha"]}},
        root + "/actions/runs/123": {"id": 123, "run_attempt": 1, "head_sha": req["sha"], "head_branch": "main", "event": "push",
            "path": a.WORKFLOW, "repository": {"id": t.REPOSITORY_ID}, "head_repository": {"id": t.REPOSITORY_ID}, "status": "in_progress", "conclusion": None},
        root + "/actions/runs/123/attempts/1/jobs?per_page=100": {"total_count": 2, "jobs": [{"name": "publish-candidate", "status": "completed", "conclusion": "success"}]},
        root + "/actions/artifacts/456": {"id": 456, "expired": False, "name": "citygo-candidate-" + manifest["releaseId"],
            "workflow_run": {"head_sha": req["sha"], "id": 123, "repository_id": t.REPOSITORY_ID}, "digest": "sha256:" + t.sha256(raw), "size_in_bytes": len(raw)},
    }
    for check in manifest["run"]["checks"]:
        name = check["workflow"]
        values[root + f'/actions/workflows/{name}/runs?head_sha={req["sha"]}&branch=main&event=push&per_page=100'] = {
            "total_count": 1, "workflow_runs": [{"id": check["id"], "run_attempt": check["attempt"], "head_sha": req["sha"],
                "head_branch": "main", "event": "push", "path": ".github/workflows/" + name,
                "repository": {"id": t.REPOSITORY_ID}, "status": "completed", "conclusion": "success"}]}
    return values


class Validation(unittest.TestCase):
    def test_request_is_bounded_and_not_a_command_transport(self):
        self.assertEqual(a.request(encoded(request())), request())
        for change in ({"sha": "main"}, {"run_id": "123;whoami"}, {"artifact_id": "../secret"},
                       {"github_token": "secret\nheader"}, {"version": True}, {"command": "id"}, {"config_path": "/etc/passwd"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): a.request(encoded({**request(), **change}))
        with self.assertRaises(b.BackupError): a.request(b'{"version":1,"version":1}')

    def test_evidence_requires_main_latest_checks_and_completed_publisher(self):
        values = responses()
        artifact, checks = a.verify_github(request(), values.__getitem__)
        raw, manifest = archive()
        self.assertEqual(a.unpack(raw, artifact, request(), checks)[0], manifest)
        root = "/repos/" + t.REPOSITORY
        changes = [(root, {"private": False}), (root, {"id": 1}),
            (root + "/git/ref/heads/main", {"object": {"sha": "a" * 40}}),
            (root + "/actions/runs/123", {"event": "pull_request"}),
            (root + "/actions/runs/123", {"head_repository": {"id": 1}}),
            (root + "/actions/runs/123", {"run_attempt": 2}),
            (root + "/actions/runs/123", {"path": ".github/workflows/attacker.yml"}),
            (root + "/actions/runs/123/attempts/1/jobs?per_page=100", {"jobs": []}),
            (root + "/actions/artifacts/456", {"expired": True}),
            (root + "/actions/artifacts/456", {"name": "wrong"}),
            (root + "/actions/artifacts/456", {"digest": ""})]
        for path, change in changes:
            bad = copy.deepcopy(values); bad[path].update(change)
            with self.subTest(path=path, change=change), self.assertRaises(b.BackupError): a.verify_github(request(), bad.__getitem__)
        for path in [p for p in values if "/actions/workflows/" in p]:
            bad = copy.deepcopy(values)
            bad[path]["workflow_runs"].append({**bad[path]["workflow_runs"][0], "id": 999, "conclusion": "failure"})
            bad[path]["total_count"] = 2
            with self.assertRaises(b.BackupError): a.verify_github(request(), bad.__getitem__)

    def test_archive_never_executes_or_extracts_unknown_paths(self):
        values = responses(); artifact, checks = a.verify_github(request(), values.__getitem__)
        raw, _ = archive()
        with self.assertRaises(b.BackupError): a.unpack(raw + b"bad", artifact, request(), checks)
        for name in ("../escape", "/etc/shadow", "deploy/backup/hook.py", "release.json"):
            buffer = io.BytesIO(raw)
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with zipfile.ZipFile(buffer, "a") as bundle: bundle.writestr(name, b"malicious")
            bad = buffer.getvalue()
            metadata = {**artifact, "size_in_bytes": len(bad), "digest": "sha256:" + t.sha256(bad)}
            with self.subTest(name=name), self.assertRaises(b.BackupError): a.unpack(bad, metadata, request(), checks)

    def test_download_does_not_send_token_to_redirect(self):
        client = a.GitHub("synthetic_secret")
        for url in ("http://example.blob.core.windows.net/a", "https://api.github.com/a", "https://evil.test/a",
                    "https://name:password@a.blob.core.windows.net/a", "https://a.blob.core.windows.net:8000/a"):
            with patch.object(client, "api", return_value=url), patch.object(client.opener, "open") as opened, self.assertRaises(b.BackupError):
                client.archive("456")
            opened.assert_not_called()
        with patch.object(client, "api", return_value="https://a.blob.core.windows.net/a?signature=x"), patch.object(client.opener, "open") as opened:
            opened.return_value.__enter__.return_value.status = 200
            opened.return_value.__enter__.return_value.read.return_value = b"zip"
            self.assertEqual(client.archive("456"), b"zip")
            self.assertEqual(opened.call_args.args[0].headers, {})


@unittest.skipUnless(sys.platform.startswith("linux"), "protected Linux deployment files")
class Capabilities(unittest.TestCase):
    def setUp(self):
        fixture.Cutover.setUp(self)
        old = t.manifest(t.read_file(self.selection.current_directory / "release.json"), current=True)
        self.policy = {"origin": ORIGIN, "config_path": str(self.config_path), "profile": a.s.PROFILE,
            "ingress_directory": str(self.ingress), "postgres_image": old["bases"]["postgres"], "allow_new_migrations": True,
            "secret_files": {"api": str(self.api), "migration": str(self.secret), "worker": str(self.worker), "backup": str(self.password)},
            "secret_sha256": {"api": t.sha256(self.api.read_bytes())}}
        self.current = (self.selection.current_directory, t.sha256(t.read_file(self.selection.current_directory / "release.json")), old)
        self.auto_directory = self.directory / "auto"; self.auto_directory.mkdir(mode=0o700)

    def capabilities(self):
        return a.stage_capabilities(self.policy, request(), self.config, self.current, self.selection.target_directory,
                                    self.auto_directory, self.host, self.image_store)

    def test_automated_capabilities_pass_existing_independent_binding_checks(self):
        command = self.capabilities()
        self.assertEqual(set(command), ctl.FIELDS)
        result = ctl.preflight(command, verify_finish=True, image_store_factory=lambda _: self.image_store)
        self.assertEqual(result["profile"], a.s.PROFILE)
        self.assertEqual(result["status"], "verified-not-deployed")
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.host.events, [])

    def test_no_automatic_database_upgrade_or_unapproved_migrations(self):
        for changes in ({"postgres_image": "postgres:17-alpine@sha256:" + "9" * 64}, {"allow_new_migrations": False}):
            with patch.dict(self.policy, changes), self.assertRaises(b.BackupError): self.capabilities()
        self.assertEqual(list(self.auto_directory.iterdir()), [])

    def test_staged_bundle_is_exact_and_never_overwrites_existing(self):
        raw, _ = archive()
        artifact, checks = a.verify_github(request(), responses().__getitem__)
        manifest, files = a.unpack(raw, artifact, request(), checks)
        directory = a.stage_bundle(self.auto_directory, manifest, files)
        self.assertEqual(t.bundle(directory, t.sha256(files["release.json"])), manifest)
        self.assertEqual(a.stage_bundle(self.auto_directory, manifest, files), directory)
        path = directory / "release.json"; path.write_bytes(b"bad")
        with self.assertRaises(b.BackupError): a.stage_bundle(self.auto_directory, manifest, files)

    def closed_release(self):
        command = self.capabilities()
        config, images, auth = ctl.inputs(command)
        result = f.finish(config, command["target_sha"], ORIGIN, self.ingress, images, self.secret, self.api, self.worker, self.password,
            allow_stop=True, allow_upload=True, allow_migration=True, allow_start=True, allow_finish=True,
            image_store_factory=lambda _: self.image_store, host_factory=lambda *_: self.host,
            storage_factory=lambda *_: self.store, encryptor=self.encrypt, min_free=0, transport_factory=lambda *_: self.transport, **auth)
        return result

    def test_full_closed_release_uses_existing_backup_migration_and_health_sequence(self):
        result = self.closed_release()
        self.assertEqual(result["finish"]["source_sha"], "b" * 40)
        self.assertTrue(self.host.closed)
        self.assertFalse(self.pending.exists())
        self.assertTrue(result["startup"]["health"]["ready"])

    def test_reopen_requires_committed_exact_processes_and_keeps_worker_paused(self):
        self.closed_release()
        with patch.object(a, "check_pins"), patch.object(a.s, "Host", return_value=self.host), \
             patch.object(self.host, "capture", create=True) as capture, patch.object(a.p, "_LoopbackTLS") as tls:
            response = tls.return_value.getresponse.return_value
            response.status = 200; response.getheaders.return_value = [("content-type", "application/json")]
            response.read.return_value = b'{"status":"ok"}'
            a.resume(self.policy, "b" * 40, worker_was_open=False)
            self.assertTrue((self.ingress / "traffic-open").is_file())
            self.assertFalse((self.state / a.w.ADMISSION).exists())
            self.assertEqual(capture.call_args.args[0][:3], ["update", "--restart", "unless-stopped"])

    def test_bad_https_after_reopen_closes_traffic_and_worker_again(self):
        self.closed_release()
        with patch.object(a, "check_pins"), patch.object(a.s, "Host", return_value=self.host), \
             patch.object(self.host, "capture", create=True), patch.object(a.p, "_LoopbackTLS") as tls:
            tls.return_value.getresponse.return_value.status = 503
            tls.return_value.getresponse.return_value.getheaders.return_value = []
            tls.return_value.getresponse.return_value.read.return_value = b"unhealthy"
            with self.assertRaises(b.BackupError): a.resume(self.policy, "b" * 40, worker_was_open=True)
            self.assertFalse((self.ingress / "traffic-open").exists())
            self.assertFalse((self.state / a.w.ADMISSION).exists())

    def test_resume_cannot_admit_a_different_release_or_process(self):
        self.closed_release()
        with self.assertRaises(b.BackupError): a.resume(self.policy, "c" * 40, worker_was_open=False)
        with patch.object(a, "check_pins"), patch.object(a.s, "Host", return_value=self.host), \
             patch.object(self.host, "detail", return_value={"Id": "wrong"}), patch.object(self.host, "capture", create=True) as capture:
            with self.assertRaises(b.BackupError): a.resume(self.policy, "b" * 40, worker_was_open=False)
            capture.assert_not_called()
            self.assertFalse((self.ingress / "traffic-open").exists())


if __name__ == "__main__": unittest.main()
