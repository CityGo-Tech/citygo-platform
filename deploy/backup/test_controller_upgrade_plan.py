"""Offline preparation only: synthetic metadata, source bytes and local output."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import backup as b
import target as t
import migrate as c
import start as s
import finish as f

spec = importlib.util.spec_from_file_location("citygo_controller_plan", Path(__file__).resolve().parents[1] / "controller_upgrade_plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def metadata(path, digest, *, mode="0600", extra=None):
    return {"bytes": 100, "gid": 0, "mode": mode, "path": path, "sha256": digest, "uid": 0, **(extra or {})}


class OfflinePlan(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="citygo-offline-controller-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.source = self.directory / "source"
        self.source.mkdir()
        self.source_bytes = {}
        for name in planner.CONTROLLER_FILES:
            raw = (b'"""Synthetic snapshot: AST inspection must never execute it."""\nraise RuntimeError("candidate-do-not-execute")\n'
                   if name.endswith(".py") else b"#!/bin/sh\nexit 0\n")
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            self.source_bytes[name] = raw
        migration_dir = self.source / "packages/db/migrations"
        migration_dir.mkdir(parents=True)
        self.migrations = []
        for number in range(1, 19):
            name, raw = f"{number:04d}_synthetic.sql", f"begin;\nselect {number};\ncommit;\n".encode()
            (migration_dir / name).write_bytes(raw)
            self.migrations.append({"name": name, "sha256": planner.sha256(raw)})
        (self.source / "deploy/postgres/grants.sql").write_bytes(b"begin;\ngrant select on users to citygo_api;\ncommit;\n")
        old_hashes = {name: planner.sha256(b"old-" + name.encode()) for name in planner.CONTROLLER_FILES}
        old_digest = planner.controller_digest(old_hashes)
        old_directory = "/opt/citygo/autodeploy-controller-" + old_digest[:16]
        fixed = "a" * 64
        secrets = {}
        for role, filename in (("api", "api.json"), ("migration", "migrate.json"), ("worker", "worker.json"), ("backup", "db_backup_password")):
            extra = {"matches_policy_pin": True, **({"keys": ["DATABASE_URL"]} if role != "backup" else {})}
            secrets[role] = metadata("/etc/citygo/secrets/" + filename, fixed, mode="0444", extra=extra)
        self.observed = {
            "bindings": {path: metadata(path, fixed, mode=planner.BINDING_MODES[path]) for path in planner.BINDINGS},
            "compose_file": "/var/lib/citygo-backup/release-" + "a" * 40 + "/compose.json",
            "config_fingerprint": fixed, "controller_directory": old_directory, "controller_sha256": old_digest,
            "current_manifest": {"bases": {"node": "node:24-bookworm-slim@sha256:" + fixed,
                "postgres": "postgres:17-alpine@sha256:" + fixed},
                "image_ids": {role: "sha256:" + fixed for role in ("api", "web", "jobs")},
                "images": {role: "ghcr.io/citygo-tech/citygo-platform-" + role + "@sha256:" + fixed for role in ("api", "web", "jobs")},
                "migrations": self.migrations[:12], "path": "/opt/citygo/autodeploy-bundles/" + "a" * 40 + "-123-1/release.json",
                "sha256": fixed, "source_sha": "a" * 40},
            "database": {"database": "citygo_pilot", "migrations": [{"name": item["name"], "checksum": item["sha256"]} for item in self.migrations[:12]],
                         "read_only": "on", "role": "citygo_backup", "server_version": "17.11"},
            "files": {name: metadata(old_directory + "/" + name, digest, mode="0644") for name, digest in old_hashes.items()},
            "initial_bundle": old_directory + "/initial-bundle", "initial_manifest_sha256": "b" * 64,
            "kind": "citygo-controller-observation", "locks": {"maintenance.lock": "free-at-observation", "worker-admission.lock": "free-at-observation"},
            "observed_at": "2026-10-18T14:09:43+00:00", "origin": "https://pilot.example.test",
            "pending": {"autodeploy/pending.json": False, "operation-pending.json": False},
            "policy_enabled": False, "policy_profile": "citygo-api-web-disabled-v1", "project": "citygo-pilot", "secrets": secrets,
            "source_sha": "a" * 40, "state_directory": "/var/lib/citygo-backup", "systemd": {}, "version": 1, "visudo_valid": True,
        }
        for unit in planner.UNITS:
            path = "/etc/systemd/system/" + unit
            timer = unit.endswith(".timer")
            self.observed["systemd"][unit] = {"ActiveState": "active" if timer else "inactive", "DropInPaths": "", "FragmentPath": path,
                "Result": "success", "SubState": "waiting" if timer else "dead", "files": [metadata(path, fixed, mode="0644")],
                "code_paths": [] if timer else ["/opt/citygo/backup-routine-" + "a" * 16 + "/routine.py"]}
        self.observation_file = self.directory / "observation.json"
        self.observation_file.write_bytes(planner.wire(self.observed))

    def build(self, value=None):
        return planner.build(self.source, planner.wire(self.observed if value is None else value), source_sha="b" * 40)

    def test_deterministic_exact_archive_never_executes_or_copies_extra_source_files(self):
        (self.source / ".env").write_text("DO_NOT_COPY=synthetic-not-a-real-secret", encoding="utf-8")
        with patch("os.system", side_effect=AssertionError("no shell")):
            first, second = self.build(), self.build()
        self.assertEqual(first, second)
        with planner.tarfile.open(fileobj=io.BytesIO(first["controller-candidate.tar"])) as tar:
            self.assertEqual(tar.getnames(), list(planner.CONTROLLER_FILES))
            for member in tar:
                self.assertTrue(member.isfile()); self.assertEqual(member.mtime, 0)
                self.assertEqual((member.uid, member.gid, member.mode), (0, 0, 0o644))
                self.assertEqual(tar.extractfile(member).read(), self.source_bytes[member.name])
        plan = json.loads(first["plan.json"])
        self.assertEqual(plan["kind"], "citygo-closed-release-draft"); self.assertIs(plan["ready"], False)
        self.assertEqual(plan["authorizes"], planner.AUTHORIZES)
        self.assertEqual(plan["proposed_controller"]["sha256"], planner.sha256(json.dumps(
            {name: planner.sha256(raw) for name, raw in self.source_bytes.items()}, sort_keys=True).encode()))
        self.assertEqual(plan["current"]["manifest"]["sha256"], self.observed["current_manifest"]["sha256"])
        self.assertNotEqual(plan["current"]["manifest"]["sha256"], self.observed["initial_manifest_sha256"])
        self.assertEqual(plan["source_label"]["provenance"], "operator-provided-not-git-attested")
        self.assertIsNone(plan["target"]["source_sha"])
        self.assertIsNone(plan["profile"]["api_secret_sha256"])
        self.assertNotIn(b"DO_NOT_COPY", b"".join(first.values()))

    def test_every_draft_is_rejected_even_after_flags_and_times_are_changed(self):
        outputs = self.build()
        now = int(time.time())
        parsers = {"preparation": (t.approval, "allow_preparation"), "migration": (c.approval, "allow_migration"),
                   "startup": (s.approval, "allow_start"), "finish": (f.approval, "allow_finish")}
        for name, (parser, flag) in parsers.items():
            value = json.loads(outputs[name + ".draft.json"])
            self.assertIs(value["draft"], True)
            self.assertTrue(all(setting is False for key, setting in value.items() if key.startswith("allow_")))
            with self.subTest(name=name), self.assertRaises(b.BackupError): parser(planner.wire(value), now)
            value.update(approved_at=now - 1, expires_at=now + 1000)
            value[flag] = True
            for key, item in value.items():
                if item is not None: continue
                value[key] = ({role: "sha256:" + "a" * 64 for role in t.SERVICES} if key == "current_images" else
                              [] if key == "retained_jobs" else "123" if key == "artifact_id" else
                              "b" * 40 + "-123-1" if key == "target_release_id" else
                              "b" * 40 if key == "target_sha" else "a" * 64)
            with self.subTest(active_flags=name), self.assertRaises(b.BackupError): parser(planner.wire(value), now)
            # The draft marker is an intentional extra field, not accepted by
            # any stage parser even when all other values have valid shapes.
            del value["draft"]
            self.assertEqual(parser(planner.wire(value), now), value)

    def test_fresh_free_observation_still_cannot_approve_server_or_payments(self):
        plan = json.loads(self.build()["plan.json"])
        self.assertIn("target-main-publication-not-verified", plan["blockers"])
        self.assertIn("controller-not-installed-or-authorized", plan["blockers"])
        self.assertIn("new-citygo-10x-api-secret-not-prepared", plan["blockers"])
        self.assertNotIn("live-yookassa-adapter-not-implemented", plan["blockers"])
        self.assertIn("live-yookassa-adapter-not-implemented", plan["pilot_opening_gaps"])
        self.assertIs(plan["payment_status"]["blocks_closed_release_with_payments_disabled"], False)
        busy = copy.deepcopy(self.observed)
        busy["locks"]["maintenance.lock"] = "busy"
        busy["pending"]["operation-pending.json"] = True
        busy["systemd"]["citygo-backup-routine.service"]["ActiveState"] = "activating"
        plan = json.loads(self.build(busy)["plan.json"])
        self.assertIn("observed-lock-busy:maintenance.lock", plan["blockers"])
        self.assertIn("observed-pending:operation-pending.json", plan["blockers"])
        self.assertIs(plan["ready"], False)

    def test_punycode_origin_is_supported_without_accepting_urls_as_commands(self):
        value = copy.deepcopy(self.observed)
        value["origin"] = "https://pilot.xn--c1ajazlh.xn--p1ai"
        self.assertEqual(json.loads(self.build(value)["plan.json"])["origin"], value["origin"])
        for origin in ("https://name:password@pilot.example.test", "https://pilot.example.test:443", "https://-bad.example.test",
                       "https://bad-.example.test", "https://pilot.example.test?q=value", "http://pilot.example.test"):
            value["origin"] = origin
            with self.subTest(origin=origin), self.assertRaises(planner.PlanError): self.build(value)

    def test_observation_rejects_duplicate_keys_unknown_fields_and_invalid_identity(self):
        with self.assertRaisesRegex(planner.PlanError, "duplicate-json-key"):
            planner.observation(b'{"version":1,"version":1}')
        for key, item in (("version", True), ("kind", "other"), ("source_sha", "main"), ("project", "other"),
                          ("origin", "https://pilot.example.test/path"), ("policy_enabled", True),
                          ("controller_sha256", "b" * 64), ("visudo_valid", False), ("extra", "secret-value")):
            value = copy.deepcopy(self.observed); value[key] = item
            with self.subTest(key=key), self.assertRaises(planner.PlanError): self.build(value)
        for section, key, item in (("database", "role", "postgres"), ("database", "read_only", "off"),
                                   ("database", "server_version", "18.0"), ("current_manifest", "source_sha", "b" * 40)):
            value = copy.deepcopy(self.observed); value[section][key] = item
            with self.subTest(section=section, key=key), self.assertRaises(planner.PlanError): self.build(value)
        for patch_value in ({"keys": ["DATABASE_URL", "ROUTERAI_API_KEY"]}, {"matches_policy_pin": False},
                            {"value": "never-accept-actual-secret"}, {"mode": "0666"}):
            value = copy.deepcopy(self.observed); value["secrets"]["api"].update(patch_value)
            with self.assertRaises(planner.PlanError): self.build(value)

    def test_role_metadata_requires_exact_readable_modes_not_just_no_write_bits(self):
        for section, name, expected in (("files", planner.CONTROLLER_FILES[0], "0644"),
                                        ("bindings", "/etc/sudoers.d/citygo-deploy", "0440"),
                                        ("bindings", "/var/lib/citygo-deploy/.ssh/authorized_keys", "0644"),
                                        ("secrets", "api", "0444")):
            for mode in {"0000", "0400", "0600", "0644", "0440", "0444", "0666"} - {expected}:
                value = copy.deepcopy(self.observed); value[section][name]["mode"] = mode
                with self.subTest(section=section, mode=mode), self.assertRaisesRegex(planner.PlanError, "observation-metadata"):
                    self.build(value)

    def test_prefix_drift_and_controller_syntax_stop_before_any_output(self):
        path = self.source / "packages/db/migrations" / self.migrations[0]["name"]
        path.write_bytes(b"begin;\nselect 999;\ncommit;\n")
        with self.assertRaisesRegex(planner.PlanError, "source-database-prefix-drift"):
            self.build()
        self.assertFalse((self.directory / "output").exists())
        path.write_bytes(b"begin;\nselect 1;\ncommit;\n")
        (self.source / planner.CONTROLLER_FILES[0]).write_bytes(b"def invalid(:\n")
        with self.assertRaisesRegex(planner.PlanError, "controller-syntax"): self.build()

    def test_archive_uses_the_once_read_snapshot_not_a_later_source_read(self):
        original = planner.archive
        def change_then_archive(files):
            (self.source / planner.CONTROLLER_FILES[0]).write_bytes(b"# later source bytes\n")
            return original(files)
        with patch.object(planner, "archive", side_effect=change_then_archive): outputs = self.build()
        with planner.tarfile.open(fileobj=io.BytesIO(outputs["controller-candidate.tar"])) as tar:
            self.assertEqual(tar.extractfile(planner.CONTROLLER_FILES[0]).read(), self.source_bytes[planner.CONTROLLER_FILES[0]])

    @unittest.skipUnless(os.name == "posix", "Anchored output requires POSIX dir_fd")
    def test_new_output_only_and_no_existing_files_are_overwritten(self):
        output = self.directory / "output"
        # A root-run test harness may exercise the filesystem implementation,
        # but real CLI/create_plan access is separately tested to reject root.
        with patch.object(planner, "require_offline_user"):
            result = planner.create_plan(self.source, self.observation_file, output, source_sha="b" * 40)
        self.assertIs(result["ready"], False)
        before = {path.name: path.read_bytes() for path in output.iterdir()}
        self.assertEqual(len(before), 6)
        with patch.object(planner, "require_offline_user"), self.assertRaisesRegex(planner.PlanError, "output-already-exists"):
            planner.create_plan(self.source, self.observation_file, output)
        self.assertEqual(before, {path.name: path.read_bytes() for path in output.iterdir()})

    @unittest.skipUnless(os.name == "posix", "Anchored output requires POSIX dir_fd")
    def test_parent_replaced_during_build_never_redirects_output(self):
        parent, elsewhere = self.directory / "selected-parent", self.directory / "elsewhere"
        parent.mkdir(); elsewhere.mkdir()
        def swap(*_, **__):
            parent.rename(self.directory / "original-parent")
            parent.symlink_to(elsewhere, target_is_directory=True)
            return {"plan.json": b'{"synthetic":true}\n'}
        with patch.object(planner, "require_offline_user"), patch.object(planner, "build", side_effect=swap), \
             self.assertRaisesRegex(planner.PlanError, "output-parent-changed"):
            planner.create_plan(self.source, self.observation_file, parent / "output")
        self.assertFalse((elsewhere / "output").exists())
        self.assertFalse((self.directory / "original-parent/output").exists())

    @unittest.skipUnless(os.name == "posix", "Anchored output requires POSIX dir_fd")
    def test_output_replaced_after_final_check_writes_only_to_held_directory_fd(self):
        parent, elsewhere = self.directory / "selected-parent", self.directory / "elsewhere"
        parent.mkdir(); elsewhere.mkdir()
        original_open = os.open
        def swap(name, flags, *args, **kwargs):
            if name == "plan.json":
                (parent / "output").rename(parent / "original-output")
                (parent / "output").symlink_to(elsewhere, target_is_directory=True)
            return original_open(name, flags, *args, **kwargs)
        with patch.object(planner, "require_offline_user"), patch.object(planner, "build", return_value={"plan.json": b'{"synthetic":true}\n'}), \
             patch.object(planner.os, "open", side_effect=swap), self.assertRaisesRegex(planner.PlanError, "output-directory-changed"):
            planner.create_plan(self.source, self.observation_file, parent / "output")
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertTrue((parent / "original-output/plan.json").is_file())

    def test_root_and_nonposix_writers_are_rejected_before_any_input_io(self):
        with patch.object(planner.os, "name", "posix"), patch.object(planner.os, "geteuid", return_value=0, create=True), \
             patch.object(planner, "read_once") as read, self.assertRaisesRegex(planner.PlanError, "posix-nonroot"):
            planner.create_plan("unused", "unused", "unused")
        read.assert_not_called()
        with patch.object(planner.os, "name", "nt"), patch.object(planner, "read_once") as read, \
             self.assertRaisesRegex(planner.PlanError, "posix-nonroot"):
            planner.create_plan("unused", "unused", "unused")
        read.assert_not_called()
        with patch.object(planner.os, "name", "posix"), patch.object(planner.os, "geteuid", return_value=0, create=True), \
             patch.object(planner, "create_plan") as create, redirect_stderr(io.StringIO()):
            self.assertEqual(planner.main(["--source", "unused", "--observation", "unused", "--output", "unused"]), 1)
        create.assert_not_called()

    def test_file_hardlinks_are_rejected(self):
        target = self.source / planner.CONTROLLER_FILES[0]
        try: os.link(target, self.directory / "hardlinked-payload.py")
        except (OSError, NotImplementedError): self.skipTest("Local OS cannot create the synthetic hardlink")
        with self.assertRaisesRegex(planner.PlanError, "regular-single-link-required"): self.build()

    def test_symlinked_ancestors_are_rejected(self):
        link = self.directory / "source-link"
        try: link.symlink_to(self.source, target_is_directory=True)
        except (OSError, NotImplementedError): self.skipTest("Local OS cannot create the synthetic symlink")
        with self.assertRaisesRegex(planner.PlanError, "linked-path"):
            planner.build(link, planner.wire(self.observed))

    def test_cli_redacts_untrusted_arguments_and_file_exceptions(self):
        error = io.StringIO()
        with redirect_stderr(error), self.assertRaises(SystemExit):
            planner.main(["--source", "unused", "--observation", "unused", "--output", "unused", "--secret", "hidden-value"])
        self.assertNotIn("hidden-value", error.getvalue())
        error = io.StringIO()
        with patch.object(planner, "create_plan", side_effect=OSError("hidden-value")), redirect_stderr(error), redirect_stdout(io.StringIO()):
            self.assertEqual(planner.main(["--source", "unused", "--observation", "unused", "--output", "unused"]), 1)
        self.assertNotIn("hidden-value", error.getvalue())


if __name__ == "__main__": unittest.main()
