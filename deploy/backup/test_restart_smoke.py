"""Pure/fake-engine tests for the DISPOSABLE drill, not production authorization."""
import copy
import unittest
from unittest.mock import patch

import backup as b
import restart_smoke as r
from test_prepare import inventory


class Host:
    def __init__(self):
        self.values = {v["Id"]: v for v in inventory()[:3]}
        self.calls = []
        self.fail_role = None
        self.bad_ready = False

    def inspect(self, ident): return copy.deepcopy(self.values[ident])

    def capture(self, args, **_):
        self.calls.append(args)
        value = self.values[args[-1]]
        role = value["Labels"]["com.docker.compose.service"]
        if args[0] == "stop":
            value["State"].update(Running=False, Status="exited", FinishedAt="2026-09-24T00:00:02Z",
                                  ExitCode=137 if role == self.fail_role else 0)
        elif args[0] == "start":
            value["State"].update(Running=True, Status="running", StartedAt="2026-09-24T00:00:03Z",
                                  FinishedAt="0001-01-01T00:00:00Z", Health={"Status": "unhealthy" if self.bad_ready else "healthy"})
        else: raise AssertionError("Only stop/start of exact fixture IDs is allowed")


class Evidence(unittest.TestCase):
    def test_mount_order_can_change_but_no_mount_field_can_change(self):
        mounts = [{"Type": "volume", "Name": "synthetic_database", "Source": "/synthetic/volume",
                   "Destination": "/var/lib/postgresql/data", "RW": True, "Mode": "rw", "Driver": "local"},
                  {"Type": "bind", "Source": "/synthetic/secret", "Destination": "/run/secrets/test", "RW": False}]
        expected = r.mount_identity(mounts)
        self.assertEqual(r.mount_identity(list(reversed(mounts))), expected)
        for key, value in (("Type", "bind"), ("Name", "other"), ("Source", "/other"), ("Destination", "/other"),
                           ("RW", False), ("RW", 1), ("Mode", "ro"), ("Driver", "other")):
            changed = copy.deepcopy(mounts); changed[0][key] = value
            with self.subTest(key=key, value=value): self.assertNotEqual(r.mount_identity(changed), expected)
        self.assertNotEqual(r.mount_identity(mounts[:1]), expected)
        for invalid in (None, [], [{}], mounts + [mounts[0]], [{"Destination": None}]):
            with self.assertRaises(b.BackupError): r.mount_identity(invalid)

    def test_only_random_disposable_project_synthetic_source_and_origin(self):
        config = {"project": "citygo-pilot-test-0123456789ab", "source_sha": "c" * 40}
        r.fixture_scope(config, "https://pilot.example.test")
        for change, origin in (({"project": "citygo-pilot"}, "https://pilot.example.test"),
                               ({"source_sha": "a" * 40}, "https://pilot.example.test"),
                               ({}, "https://pilot.citygo.example")):
            with self.assertRaisesRegex(b.BackupError, "disposable-required"): r.fixture_scope({**config, **change}, origin)

    def test_all_clean_stops_precede_db_then_api_then_web_start(self):
        host = Host(); initial = copy.deepcopy(host.values); checks = []
        exits, starts = r.cycle(host, initial, lambda: checks.append(True))
        self.assertEqual([c[0] for c in host.calls], ["stop"] * 3 + ["start"] * 3)
        self.assertEqual([c[-1] for c in host.calls], ["3" * 64, "2" * 64, "1" * 64, "1" * 64, "3" * 64, "2" * 64])
        self.assertEqual([c[2] for c in host.calls[:3]], ["330", "30", "60"])
        self.assertEqual(len(checks), 10)
        self.assertEqual(set(exits), set(starts))

    def test_unclean_exit_prevents_every_start(self):
        for role in r.GRACE:
            host = Host(); host.fail_role = role
            with self.subTest(role=role), self.assertRaisesRegex(b.BackupError, "unclean-exit"):
                r.cycle(host, copy.deepcopy(host.values), lambda: None)
            self.assertFalse(any(c[0] == "start" for c in host.calls))

    def test_closed_guard_failure_stops_without_retry_or_recovery(self):
        host = Host()
        def check(): raise b.BackupError("ingress-not-closed")
        with self.assertRaises(b.BackupError): r.cycle(host, copy.deepcopy(host.values), check)
        self.assertEqual(host.calls, [])

    def test_unhealthy_db_never_starts_apps(self):
        host = Host(); host.bad_ready = True
        with self.assertRaisesRegex(b.BackupError, "restart-fixture-unhealthy"):
            r.cycle(host, copy.deepcopy(host.values), lambda: None)
        self.assertEqual([c[-1] for c in host.calls if c[0] == "start"], ["1" * 64])

    def test_starting_health_has_bounded_wait_without_second_start(self):
        host = Host(); capture = host.capture
        def starting(args, **kwargs):
            capture(args, **kwargs)
            if args[0] == "start": host.values[args[-1]]["State"]["Health"]["Status"] = "starting"
        host.capture = starting
        with patch.object(r.time, "monotonic", side_effect=[0, 121]), self.assertRaisesRegex(b.BackupError, "restart-fixture-timeout"):
            r.cycle(host, copy.deepcopy(host.values), lambda: None)
        self.assertEqual(len([c for c in host.calls if c[0] == "start"]), 1)

    def test_guard_revocation_between_stop_and_start_starts_nothing(self):
        host = Host(); calls = []
        def check():
            calls.append(True)
            if len(calls) == 4: raise b.BackupError("ingress-not-closed")
        with self.assertRaises(b.BackupError): r.cycle(host, copy.deepcopy(host.values), check)
        self.assertEqual([c[0] for c in host.calls], ["stop"] * 3)

    def test_stale_process_changed_image_restarts_errors_and_dead_are_rejected(self):
        host = Host(); exits, starts = r.cycle(host, copy.deepcopy(host.values), lambda: None)
        original = starts["api"]
        for change in ({"Id": "a" * 64}, {"Image": "sha256:" + "a" * 64}, {"RestartCount": 1},
                       {"RestartPolicy": "always"}, {"Init": False}, {"StopTimeout": 1}, {"Name": "/other"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): r.restarted(exits["api"], {**original, **change})
        for change in ({"StartedAt": exits["api"]["State"]["StartedAt"]}, {"Running": False}, {"OOMKilled": True},
                       {"Error": "synthetic"}, {"Dead": True}, {"Health": {"Status": "starting"}}):
            with self.subTest(change=change), self.assertRaises(b.BackupError):
                r.restarted(exits["api"], {**original, "State": {**original["State"], **change}})


if __name__ == "__main__": unittest.main()
