"""Synthetic startup approvals and containers; Linux locks are real."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import backup as b
import start as s
import target as t
import worker as w
import test_migrate as migration_fixture
import test_prepare as preparation_fixture
from test_prepare import IMAGES, ORIGIN
from test_target import encoded

WEB_NETWORK = "f" * 64


def synthetic_start_approval(directory, migration, secret, network=WEB_NETWORK):
    now = int(time.time())
    value = {"version": 1, "purpose": "citygo-release-start", "profile": s.PROFILE,
             "migration_approval_sha256": t.sha256(migration.path.read_bytes()),
             "api_secret_sha256": t.sha256(secret.read_bytes()), "web_network_id": network,
             "approved_at": now - 1, "expires_at": now + 3600, "allow_start": True, "allow_traffic": False}
    path = directory / "start-approval.json"
    path.write_bytes(encoded(value)); path.chmod(0o600)
    return s.Approval(path)


def detail(value, role, image, secret):
    spec = s.compose_spec("citygo-fixture", ORIGIN, {role: image, ("web" if role == "api" else "api"): image}, secret)
    service = spec["services"][role]
    return {**copy.deepcopy(value), "Config": {"Image": image["local_id"], "User": "1000:1000",
                "WorkingDir": "/app", "Entrypoint": service["entrypoint"], "Cmd": [role],
                "Labels": value["Labels"], "StopTimeout": 330 if role == "api" else 30,
                "Env": ["NODE_ENV=production", *[k + "=" + v for k, v in service["environment"].items()]]},
            "HostConfig": {"Init": True, "ReadonlyRootfs": True, "Privileged": False, "AutoRemove": False,
                "Memory": s.MEMORY, "MemorySwap": s.MEMORY, "PidsLimit": 128, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"], "RestartPolicy": {"Name": "no"},
                "PortBindings": {} if role == "api" else {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}},
            "Mounts": ([{"Type": "bind", "Source": str(secret), "Destination": "/run/secrets/api.json", "RW": False}]
                       if role == "api" else []),
            "NetworkSettings": {"Networks": {**{"citygo-fixture_web_api": {"NetworkID": WEB_NETWORK,
                "IPAddress": "172.30.92.11" if role == "api" else "172.30.92.10"}},
                **({"citygo-fixture_database": {"NetworkID": "e" * 64}} if role == "api" else {})}}}


class Validation(unittest.TestCase):
    def test_start_approval_has_exact_scope_profile_time_and_binding_types(self):
        now = 2000000000
        value = {"version": 1, "purpose": "citygo-release-start", "profile": s.PROFILE,
                 "migration_approval_sha256": "a" * 64, "api_secret_sha256": "b" * 64,
                 "web_network_id": WEB_NETWORK, "approved_at": now - 1, "expires_at": now + 100,
                 "allow_start": True, "allow_traffic": False}
        self.assertEqual(s.approval(encoded(value), now), value)
        for change in ({"version": True}, {"allow_start": 1}, {"allow_traffic": True}, {"profile": "any"},
                       {"expires_at": now}, {"approved_at": now + 1}, {"expires_at": now + 86400},
                       {"migration_approval_sha256": "main"}, {"extra": "ignored"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): s.approval(encoded({**value, **change}), now)

    def test_fixed_profile_has_only_two_services_no_db_volume_hooks_build_or_public_ports(self):
        image = {"local_id": "sha256:" + "a" * 64}
        spec = s.compose_spec("citygo-fixture", ORIGIN, {"api": image, "web": image}, "/tmp/private/api.json")
        self.assertEqual(set(spec["services"]), {"api", "web"})
        self.assertNotIn("volumes", spec)
        for service in spec["services"].values():
            self.assertEqual(service["image"], image["local_id"])
            self.assertEqual(service["restart"], "no")
            for key in ("build", "env_file", "post_start", "pre_stop", "privileged", "volumes"):
                self.assertNotIn(key, service)
        self.assertEqual(spec["services"]["web"]["ports"], ["127.0.0.1:3000:3000"])
        self.assertNotIn("ports", spec["services"]["api"])
        self.assertTrue(all(n["external"] for n in spec["networks"].values()))
        with self.assertRaises(b.BackupError): s.compose_spec("citygo-fixture", ORIGIN, {"api": image, "web": image}, "/tmp/$EVIL.json")

    def test_ready_and_headered_headerless_legacy_error_contract_are_strict(self):
        headers = {"content-type": "application/json", "x-citygo-contract-version": "1", "x-request-id": "test-id"}
        value = {"error": "Login required", "code": "UNAUTHENTICATED", "contractVersion": "1", "requestId": "test-id", "retryable": False}
        s.health(200, headers, b'{"status":"ok"}', ready=True)
        s.health(401, headers, encoded(value), ready=False)
        for status, changed_headers, body in ((200, headers, encoded(value)), (401, {}, encoded(value)),
                (401, headers, encoded({**value, "retryable": 0})), (401, headers, encoded({**value, "requestId": "other"})),
                (401, headers, b"<html>error</html>"), (401, headers, b"x" * 4097)):
            with self.assertRaises(b.BackupError): s.health(status, changed_headers, body, ready=False)

    def test_api_secret_rejects_provider_keys_admin_db_and_extra_configuration(self):
        value = b'{"DATABASE_URL":"postgresql://citygo_api:synthetic@postgres:5432/citygo_pilot"}'
        with patch.object(t, "read_file", return_value=value): self.assertEqual(s.api_secret("/unused"), value)
        for raw in (value.replace(b"citygo_api", b"postgres"), value.replace(b"@postgres", b"@other"),
                    value[:-1] + b',"OPENAI_API_KEY":"synthetic"}', value.replace(b"citygo_pilot", b"citygo_pilot?sslmode=disable")):
            with patch.object(t, "read_file", return_value=raw), self.assertRaises(b.BackupError): s.api_secret("/unused")

    def test_runtime_rejects_wrong_process_image_secret_port_network_and_permissions(self):
        image = {"local_id": "sha256:" + "c" * 64, "config_id": "sha256:" + "c" * 64}
        value = preparation_fixture.container("api"); value["Image"] = image["local_id"]
        value["State"]["Dead"] = False
        base = detail(value, "api", image, "/tmp/api.json")
        s.runtime(base, "api", image, "citygo-fixture", ORIGIN, "/tmp/api.json", {"web_api": WEB_NETWORK, "database": "e" * 64})
        for key, val in (("Image", "sha256:" + "f" * 64), ("RestartCount", 1), ("State.Health.Status", "unhealthy"),
                        ("HostConfig.Privileged", True), ("HostConfig.Memory", 0), ("HostConfig.PortBindings", {"4000/tcp": []}),
                        ("Config.Cmd", ["worker"]), ("Config.User", "root"), ("Mounts", []), ("NetworkSettings.Networks", {})):
            bad = copy.deepcopy(base); parts = key.split("."); obj = bad
            for part in parts[:-1]: obj = obj[part]
            obj[parts[-1]] = val
            with self.subTest(key=key), self.assertRaises(b.BackupError):
                s.runtime(bad, "api", image, "citygo-fixture", ORIGIN, "/tmp/api.json", {"web_api": WEB_NETWORK, "database": "e" * 64})


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux live operation and protected inputs")
class Startup(unittest.TestCase):
    def setUp(self):
        migration_fixture.Continuation.setUp(self)
        self.api = self.directory / "api.json"
        self.api.write_bytes(b'{"DATABASE_URL":"postgresql://citygo_api:synthetic@postgres:5432/citygo_pilot"}')
        self.api.chmod(0o600)
        self.start_approval = synthetic_start_approval(self.directory, self.authorization, self.api)
        self.start_events = []
        self.on_replace = lambda: None
        self.on_probe = lambda: None
        self.host.web_network = lambda: {"id": WEB_NETWORK, "peers": sorted(v["Id"] for v in self.host.values
            if v["Labels"]["com.docker.compose.service"] in ("api", "web") and v["State"]["Running"])}
        def replace(directory, spec):
            self.start_events.append("replace")
            self.assertTrue(self.pending.exists()); self.assertTrue(self.host.closed)
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                with b.lock(self.state): pass
            for role, ident in (("api", "b" * 64), ("web", "c" * 64)):
                value = next(v for v in self.host.values if v["Labels"]["com.docker.compose.service"] == role)
                value["Id"] = ident; value["Image"] = spec["services"][role]["image"]
                value["State"].update(Status="running", Running=True, Dead=False, StartedAt="2026-09-26T00:00:00Z")
            self.on_replace()
        self.host.replace = replace
        def inspection(ident):
            value = next(v for v in self.host.values if v["Id"] == ident)
            role = value["Labels"]["com.docker.compose.service"]
            return detail(value, role, {"local_id": value["Image"], "config_id": value["Image"]}, self.api)
        self.host.detail = inspection
        def probe(): self.start_events.append("probe"); self.on_probe()
        self.host.probe = probe

    def start(self):
        return s.start(self.config, "b" * 40, ORIGIN, self.ingress, IMAGES, self.secret, self.api,
            allow_start=True, startup_authorization=self.start_approval, allow_stop=True, allow_upload=True,
            allow_migration=True, selection=self.selection, authorization=self.authorization,
            image_store_factory=lambda _: self.image_store, host_factory=lambda *_: self.host,
            storage_factory=lambda *_: self.store, encryptor=self.encrypt, min_free=0, transport_factory=lambda *_: self.transport)

    def test_success_same_lock_database_process_unchanged_and_access_still_closed(self):
        original = copy.deepcopy(self.host.values[0])
        result = self.start()
        self.assertEqual(self.host.values[0], original)
        self.assertEqual(self.start_events, ["replace", "probe"])
        self.assertFalse(result["startup"]["traffic_authorized"])
        self.assertFalse(result["startup"]["worker_authorized"])
        self.assertTrue(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertFalse((self.state / w.ADMISSION).exists())
        self.assertEqual(len(list(self.state.glob("start-*.success.json"))), 1)
        self.assertNotIn("DATABASE_URL", json.dumps(result))
        with self.assertRaisesRegex(b.BackupError, "start-approval-used"): self.start()

    def test_migration_approval_cannot_authorize_start(self):
        self.start_approval.path.write_bytes(self.authorization.path.read_bytes())
        with self.assertRaises(b.BackupError): self.start()
        self.assertFalse(self.pending.exists()); self.assertEqual(self.start_events, [])

    def test_bad_secret_hash_refuses_before_downtime(self):
        self.api.write_bytes(self.api.read_bytes().replace(b"synthetic", b"changed"))
        with self.assertRaisesRegex(b.BackupError, "start-binding"): self.start()
        self.assertEqual(self.host.events, [])

    def test_changed_web_network_refuses_before_pause_backup_or_migration(self):
        w.open_admission(self.config)
        self.host.web_network = lambda: {"id": "d" * 64, "peers": []}
        with self.assertRaisesRegex(b.BackupError, "start-network-changed"): self.start()
        self.assertTrue((self.state / w.ADMISSION).exists())
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.host.events, [])
        self.assertEqual(self.store.calls, [])
        self.assertEqual(self.transport.events, [])
        self.assertEqual(self.start_events, [])

    def test_revocation_during_migration_never_replaces_apps(self):
        self.transport.on_execute = lambda: self.start_approval.path.unlink()
        with self.assertRaises(OSError): self.start()
        self.assertEqual(self.start_events, []); self.assertTrue(self.pending.exists())

    def test_unexpected_or_missing_web_peer_refuses_before_any_mutation(self):
        original = self.host.web_network
        w.open_admission(self.config)
        for peers in (original()["peers"] + ["d" * 64], original()["peers"][:-1]):
            self.host.web_network = lambda: {"id": WEB_NETWORK, "peers": peers}
            with self.subTest(peers=peers), self.assertRaisesRegex(b.BackupError, "start-network-peers"):
                self.start()
            self.assertTrue((self.state / w.ADMISSION).exists())
            self.assertFalse(self.pending.exists())
            self.assertEqual(self.host.events, [])
            self.assertEqual(self.store.calls, [])
            self.assertEqual(self.transport.events, [])
            self.assertEqual(self.start_events, [])

    def test_unverified_initial_container_is_not_a_valid_web_peer(self):
        self.host.values[2]["Image"] = "sha256:" + "d" * 64
        with self.assertRaisesRegex(b.BackupError, "container-image"): self.start()
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.host.events, [])
        self.assertEqual(self.transport.events, [])

    def test_replacement_failure_keeps_pending_and_consumed_approval_no_success(self):
        def fail(): raise b.BackupError("fixture-start-failed")
        self.on_replace = fail
        with self.assertRaisesRegex(b.BackupError, "fixture-start-failed"): self.start()
        self.assertTrue(self.pending.exists())
        self.assertTrue(list(self.state.glob("start-approval-*.used.json")))
        self.assertFalse(list(self.state.glob("start-*.success.json")))

    def test_revocation_on_outer_window_exit_leaves_no_success_receipt(self):
        original = s.c._migrated_window
        @contextmanager
        def revoke_on_exit(*args, **kwargs):
            with original(*args, **kwargs) as stage:
                yield stage
                self.start_approval.path.unlink()
        with patch.object(s.c, "_migrated_window", revoke_on_exit), self.assertRaises(OSError):
            self.start()
        self.assertEqual(self.start_events, ["replace", "probe"])
        self.assertTrue(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertFalse(list(self.state.glob("start-*.success.json")))

    def test_failed_outer_window_exit_leaves_no_success_receipt(self):
        original = s.c._migrated_window
        @contextmanager
        def fail_on_exit(*args, **kwargs):
            with original(*args, **kwargs) as stage:
                yield stage
            raise b.BackupError("fixture-finalization-failed")
        with patch.object(s.c, "_migrated_window", fail_on_exit), self.assertRaisesRegex(b.BackupError, "fixture-finalization-failed"):
            self.start()
        self.assertEqual(self.start_events, ["replace", "probe"])
        self.assertTrue(self.pending.exists()); self.assertTrue(self.host.closed)
        self.assertFalse(list(self.state.glob("start-*.success.json")))

    def test_health_failure_never_opens_or_writes_success(self):
        def fail(): raise b.BackupError("fixture-health-failed")
        self.on_probe = fail
        with self.assertRaisesRegex(b.BackupError, "fixture-health-failed"): self.start()
        self.assertTrue(self.host.closed); self.assertTrue(self.pending.exists())
        self.assertFalse(list(self.state.glob("start-*.success.json")))

    def test_process_restart_during_health_is_not_success(self):
        self.on_probe = lambda: self.host.values[2]["State"].update(StartedAt="2026-09-26T00:00:01Z")
        with self.assertRaisesRegex(b.BackupError, "start-process-changed"): self.start()

    def test_postgres_restart_is_detected(self):
        self.on_replace = lambda: self.host.values[0]["State"].update(StartedAt="2026-09-26T00:00:01Z")
        with self.assertRaisesRegex(b.BackupError, "container-replaced"): self.start()

    def test_old_api_restarted_at_start_boundary_is_not_replaced(self):
        original = self.host.web_network
        def network():
            result = original()
            if list(self.state.glob("start-approval-*.used.json")):
                self.host.values[2]["State"].update(Status="running", Running=True)
            return result
        self.host.web_network = network
        with self.assertRaisesRegex(b.BackupError, "writer-active"): self.start()
        self.assertEqual(self.start_events, [])

    def test_rogue_database_endpoint_is_detected(self):
        self.on_replace = lambda: self.host.extra_peers.append("d" * 64)
        with self.assertRaisesRegex(b.BackupError, "start-network-changed"): self.start()


if __name__ == "__main__": unittest.main()
