"""Closed-release cutover: synthetic approvals/containers, real Linux locks/files."""
import copy
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import backup as b
import finish as f
import start as s
import target as t
import worker as w
import test_start as startup_fixture
from test_prepare import IMAGES, ORIGIN
from test_target import encoded


def synthetic_finish_approval(directory, config, startup, plan):
    now = int(time.time())
    value = {"version": 1, "purpose": "citygo-release-finish", "profile": f.PROFILE,
             "startup_approval_sha256": t.sha256(startup.path.read_bytes()),
             "config_path": str(config._binding.path), "config_file_sha256": t.sha256(config._binding.path.read_bytes()),
             "generation_sha256": plan["sha256"], "approved_at": now - 1, "expires_at": now + 3600,
             "allow_finish": True, "allow_traffic": False, "allow_worker": False, "allow_restart": False}
    path = directory / "finish-approval.json"
    path.write_bytes(encoded(value)); path.chmod(0o600)
    return f.Approval(path)


class Validation(unittest.TestCase):
    def test_exact_closed_permissions_and_bounded_approval(self):
        now = 2000000000
        base = {"version": 1, "purpose": "citygo-release-finish", "profile": f.PROFILE,
                "startup_approval_sha256": "a" * 64, "config_path": "/etc/citygo/backup.json",
                "config_file_sha256": "b" * 64, "generation_sha256": "c" * 64,
                "approved_at": now - 1, "expires_at": now + 10, "allow_finish": True,
                "allow_traffic": False, "allow_worker": False, "allow_restart": False}
        self.assertEqual(f.approval(encoded(base), now), base)
        for change in ({"version": True}, {"allow_finish": 1}, {"allow_traffic": True}, {"allow_worker": 0},
                       {"allow_restart": True}, {"config_path": "/tmp/$BAD"}, {"generation_sha256": "main"},
                       {"approved_at": now + 1}, {"expires_at": now}, {"extra": 1}, {"purpose": "citygo-release-start"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): f.approval(encoded({**base, **change}), now)

    def test_permissions_before_io_and_no_unbound_config(self):
        args = ({}, "b" * 40, ORIGIN, "/unused", IMAGES, "/migrate", "/api", "/worker", "/password")
        with self.assertRaisesRegex(b.BackupError, "explicit-finish"): f.finish(*args)
        with self.assertRaisesRegex(b.BackupError, "canonical-config"):
            f.finish(*args, allow_finish=True, finish_authorization=f.Approval("/unused"))

    def test_worker_secret_has_only_the_restricted_worker_role(self):
        value = b'{"DATABASE_URL":"postgresql://citygo_worker:synthetic@postgres:5432/citygo_pilot"}'
        with patch.object(t, "read_file", return_value=value): self.assertEqual(f.worker_secret("/unused"), value)
        for bad in (value.replace(b"citygo_worker", b"postgres"), value.replace(b"@postgres", b"@external"),
                    value[:-1] + b',"OPENAI_API_KEY":"synthetic"}', value.replace(b"citygo_pilot", b"citygo_pilot?x=1")):
            with patch.object(t, "read_file", return_value=bad), self.assertRaises(b.BackupError): f.worker_secret("/unused")


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected atomic cutover")
class Cutover(unittest.TestCase):
    def setUp(self):
        startup_fixture.Startup.setUp(self)
        self.config_path = self.directory / "backup.json"
        self.config_path.write_bytes(encoded(self.config)); self.config_path.chmod(0o600)
        self.config = b.load_config(self.config_path)
        self.original_raw = self.config_path.read_bytes()
        self.worker = self.directory / "worker.json"
        self.worker.write_bytes(b'{"DATABASE_URL":"postgresql://citygo_worker:synthetic@postgres:5432/citygo_pilot"}')
        self.worker.chmod(0o600)
        self.password = self.directory / "db_backup_password"
        self.password.write_bytes(b"synthetic-password"); self.password.chmod(0o600)
        verified = self.selection.verify(self.config, "b" * 40, ORIGIN, IMAGES)
        local = f.g.verify(self.image_store, verified, IMAGES)
        self.plan = f.generation(self.config, "b" * 40, ORIGIN, local, self.api, self.worker, self.password)
        self.finish_approval = synthetic_finish_approval(self.directory, self.config, self.start_approval, self.plan)

    def finish(self, **overrides):
        options = dict(allow_finish=True, finish_authorization=self.finish_approval, allow_start=True,
            startup_authorization=self.start_approval, allow_stop=True, allow_upload=True, allow_migration=True,
            selection=self.selection, authorization=self.authorization, image_store_factory=lambda _: self.image_store,
            host_factory=lambda *_: self.host, storage_factory=lambda *_: self.store, encryptor=self.encrypt,
            min_free=0, transport_factory=lambda *_: self.transport)
        options.update(overrides)
        return f.finish(self.config, "b" * 40, ORIGIN, self.ingress, IMAGES, self.secret, self.api,
                        self.worker, self.password, **options)

    def test_success_atomically_switches_shared_config_and_only_then_settles_pending(self):
        old = copy.deepcopy(self.config)
        result = self.finish()
        self.assertFalse(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        fresh = b.load_config(self.config_path)
        self.assertEqual(fresh, self.plan["config"])
        self.assertEqual(f.active_release(fresh), result["finish"])
        self.assertEqual(fresh["state_dir"], old["state_dir"])
        self.assertEqual(fresh["source_sha"], "b" * 40)
        for field in ("recipient", "endpoint", "bucket", "prefix", "storage_credentials_file"):
            self.assertEqual(fresh[field], old[field])
        for fn in (b.perform_backup, w.perform, w.open_admission):
            with self.assertRaises(b.BackupError): fn(old)
        with self.assertRaisesRegex(b.BackupError, "worker-paused"): w.perform(fresh)
        for key in ("traffic_authorized", "worker_authorized", "restart_authorized"):
            self.assertIs(result["finish"][key], False)
        spec = json.loads(Path(fresh["compose_file"]).read_bytes())
        self.assertEqual(set(spec["services"]), {"api", "web", "worker", "backup"})
        self.assertNotIn("volumes", spec); self.assertNotIn("migrator", spec["services"])
        self.assertEqual(spec["services"]["worker"]["stop_grace_period"], "90s")
        self.assertTrue(all(v["restart"] == "no" for v in spec["services"].values()))
        self.assertNotIn("synthetic-password", json.dumps(result))
        self.assertNotIn("DATABASE_URL", Path(fresh["compose_file"]).read_text())
        self.assertEqual(next(self.state.glob("finish-*.previous.json")).read_bytes(), self.original_raw)

    def test_missing_or_wrong_finish_approval_fails_before_downtime(self):
        self.finish_approval.path.write_bytes(self.start_approval.path.read_bytes())
        with self.assertRaises(b.BackupError): self.finish()
        self.assertEqual(self.host.events, []); self.assertFalse(self.pending.exists())
        self.assertEqual(self.transport.events, []); self.assertEqual(self.store.calls, [])

    def test_changed_generation_or_secret_refuses_before_pause(self):
        self.password.write_bytes(b"changed")
        with self.assertRaisesRegex(b.BackupError, "finish-binding"): self.finish()
        self.assertEqual(self.host.events, []); self.assertFalse(self.pending.exists())

    def test_revocation_during_migration_never_starts_or_switches(self):
        self.transport.on_execute = lambda: self.finish_approval.path.unlink()
        with self.assertRaises(OSError): self.finish()
        self.assertEqual(self.start_events, []); self.assertTrue(self.pending.exists())
        self.assertEqual(self.config_path.read_bytes(), self.original_raw)

    def test_preexisting_generation_is_never_reused_or_overwritten(self):
        self.plan["directory"].mkdir(mode=0o700)
        with self.assertRaisesRegex(b.BackupError, "finish-generation-exists"): self.finish()
        self.assertEqual(self.host.events, [])

    def test_crash_before_replace_retains_old_config_and_pending(self):
        original = b.atomic_json
        def fail(path, data):
            if path == self.config_path: raise OSError("synthetic-replace-failure")
            return original(path, data)
        with patch.object(b, "atomic_json", side_effect=fail), self.assertRaises(OSError): self.finish()
        self.assertEqual(self.config_path.read_bytes(), self.original_raw)
        self.assertTrue(self.pending.exists()); self.assertFalse((self.state / f.ACTIVE).exists())
        self.assertTrue(list(self.state.glob("finish-approval-*.used.json")))

    def test_crash_after_replace_has_new_config_but_no_admissible_release(self):
        original = b.atomic_json
        def fail(path, data):
            original(path, data)
            if path == self.config_path: raise OSError("synthetic-after-replace")
        with patch.object(b, "atomic_json", side_effect=fail), self.assertRaises(OSError): self.finish()
        fresh = b.load_config(self.config_path)
        self.assertEqual(fresh["source_sha"], "b" * 40); self.assertTrue(self.pending.exists())
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): f.active_release(fresh)
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): w.open_admission(fresh)

    def test_active_record_alone_cannot_commit_and_pending_is_not_automatically_cleared(self):
        with patch.object(b, "complete_operation", side_effect=OSError("synthetic-barrier-failure")), self.assertRaises(OSError):
            self.finish()
        self.assertTrue((self.state / f.ACTIVE).exists()); self.assertTrue(self.pending.exists())
        with self.assertRaisesRegex(b.BackupError, "operation-unsettled"): f.active_release(b.load_config(self.config_path))

    def test_post_cutover_runtime_failure_keeps_pending(self):
        def fail():
            if self.config_path.read_bytes() != self.original_raw: raise b.BackupError("synthetic-health")
        self.on_probe = fail
        with self.assertRaisesRegex(b.BackupError, "synthetic-health"): self.finish()
        self.assertTrue(self.pending.exists()); self.assertFalse((self.state / f.ACTIVE).exists())

    def test_secret_drift_after_config_replace_is_not_committed(self):
        original = b.atomic_json
        def drift(path, data):
            original(path, data)
            if path == self.config_path: self.worker.write_bytes(self.worker.read_bytes().replace(b"synthetic", b"changed"))
        with patch.object(b, "atomic_json", side_effect=drift), self.assertRaisesRegex(b.BackupError, "finish-secret-changed"):
            self.finish()
        self.assertTrue(self.pending.exists()); self.assertFalse((self.state / f.ACTIVE).exists())

    def test_approval_revoked_after_cutover_retains_pending(self):
        original = b.atomic_json
        def revoke(path, data):
            original(path, data)
            if path == self.config_path: self.finish_approval.path.unlink()
        with patch.object(b, "atomic_json", side_effect=revoke), self.assertRaises(OSError): self.finish()
        self.assertTrue(self.pending.exists()); self.assertFalse((self.state / f.ACTIVE).exists())

    def test_partial_generation_failure_never_changes_canonical_config(self):
        original = f.write_new
        def fail(path, raw, **kwargs):
            if path.name == "dump.sh": raise OSError("synthetic-disk-full")
            return original(path, raw, **kwargs)
        with patch.object(f, "write_new", side_effect=fail), self.assertRaises(OSError): self.finish()
        self.assertTrue(self.pending.exists()); self.assertTrue(self.plan["directory"].exists())
        self.assertEqual(self.config_path.read_bytes(), self.original_raw)

    def test_retained_live_health_callback_expires_with_its_context(self):
        original = s._started_window
        callbacks = []
        from contextlib import contextmanager
        @contextmanager
        def capture(*args, **kwargs):
            with original(*args, **kwargs) as stage:
                callbacks.append(stage["recheck"])
                yield stage
        with patch.object(s, "_started_window", capture): self.finish()
        with self.assertRaisesRegex(b.BackupError, "start-window-inactive"): callbacks[0](cutover=True)

    def test_both_locks_are_held_at_commit(self):
        original = b.complete_operation
        def verify(state, operation, **kwargs):
            for name in ("maintenance.lock", "worker-admission.lock"):
                with self.assertRaisesRegex(b.BackupError, "already-running"):
                    with b.lock(state, name): pass
            original(state, operation, **kwargs)
        with patch.object(b, "complete_operation", side_effect=verify): self.finish()

    def test_revocation_during_last_active_receipt_read_keeps_barrier(self):
        original = t.read_file
        def revoke(path, **kwargs):
            raw = original(path, **kwargs)
            if Path(path) == self.state / f.ACTIVE: self.finish_approval.path.unlink()
            return raw
        with patch.object(t, "read_file", side_effect=revoke), self.assertRaises(OSError): self.finish()
        self.assertTrue(self.pending.exists()); self.assertTrue((self.state / f.ACTIVE).exists())

    def test_expiry_during_last_pending_read_keeps_barrier(self):
        original = b.verify_operation
        expired = t.strict_json(self.finish_approval.path.read_bytes())["expires_at"] + 1
        def expire(state, record):
            result = original(state, record)
            if (state / f.ACTIVE).exists():
                clock = patch.object(f.time, "time", return_value=expired)
                clock.start(); self.addCleanup(clock.stop)
            return result
        with patch.object(b, "verify_operation", side_effect=expire), self.assertRaises(b.BackupError): self.finish()
        self.assertTrue(self.pending.exists()); self.assertTrue((self.state / f.ACTIVE).exists())

    def test_stored_startup_success_does_not_resume_or_authorize_finish(self):
        startup_fixture.Startup.start(self)
        with self.assertRaises(b.BackupError): self.finish()
        self.assertTrue(self.pending.exists()); self.assertEqual(self.config_path.read_bytes(), self.original_raw)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected atomic cutover")
class RouterAiCutover(Cutover):
    # Run the entire existing failure/drift/atomic-cutover suite for the new
    # profile too. All keys, images, network and approvals remain synthetic.
    profile = s.ROUTERAI_PROFILE
    marker = "routerai-credit-v1"

    def setUp(self):
        Cutover.setUp(self)
        startup_fixture.enable_routerai_fixture(self, self.profile)
        verified = self.selection.verify(self.config, "b" * 40, ORIGIN, IMAGES)
        local = f.g.verify(self.image_store, verified, IMAGES)
        self.plan = f.generation(self.config, "b" * 40, ORIGIN, local, self.api, self.worker, self.password, self.profile)
        self.finish_approval = synthetic_finish_approval(self.directory, self.config, self.start_approval, self.plan)

    def test_routerai_generation_contains_only_the_profile_marker_not_key_or_notice(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        self.assertEqual(spec["services"]["api"]["environment"]["CITYGO_AI_PROFILE"], self.marker)
        self.assertEqual(spec["services"]["api"]["environment"]["LLM_PROVIDER"], "routerai")
        for role in ("web", "worker", "backup"):
            self.assertNotIn("CITYGO_AI_PROFILE", spec["services"][role].get("environment", {}))
        for text in (json.dumps(result), self.plan["files"]["compose.json"].decode()):
            self.assertNotIn("synthetic-not-live", text)
            self.assertNotIn("Synthetic offline fixture", text)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected atomic cutover")
class CityGo10xCutover(RouterAiCutover):
    profile = s.CITYGO_10X_PROFILE
    marker = "routerai-citygo-10x-v1"

    def test_closed_generation_never_mounts_or_publishes_yookassa_credentials(self):
        self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        self.assertEqual(json.loads(self.api.read_bytes())["YOOKASSA_MODE"], "disabled")
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 3)
        self.assertNotIn("YOOKASSA", self.plan["files"]["compose.json"].decode())
        self.assertEqual(set(spec["services"]), {"api", "web", "worker", "backup"})
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected live-profile atomic cutover")
class CityGo10xLiveCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-v1"

    def test_live_transport_generation_is_closed_and_keys_remain_only_in_api_mount(self):
        self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(value["YOOKASSA_MODE"], "live")
        self.assertEqual(value["YOOKASSA_RECEIPT_MODE"], "npd_manual")
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 4)
        for role in ("web", "worker", "backup"):
            self.assertFalse(any("YOOKASSA" in key or "ROUTERAI" in key
                                 for key in spec["services"][role].get("environment", {})))
            self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                 else mount == "api_config" for mount in spec["services"][role].get("secrets", [])))
        self.assertNotIn(value["YOOKASSA_SECRET_KEY"], self.plan["files"]["compose.json"].decode())
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected CN live-profile atomic cutover")
class CityGo10xLiveCnCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-v1"

    def test_cn_v5_generation_remains_closed_and_preserves_only_the_exact_api_mount(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 5)
        self.assertEqual(value["ROUTERAI_COUNTRY"], "cn")
        self.assertEqual(value["ROUTERAI_MODEL"], "deepseek/deepseek-v4-pro-0813")
        self.assertEqual(value["ROUTERAI_MAX_OUTPUT_TOKENS"], "4096")
        self.assertEqual(value["LLM_MAX_INPUT_BYTES"], "8192")
        self.assertEqual({k: value[k] for k in s.ROUTERAI_LIMITS}, dict.fromkeys(s.ROUTERAI_LIMITS, "0"))
        self.assertEqual(value["YOOKASSA_MODE"], "live")
        self.assertEqual(value["YOOKASSA_RECEIPT_MODE"], "npd_manual")
        for role in ("web", "worker", "backup"):
            self.assertFalse(any("YOOKASSA" in key or "ROUTERAI" in key or key == "CITYGO_AI_PROFILE"
                                 for key in spec["services"][role].get("environment", {})))
            self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                 else mount == "api_config" for mount in spec["services"][role].get("secrets", [])))
        for hidden in (value["YOOKASSA_SECRET_KEY"], value["ROUTERAI_API_KEY"], value["ROUTERAI_DATA_NOTICE"]):
            self.assertNotIn(hidden, self.plan["files"]["compose.json"].decode())
            self.assertNotIn(hidden, json.dumps(result))
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected email-profile atomic cutover")
class CityGo10xPostboxEmailCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1"

    def test_email_v8_generation_is_closed_api_only_and_keeps_money_and_model_settings(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 8)
        self.assertEqual(value["EMAIL_REGISTRATION_MODE"], "required")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "disabled")
        self.assertEqual(value["SMS_RU_MODE"], "disabled")
        self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft")
        self.assertEqual(value["AI_CREDIT_MODE"], "routerai_citygo_10x")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        for role, service in spec["services"].items():
            self.assertFalse(any(key.startswith(("EMAIL_", "POSTBOX_", "PHONE_", "SMS_")) for key in service.get("environment", {})))
            if role != "api":
                self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                     else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode())
            self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected SMS/email-profile atomic cutover")
class CityGo10xPostboxSmsCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-smsru-v1"

    def test_v9_closed_generation_preserves_email_finance_and_api_only_phone_secrets(self):
        result = self.finish();spec = json.loads(self.plan["files"]["compose.json"]);value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 9)
        self.assertEqual(value["EMAIL_REGISTRATION_MODE"], "required")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "sms_ru");self.assertEqual(value["SMS_RU_MODE"], "live")
        self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft")
        self.assertEqual(value["AI_CREDIT_MODE"], "routerai_citygo_10x")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        for role, service in spec["services"].items():
            self.assertFalse(any(k.startswith(("EMAIL_", "POSTBOX_", "PHONE_", "SMS_")) for k in service.get("environment", {})))
            if role != "api": self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict) else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PHONE_SMS_PRIVATE_KEYS:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode());self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed);self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected ProstoSMS/email-profile atomic cutover")
class CityGo10xPostboxProstoCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-v1"

    def test_v10_is_closed_api_only_and_does_not_reenable_legacy_smsru(self):
        result = self.finish();spec = json.loads(self.plan["files"]["compose.json"]);value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 10)
        self.assertEqual(value["EMAIL_REGISTRATION_MODE"], "required");self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms")
        self.assertEqual(value["PROSTOSMS_MODE"], "live");self.assertEqual(value["SMS_RU_MODE"], "disabled")
        self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft");self.assertEqual(value["AI_CREDIT_MODE"], "routerai_citygo_10x")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        for role, service in spec["services"].items():
            self.assertFalse(any(k.startswith(("EMAIL_", "POSTBOX_", "PHONE_", "SMS_", "PROSTOSMS_")) for k in service.get("environment", {})))
            if role != "api": self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict) else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PROSTOSMS_PRIVATE_KEYS:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode());self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed);self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected unlimited ProstoSMS cutover")
class CityGo10xPostboxProstoUnlimitedCutover(RouterAiCutover):
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-v1"

    def test_v11_unlimited_sms_is_closed_api_only_and_preserves_financial_profile(self):
        result = self.finish();spec = json.loads(self.plan["files"]["compose.json"]);value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 11)
        self.assertEqual(value["PHONE_SMS_GLOBAL_DAILY_LIMIT"], "unlimited");self.assertEqual(value["PHONE_SMS_GLOBAL_TOTAL_LIMIT"], "unlimited")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms");self.assertEqual(value["PROSTOSMS_MODE"], "live")
        self.assertEqual(value["SMS_RU_MODE"], "disabled");self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft")
        self.assertEqual(value["AI_CREDIT_MODE"], "routerai_citygo_10x");self.assertEqual(value["YOOKASSA_MODE"], "live")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        for role, service in spec["services"].items():
            self.assertFalse(any(key.startswith(("EMAIL_", "POSTBOX_", "PHONE_", "SMS_", "PROSTOSMS_")) for key in service.get("environment", {})))
            if role != "api": self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict) else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PROSTOSMS_PRIVATE_KEYS:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode());self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed);self.assertFalse((self.state / w.ADMISSION).exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected GigaChat flat-price modes cutover")
class CityGo10xAssistantModesGigaChatFlat3Cutover(RouterAiCutover):
    # Run the complete inherited success/failure/revocation/atomic-cutover matrix
    # for this independently scoped profile, not just a schema-only validation.
    profile = s.CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE
    marker = "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-v1"

    def test_v13_three_modes_stay_closed_and_only_api_has_one_private_mount(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 13)
        self.assertEqual(value["AI_ASSISTANT_MODES"], "enabled")
        self.assertEqual(value["AI_MINIMUM_FIXED_FEE"], "enabled")
        self.assertEqual(value["GIGACHAT_MODEL"], "GigaChat-3-Ultra")
        self.assertEqual(value["GIGACHAT_SCOPE"], "GIGACHAT_API_PERS")
        self.assertEqual(value["GIGACHAT_CA_BUNDLE_FILE"], "/app/certs/russian-trusted-root.crt")
        self.assertEqual(value["LLM_REQUEST_TIMEOUT_MS"], "60000")
        self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft")
        self.assertEqual(value["AI_CREDIT_MODE"], "routerai_citygo_10x")
        self.assertEqual(value["YOOKASSA_MODE"], "live")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        self.assertEqual(value["EMAIL_REGISTRATION_MODE"], "required")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms")
        self.assertEqual(value["PROSTOSMS_MODE"], "live")
        self.assertEqual({k: value[k] for k in s.PHONE_SMS_LIMITS}, dict.fromkeys(s.PHONE_SMS_LIMITS, "unlimited"))
        self.assertEqual(spec["services"]["api"]["secrets"], [{"source": "api_config", "target": "api.json"}])
        self.assertEqual(spec["secrets"]["api_config"], {"file": str(self.api)})
        self.assertEqual(set(spec["services"]), {"api", "web", "worker", "backup"})
        for role, service in spec["services"].items():
            self.assertFalse(any(key.startswith(("GIGACHAT_", "AI_MINIMUM_", "EMAIL_", "POSTBOX_", "PHONE_", "SMS_", "PROSTOSMS_"))
                                 for key in service.get("environment", {})))
            if role != "api":
                self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                     else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PROSTOSMS_PRIVATE_KEYS | {"GIGACHAT_CREDENTIALS", "ROUTERAI_API_KEY"}:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode())
            self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        for key in ("traffic_authorized", "worker_authorized", "restart_authorized"):
            self.assertIs(result["finish"][key], False)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected postpay atomic cutover")
class PostpayActualCutover(RouterAiCutover):
    # Inherit all closed cutover, expiry, secret drift and rollback-barrier cases.
    profile = s.POSTPAY_ACTUAL_PROFILE
    marker = "postpay-actual-v1"

    def test_v14_postpay_stays_hash_bound_closed_and_private_to_api(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 14)
        self.assertEqual(value["AI_CUSTOMER_BILLING_MODE"], "postpay_actual_v1")
        self.assertEqual(value["AI_REQUEST_COST_LIMIT_MODE"], "operator_ceiling")
        self.assertEqual(value["AI_CREDIT_RESERVATION_MODE"], "fixed5_overdraft")
        self.assertEqual(value["AI_MINIMUM_FIXED_FEE"], "enabled")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms")
        self.assertEqual(spec["services"]["api"]["environment"]["CITYGO_AI_PROFILE"], self.marker)
        self.assertEqual(spec["services"]["api"]["secrets"], [{"source": "api_config", "target": "api.json"}])
        for role, service in spec["services"].items():
            for key in ("AI_CUSTOMER_BILLING_MODE", "AI_REQUEST_COST_LIMIT_MODE"):
                self.assertNotIn(key, service.get("environment", {}))
            if role != "api":
                self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                     else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PROSTOSMS_PRIVATE_KEYS | {"GIGACHAT_CREDENTIALS", "ROUTERAI_API_KEY"}:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode())
            self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        for key in ("traffic_authorized", "worker_authorized", "restart_authorized"):
            self.assertIs(result["finish"][key], False)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected context64 atomic cutover")
class PostpayContext64Cutover(RouterAiCutover):
    # Reuse the real closed cutover, expiry, drift and rollback-barrier cases.
    profile = s.POSTPAY_CONTEXT64_PROFILE
    marker = "postpay-context64-v1"

    def test_v15_keeps_context_and_postpay_hash_bound_without_opening_controls(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 15)
        self.assertEqual(value["LLM_MAX_INPUT_BYTES"], "65536")
        self.assertEqual(value["ROUTERAI_MAX_OUTPUT_TOKENS"], "4096")
        self.assertEqual(value["AI_MAXIMUM_REASONING_EFFORT"], "medium")
        self.assertEqual(value["AI_CUSTOMER_BILLING_MODE"], "postpay_actual_v1")
        self.assertEqual(value["AI_REQUEST_COST_LIMIT_MODE"], "operator_ceiling")
        self.assertEqual(value["AI_MINIMUM_FIXED_FEE"], "enabled")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms")
        self.assertEqual(spec["services"]["api"]["environment"]["CITYGO_AI_PROFILE"], self.marker)
        self.assertEqual(spec["services"]["api"]["secrets"], [{"source": "api_config", "target": "api.json"}])
        for role, service in spec["services"].items():
            for key in ("LLM_MAX_INPUT_BYTES", "AI_CUSTOMER_BILLING_MODE", "AI_REQUEST_COST_LIMIT_MODE"):
                self.assertNotIn(key, service.get("environment", {}))
            if role != "api":
                self.assertFalse(any(mount.get("source") == "api_config" if isinstance(mount, dict)
                                     else mount == "api_config" for mount in service.get("secrets", [])))
        for key in s.EMAIL_PRIVATE_KEYS | s.PROSTOSMS_PRIVATE_KEYS | {"GIGACHAT_CREDENTIALS", "ROUTERAI_API_KEY"}:
            self.assertNotIn(value[key], self.plan["files"]["compose.json"].decode())
            self.assertNotIn(value[key], json.dumps(result))
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        for key in ("traffic_authorized", "worker_authorized", "restart_authorized"):
            self.assertIs(result["finish"][key], False)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected memory-profile atomic cutover")
class PostpayMemoryCutover(RouterAiCutover):
    # Retain the same real closed cutover, drift, expiry and rollback barriers.
    profile = s.POSTPAY_MEMORY_PROFILE
    marker = "postpay-memory-v1"

    def test_v16_pins_memory_configuration_and_never_opens_spending_or_traffic(self):
        result = self.finish()
        spec = json.loads(self.plan["files"]["compose.json"])
        value = json.loads(self.api.read_bytes())
        self.assertEqual(s.approval(self.start_approval.path.read_bytes(), time.time())["version"], 16)
        self.assertEqual(value["LLM_MAX_INPUT_BYTES"], "8388608")
        self.assertEqual(value["AI_CONTEXT_STRATEGY"], "model_window_memory_v1")
        self.assertEqual(value["ROUTERAI_MAX_OUTPUT_TOKENS"], "4096")
        self.assertEqual(value["AI_MAXIMUM_REASONING_EFFORT"], "medium")
        self.assertEqual(value["AI_CUSTOMER_BILLING_MODE"], "postpay_actual_v1")
        self.assertEqual(value["AI_REQUEST_COST_LIMIT_MODE"], "operator_ceiling")
        self.assertEqual(value["AI_MINIMUM_FIXED_FEE"], "enabled")
        self.assertEqual(value["YOOKASSA_FISCAL_PROFILE"], "citygo_service_full_payment_v1")
        self.assertEqual(value["PHONE_VERIFICATION_MODE"], "prosto_sms")
        self.assertEqual(spec["services"]["api"]["environment"]["CITYGO_AI_PROFILE"], self.marker)
        self.assertEqual(spec["services"]["api"]["secrets"], [{"source": "api_config", "target": "api.json"}])
        for role, service in spec["services"].items():
            for key in ("LLM_MAX_INPUT_BYTES", "AI_CONTEXT_STRATEGY", "AI_CUSTOMER_BILLING_MODE"):
                self.assertNotIn(key, service.get("environment", {}))
            if role != "api": self.assertNotIn("secrets", service)
        self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        for key in ("traffic_authorized", "worker_authorized", "restart_authorized"):
            self.assertIs(result["finish"][key], False)


if __name__ == "__main__": unittest.main()
