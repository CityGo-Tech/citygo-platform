"""Only synthetic requests; CLI never receives injectable transports from JSON."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import backup as b
import control as ctl
import test_finish as fixture
import target as t
from test_target import encoded
from test_prepare import ORIGIN


def synthetic_request(case):
    value = {"version": 1, "config_path": str(case.config_path), "target_sha": "b" * 40, "origin": ORIGIN,
        "ingress_directory": str(case.ingress), "current_bundle": str(case.selection.current_directory),
        "target_bundle": str(case.selection.target_directory), "preparation_approval": str(case.selection.approval_file),
        "migration_approval": str(case.authorization.path), "startup_approval": str(case.start_approval.path),
        "finish_approval": str(case.finish_approval.path), "migration_secret": str(case.secret),
        "api_secret": str(case.api), "worker_secret": str(case.worker), "backup_secret": str(case.password)}
    path = case.directory / "operator-request.json"
    path.write_bytes(encoded(value)); path.chmod(0o600)
    return path


class Validation(unittest.TestCase):
    def test_apply_and_recovery_require_exact_explicit_flags_before_io(self):
        for argv in (["apply", "--request", "/unused"],
                     ["apply", "--request", "/unused", "--allow-finish"],
                     ["verify", "--request", "/unused", "--allow-start"],
                     ["recover-commit", "--request", "/unused", "--allow-settle"],
                     ["recover-commit", "--request", "/unused", "--recovery-approval", "/unused"]):
            with self.subTest(argv=argv), patch.object(ctl, "request") as read, redirect_stderr(io.StringIO()):
                self.assertEqual(ctl.main(argv), 1)
                read.assert_not_called()

    def test_unknown_arguments_are_not_echoed(self):
        error = io.StringIO()
        with redirect_stderr(error), self.assertRaises(SystemExit) as exited:
            ctl.main(["verify", "--request", "/unused", "--key", "synthetic-secret-do-not-echo"])
        self.assertEqual(exited.exception.code, 2)
        self.assertNotIn("synthetic-secret", error.getvalue())

    def test_help_and_readonly_commands_never_apply(self):
        output = io.StringIO()
        with redirect_stdout(output), patch.object(ctl, "apply") as apply, self.assertRaises(SystemExit) as exited:
            ctl.main(["--help"])
        self.assertEqual(exited.exception.code, 0); apply.assert_not_called()

    def test_documented_python_flags_import_local_modules(self):
        result = subprocess.run([sys.executable, "-E", "-s", str(Path(ctl.__file__)), "--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn("recover-commit", result.stdout)

    def test_rejects_request_hooks_and_noncanonical_paths(self):
        base = {"version": 1, "target_sha": "b" * 40, "origin": ORIGIN, **{key: "/safe/" + key for key in ctl.PATHS}}
        for change in ({"command": "ignored"}, {"image_store_factory": "danger"}, {"target_sha": "main"},
                       {"version": True}, {"config_path": "relative"}, {"config_path": "/tmp/$KEY"},
                       {"config_path": "/tmp/./config"}, {"config_path": "/tmp//config"},
                       {"api_secret": base["worker_secret"]}):
            with self.subTest(change=change), patch.object(t, "read_file", return_value=encoded({**base, **change})), self.assertRaises(b.BackupError):
                ctl.request("/safe/operator-request.json")


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected operator requests")
class Operator(unittest.TestCase):
    def setUp(self):
        setup = fixture.RouterAiCutover if getattr(self, "routerai_profile", False) else fixture.Cutover
        setup.setUp(self)
        self.request = synthetic_request(self)

    def test_plan_without_finish_file_is_not_an_approval_and_verify_is_readonly(self):
        value, _raw = ctl.request(self.request)
        saved = self.finish_approval.path.read_bytes()
        self.finish_approval.path.unlink()
        result = ctl.preflight(value, image_store_factory=lambda _: self.image_store)
        self.assertEqual(result["status"], "planned-not-approved")
        self.assertEqual(result["generation_sha256"], self.plan["sha256"])
        self.assertEqual(result["profile"], ctl.s.ROUTERAI_PROFILE if getattr(self, "routerai_profile", False) else ctl.s.PROFILE)
        self.assertFalse(result["runtime_checked"])
        with self.assertRaises(OSError): ctl.preflight(value, verify_finish=True, image_store_factory=lambda _: self.image_store)
        self.finish_approval.path.write_bytes(saved); self.finish_approval.path.chmod(0o600)
        self.assertEqual(ctl.preflight(value, verify_finish=True, image_store_factory=lambda _: self.image_store)["status"], "verified-not-deployed")
        self.assertFalse(self.pending.exists()); self.assertEqual(self.host.events, [])
        self.assertEqual(self.store.calls, []); self.assertEqual(self.transport.events, [])
        self.assertFalse(self.plan["directory"].exists())

    def test_verify_rechecks_finish_deadline_after_all_last_reads(self):
        value, _raw = ctl.request(self.request)
        now = ctl.s.time.time()
        clock = [now]
        armed = [False]
        original = t.read_file
        verify = ctl.f.Approval.verify
        def verified(*args, **kwargs):
            result = verify(*args, **kwargs)
            armed[0] = True
            return result
        def read(path, **kwargs):
            raw = original(path, **kwargs)
            if armed[0] and Path(path) == self.finish_approval.path:
                clock[0] = now + 7200
            return raw
        with patch.object(t, "read_file", side_effect=read), patch.object(ctl.f.Approval, "verify", verified), \
             patch.object(ctl.s.time, "time", side_effect=lambda: clock[0]), self.assertRaises(b.BackupError):
            ctl.preflight(value, verify_finish=True, image_store_factory=lambda _: self.image_store)
        self.assertFalse(self.pending.exists()); self.assertEqual(self.host.events, [])

    def test_apply_passes_only_fixed_authorities_and_does_not_return_raw_proofs(self):
        value, _raw = ctl.request(self.request)
        result = {"finish": {"source_sha": "b" * 40, "operation_id": "1" * 32}, "ignored": "synthetic-private"}
        with patch.object(ctl.f, "finish", return_value=result) as finish:
            report = ctl.apply(value)
        self.assertNotIn("synthetic-private", json.dumps(report))
        for key in ("allow_stop", "allow_upload", "allow_migration", "allow_start", "allow_finish"):
            self.assertIs(finish.call_args.kwargs[key], True)
        self.assertEqual(set(finish.call_args.kwargs) - {"allow_stop", "allow_upload", "allow_migration", "allow_start", "allow_finish"},
                         {"selection", "authorization", "startup_authorization", "finish_authorization"})

    def test_main_failure_suppresses_arbitrary_secret_errors(self):
        error = io.StringIO()
        with patch.object(ctl.sys, "version_info", (3, 12)), patch.object(ctl.signal, "signal"), patch.object(ctl.os, "umask"), redirect_stderr(error), \
             patch.object(ctl, "request", side_effect=OSError("synthetic-private-key")):
            self.assertEqual(ctl.main(["verify", "--request", str(self.request)]), 1)
        self.assertNotIn("synthetic-private-key", error.getvalue())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected operator requests")
class RouterAiOperator(Operator):
    routerai_profile = True


if __name__ == "__main__": unittest.main()
