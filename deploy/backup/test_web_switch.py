"""Pure synthetic adapter tests; no Docker, Nginx, signals, root or network."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

import web_switch as w


def fixture(version=1, *, same_web=False):
    """Executable schema example. Hashes/identities are deliberately synthetic."""
    files = {"/trusted/nginx.conf": b"trusted nginx configuration", "/trusted/api.json": b"existing protected config"}
    def file_pin(path, raw):
        files[path] = raw
        return {"path": path, "sha256": w.digest(raw)}
    records = {}
    def container(number, service, source="a", ip=None, port=None):
        ident = f"{number:064x}"
        labels = {"com.docker.compose.project": "citygo-web-switch-test",
                  "com.docker.compose.service": service, "org.opencontainers.image.revision": source * 40}
        config = {"Labels": labels, "Env": ["TRUSTED_PROXY_CIDRS=172.30.92.10/32,172.30.92.20/32"] if service == "api" else []}
        host_config = {"Memory": (1024 if service == "postgres" else 768) * w.MIB,
                       "ReadonlyRootfs": True, "Privileged": False, "Init": True,
                       "RestartPolicy": {"Name": "no"}, "PortBindings": {}}
        nets = {}
        if service in ("api", "web"):
            nets["web"] = {"NetworkID": "1" * 64, "IPAddress": ip or "172.30.92.11", "Aliases": [service]}
        if service in ("api", "postgres"):
            nets["database"] = {"NetworkID": "2" * 64, "IPAddress": "172.30.93." + str(number), "Aliases": [service]}
        if port:
            host_config["PortBindings"] = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
        state = {"StartedAt": "2026-11-09T00:00:00.000000000Z", "Status": "running", "Running": True,
                 "Health": {"Status": "healthy"}, "Paused": False, "Restarting": False, "OOMKilled": False,
                 "Dead": False, "Error": "", "ExitCode": 0}
        if service in ("worker", "backup", "migrator"):
            state.update(Status="exited", Running=False)
        item = {"Id": ident, "Image": "sha256:" + f"{number + 100:064x}", "Config": config,
                "HostConfig": host_config, "Mounts": [], "NetworkSettings": {"Networks": nets, "Ports": copy.deepcopy(host_config["PortBindings"])},
                "RestartCount": 0, "State": state}
        records[ident] = item
        return {"id": ident, "image": item["Image"], "source_sha": source * 40,
                "started_at": state["StartedAt"], "runtime_sha256": w.runtime_fingerprint(item),
                "project": labels["com.docker.compose.project"], "service": service}
    api, postgres, job = container(1, "api"), container(2, "postgres"), container(3, "worker")
    old = container(4, "web", ip=w.SLOTS[3000], port=3000)
    new = container(5, "web", "b", ip=w.SLOTS[3001], port=3001)
    now = int(time.time())
    value = {"version": version, "purpose": w.PLAN_PURPOSES[version], "operation_id": "a" * 32,
             "approved_at": now - 10, "expires_at": now + 3600, "origin": "https://pilot.example.test",
             "paths": {"state_dir": "/trusted/state", "coordination_dir": "/trusted/backup-state",
                       "nginx_config": "/trusted/nginx.conf", "upstream_include": "/trusted/web-upstream.conf",
                       "traffic_marker": "/trusted/traffic-open"},
             "files": [{"path": p, "sha256": w.digest(raw)} for p, raw in files.items()],
             "baseline": {"api": api, "postgres": postgres, "jobs": [job]},
             "slots": {"old": {"container": old, "port": 3000, "ip": w.SLOTS[3000]},
                       "new": {"container": new, "port": 3001, "ip": w.SLOTS[3001]}},
             "compatibility": {}, "assets": {"root": "/trusted/assets/_next/static"},
             "nginx": {"master": {"pid": 100, "starttime": 1000},
                       "workers": [{"pid": 101, "starttime": 1001}, {"pid": 102, "starttime": 1002}]},
             "networks": {"web": "1" * 64, "database": "2" * 64}}
    for name, source in (("old", "a"), ("new", "b")):
        record = {"version": 1, "source_sha": source * 40, "backend_sha256": "c" * 64,
                  "schema_sha256": "d" * 64, "api_contract": "1", "api_internal_url": "http://api:4000",
                  "advertising": "disabled"}
        value["compatibility"][name] = file_pin("/trusted/" + name + "-compatibility.json", w.wire(record))
    for name in ("archive", "public_old", "public_new"):
        value["assets"][name] = file_pin("/trusted/" + name + ".json", w.wire({"chunks/a.js": {"sha256": "e" * 64, "size": 10}}))
    files[value["paths"]["traffic_marker"]] = b"open\n"
    files[value["paths"]["upstream_include"]] = w.upstream(3000)
    if same_web:
        records[new["id"]]["Image"] = old["image"]
        records[new["id"]]["Config"]["Labels"]["org.opencontainers.image.revision"] = old["source_sha"]
        new.update(image=old["image"], source_sha=old["source_sha"])
        path = value["compatibility"]["new"]["path"]
        compatibility = w.strict_json(files[path])
        compatibility["source_sha"] = old["source_sha"]
        value["compatibility"]["new"] = file_pin(path, w.wire(compatibility))
    if version == 2:
        for name, slot in value["slots"].items():
            records[slot["container"]["id"]]["HostConfig"]["RestartPolicy"] = {
                "Name": "no" if name == "old" else "unless-stopped", "MaximumRetryCount": 0}
    if same_web or version == 2:
        for slot in value["slots"].values():
            slot["container"]["runtime_sha256"] = w.runtime_fingerprint(records[slot["container"]["id"]])
    plan = w.WebSwitchPlan(w.wire(value), Path("/trusted/plan.json"))
    return plan, FakeHost(plan, files, records)


class FakeHost:
    def __init__(self, plan, files, records):
        self.plan, self.files, self.records = plan, files, records
        self.journal, self.events = {}, []
        self.workers = copy.deepcopy(plan.values["nginx"]["workers"])
        self.route = "127.0.0.1:3000"
        self.fail = set()
        self.keep_old_workers = False
        self.stop_exit = 0
        self.stop_hangs = False

    def event(self, name):
        self.events.append(name)
        if name in self.fail:
            raise w.WebSwitchError("synthetic-failure")

    def assert_plan(self):
        self.event("plan")
        self.plan.values

    @contextmanager
    def locked(self):
        self.event("lock")
        yield

    def read(self, path):
        self.event("read:" + str(path))
        return self.files[str(path)]

    def pinned(self, pin):
        raw = self.read(pin["path"])
        w.require(w.digest(raw) == pin["sha256"], "file-pin-changed")
        return raw

    def write(self, path, raw):
        self.event("write:include")
        self.files[str(path)] = raw

    def record(self, name):
        return copy.deepcopy(self.journal.get(name))

    def save(self, name, value):
        self.event("save:" + name + ":" + value["phase"])
        self.journal[name] = copy.deepcopy(value)

    def clear_pending(self):
        self.event("clear-pending")
        del self.journal[w.PENDING]

    def inspect(self, ident):
        self.event("inspect:" + ident)
        return copy.deepcopy(self.records[ident])

    def inventory(self, projects):
        self.event("inventory")
        return set(self.records)

    def network_peers(self, ident):
        value = self.plan.values
        if ident == value["networks"]["database"]:
            return {value["baseline"][k]["id"] for k in ("api", "postgres")}
        return {pin["id"] for pin in [value["baseline"]["api"]] + [s["container"] for s in value["slots"].values()]
                if self.records[pin["id"]]["State"]["Running"]}

    def resources(self):
        self.event("resources")

    def quiet(self):
        self.event("quiet")

    def nginx_policy(self):
        self.event("nginx-policy")

    def nginx_test(self):
        self.event("nginx-test")

    def processes(self):
        self.event("processes")
        return copy.deepcopy(self.workers)

    def hup(self):
        self.event("hup")
        fresh = [{"pid": 201, "starttime": 2001}, {"pid": 202, "starttime": 2002}]
        self.workers = self.workers + fresh if self.keep_old_workers else fresh
        self.route = "127.0.0.1:3001"

    def probe(self, port=None):
        self.event("probe:" + str(port))
        return self.route if port is None else None

    def sigterm(self, ident):
        self.event("sigterm:" + ident)
        if not self.stop_hangs:
            self.records[ident]["State"].update(Status="exited", Running=False, ExitCode=self.stop_exit)
            for endpoint in self.records[ident]["NetworkSettings"]["Networks"].values():
                endpoint["IPAddress"] = ""
            self.records[ident]["NetworkSettings"]["Ports"] = {}

    def pause(self):
        self.event("pause")


class Protocol(unittest.TestCase):
    def setUp(self):
        self.plan, self.host = fixture()
        self.public = patch.object(w.assets, "verify_public_compatibility", return_value={"preserved": 1}).start()
        self.archive = patch.object(w.assets, "verify_archive", return_value={"manifest_sha256": "e" * 64}).start()
        self.addCleanup(patch.stopall)

    def switch(self):
        return w.switch(self.plan, allow_switch=True, _host=self.host)

    def retire(self, seconds=0):
        return w.retire(self.plan, allow_stop=True, _host=self.host, _wait_seconds=seconds)

    def assert_no_mutation(self):
        self.assertFalse(any(x.startswith(("save:", "write:", "sigterm:")) or x == "hup" for x in self.host.events))

    def test_verify_is_read_only_and_repeatable(self):
        self.assertEqual(w.verify(self.plan, _host=self.host)["status"], "verified-not-switched")
        w.verify(self.plan, _host=self.host)
        self.assert_no_mutation()

    def test_permissions_are_exact_booleans_and_cli_flags_match_operation(self):
        for permission in (False, 1, None, "true"):
            with self.assertRaises(w.WebSwitchError):
                w.switch(self.plan, allow_switch=permission, _host=self.host)
            with self.assertRaises(w.WebSwitchError):
                w.retire(self.plan, allow_stop=permission, _host=self.host)
        with patch.object(w, "load_plan") as load:
            self.assertEqual(w.main(["verify", "--plan", "/anything", "--allow-stop"]), 1)
            load.assert_not_called()
        self.assert_no_mutation()

    def test_success_durable_pending_precedes_ingress_and_retirement(self):
        baseline = {k: copy.deepcopy(v) for k, v in self.host.records.items() if k not in {s["container"]["id"] for s in self.plan.values["slots"].values()}}
        receipt = self.switch()
        self.assertEqual(receipt["phase"], "switched-awaiting-retirement")
        events = self.host.events
        self.assertLess(events.index("save:" + w.PENDING + ":prepared"), events.index("write:include"))
        self.assertLess(events.index("nginx-test"), events.index("hup"))
        self.assertFalse(any(x.startswith("sigterm:") for x in events))
        self.assertEqual(self.retire()["phase"], "retired")
        self.assertNotIn(w.PENDING, self.host.journal)
        for ident, state in baseline.items():
            self.assertEqual(self.host.records[ident], state)

    def test_switch_replay_does_not_reload_twice(self):
        self.switch()
        with self.assertRaisesRegex(w.WebSwitchError, "web-switch-pending"):
            self.switch()
        self.assertEqual(self.host.events.count("hup"), 1)

    def test_retirement_replay_is_read_only(self):
        self.switch()
        result = self.retire()
        count = len(self.host.events)
        self.assertEqual(self.retire(), result)
        self.assertFalse(any(x.startswith(("save:", "write:", "sigterm:")) for x in self.host.events[count:]))

    def test_retired_web_empty_docker_address_is_accepted_but_other_drift_is_not(self):
        self.switch()
        self.retire()
        ident = self.plan.values["slots"]["old"]["container"]["id"]
        endpoint = next(iter(self.host.records[ident]["NetworkSettings"]["Networks"].values()))
        self.assertEqual(endpoint["IPAddress"], "")
        for key, changed in (("NetworkID", "f" * 64), ("Aliases", ["unexpected-alias"]), ("IPAddress", "172.30.92.99")):
            before = copy.deepcopy(endpoint[key])
            endpoint[key] = changed
            with self.assertRaises(w.WebSwitchError):
                self.retire()
            endpoint[key] = before

    def test_nginx_test_failure_restores_bytes_without_hup(self):
        self.host.fail.add("nginx-test")
        with self.assertRaises(w.WebSwitchError):
            self.switch()
        self.assertEqual(self.host.files[self.plan.values["paths"]["upstream_include"]], w.upstream(3000))
        self.assertEqual(self.host.journal[w.PENDING]["phase"], "configuration-rejected")
        self.assertNotIn("hup", self.host.events)
        self.assertNotIn(w.ACTIVE, self.host.journal)

    def test_hup_failure_keeps_pending_and_both_webs(self):
        self.host.fail.add("hup")
        with self.assertRaises(w.WebSwitchError):
            self.switch()
        self.assertEqual(self.host.journal[w.PENDING]["phase"], "reload-requested")
        self.assertFalse(any(x.startswith("sigterm:") for x in self.host.events))

    def test_backend_drift_during_nginx_test_blocks_hup(self):
        ident = self.plan.values["baseline"]["api"]["id"]
        def changed():
            self.host.records[ident]["RestartCount"] = 1
        with patch.object(self.host, "nginx_test", side_effect=changed):
            with self.assertRaisesRegex(w.WebSwitchError, "container-pin-changed"):
                self.switch()
        self.assertNotIn("hup", self.host.events)
        self.assertIn(w.PENDING, self.host.journal)

    def test_inspect_emits_only_valid_operation_metadata(self):
        self.switch()
        self.host.journal[w.PENDING]["arbitrary-private-error"] = "PRIVATE-SECRET"
        result = w.inspect_pending(self.plan, _host=self.host)
        self.assertNotIn("PRIVATE-SECRET", json.dumps(result))
        self.assertEqual(set(result["pending"]), {"plan_sha256", "operation_id", "phase"})
        self.host.journal[w.PENDING]["phase"] = "PRIVATE-SECRET"
        with self.assertRaisesRegex(w.WebSwitchError, "state-record-invalid"):
            w.inspect_pending(self.plan, _host=self.host)

    def test_pending_write_failure_cannot_touch_include(self):
        self.host.fail.add("save:" + w.PENDING + ":prepared")
        with self.assertRaises(w.WebSwitchError):
            self.switch()
        self.assertNotIn("write:include", self.host.events)
        self.assertNotIn("hup", self.host.events)

    def test_active_commit_failure_does_not_retire_or_retry(self):
        self.host.fail.add("save:" + w.ACTIVE + ":switched-awaiting-retirement")
        with self.assertRaises(w.WebSwitchError):
            self.switch()
        self.assertEqual(self.host.journal[w.PENDING]["phase"], "reload-requested")
        with self.assertRaisesRegex(w.WebSwitchError, "switch-not-confirmed"):
            self.retire()
        self.assertFalse(any(x.startswith("sigterm:") for x in self.host.events))

    def test_old_worker_deadline_preserves_old_web(self):
        self.host.keep_old_workers = True
        self.switch()
        with self.assertRaisesRegex(w.WebSwitchError, "old-nginx-workers-still-active"):
            self.retire()
        self.assertFalse(any(x.startswith("sigterm:") for x in self.host.events))
        self.assertEqual(self.host.journal[w.PENDING]["phase"], "switched-awaiting-retirement")

    def test_reused_old_pid_with_new_starttime_is_not_old_worker(self):
        self.switch()
        self.host.workers.append({"pid": 101, "starttime": 9999})
        self.assertEqual(self.retire()["phase"], "retired")

    def test_unclean_exit_never_clears_pending(self):
        for code in (1, 137, 143):
            self.plan, self.host = fixture()
            self.switch()
            self.host.stop_exit = code
            with self.assertRaisesRegex(w.WebSwitchError, "unclean-exit"):
                self.retire()
            self.assertEqual(self.host.journal[w.PENDING]["phase"], "stop-requested")
            self.assertNotIn("clear-pending", self.host.events)

    def test_hung_web_receives_sigterm_once_and_resume_never_force_stops(self):
        self.switch()
        self.host.stop_hangs = True
        with self.assertRaisesRegex(w.WebSwitchError, "old-web-still-active"):
            self.retire()
        with self.assertRaisesRegex(w.WebSwitchError, "old-web-still-active"):
            self.retire()
        self.assertEqual(sum(x.startswith("sigterm:") for x in self.host.events), 1)
        old_id = self.plan.values["slots"]["old"]["container"]["id"]
        self.host.records[old_id]["State"].update(Running=False, Status="exited", ExitCode=0)
        self.assertEqual(self.retire()["phase"], "retired")

    def test_changed_api_pg_jobs_or_web_fail_before_switch(self):
        for role in ("api", "postgres", "job", "web"):
            self.plan, self.host = fixture()
            value = self.plan.values
            pin = (value["baseline"]["jobs"][0] if role == "job" else
                   value["slots"]["new"]["container"] if role == "web" else value["baseline"][role])
            self.host.records[pin["id"]]["State"]["StartedAt"] = "2026-11-09T01:00:00Z"
            with self.assertRaisesRegex(w.WebSwitchError, "container-pin-changed"):
                self.switch()
            self.assert_no_mutation()

    def test_retirement_rechecks_unchanged_backend_before_sigterm(self):
        self.switch()
        ident = self.plan.values["baseline"]["api"]["id"]
        self.host.records[ident]["RestartCount"] = 1
        with self.assertRaises(w.WebSwitchError):
            self.retire()
        self.assertFalse(any(x.startswith("sigterm:") for x in self.host.events))

    def test_config_file_drift_refuses_before_mutation(self):
        self.host.files["/trusted/api.json"] = b"changed config"
        with self.assertRaisesRegex(w.WebSwitchError, "file-pin-changed"):
            self.switch()
        self.assert_no_mutation()

    def test_source_schema_backend_and_advertising_guards(self):
        for key, changed in (("backend_sha256", "f" * 64), ("schema_sha256", "f" * 64),
                             ("source_sha", "f" * 40), ("advertising", "enabled"), ("api_internal_url", "http://evil:4000")):
            self.plan, self.host = fixture()
            value = self.plan.values
            pin = value["compatibility"]["new"]
            record = w.strict_json(self.host.files[pin["path"]])
            record[key] = changed
            raw = w.wire(record)
            self.host.files[pin["path"]] = raw
            value["compatibility"]["new"]["sha256"] = w.digest(raw)
            self.plan = w.WebSwitchPlan(w.wire(value), self.plan.path)
            self.host.plan = self.plan
            with self.assertRaises(w.WebSwitchError):
                self.switch()
            self.assert_no_mutation()

    def test_missing_second_trusted_web_ip_refuses(self):
        value = self.plan.values
        api = self.host.records[value["baseline"]["api"]["id"]]
        api["Config"]["Env"] = ["TRUSTED_PROXY_CIDRS=172.30.92.10/32"]
        value["baseline"]["api"]["runtime_sha256"] = w.runtime_fingerprint(api)
        self.plan = w.WebSwitchPlan(w.wire(value), self.plan.path)
        self.host.plan = self.plan
        with self.assertRaisesRegex(w.WebSwitchError, "trusted-web-ips"):
            self.switch()
        self.assert_no_mutation()

    def test_live_published_port_must_match_configured_slot(self):
        ident = self.plan.values["slots"]["new"]["container"]["id"]
        self.host.records[ident]["NetworkSettings"]["Ports"] = {"3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3001"}]}
        with self.assertRaisesRegex(w.WebSwitchError, "web-live-port-changed"):
            self.switch()
        self.assert_no_mutation()

    def test_resource_candidate_and_assets_fail_before_mutation(self):
        for event in ("resources", "quiet", "nginx-policy", "probe:3001"):
            self.plan, self.host = fixture()
            self.host.fail.add(event)
            with self.assertRaises(w.WebSwitchError):
                self.switch()
            self.assert_no_mutation()
        self.host.fail.clear()
        self.archive.side_effect = ValueError("raw-secret-must-not-be-exposed")
        with self.assertRaisesRegex(w.WebSwitchError, "^assets-unverified$"):
            self.switch()
        self.assert_no_mutation()

    def test_unknown_inventory_or_network_peer_refuses(self):
        self.host.records["f" * 64] = {}
        with self.assertRaisesRegex(w.WebSwitchError, "inventory"):
            self.switch()
        self.assert_no_mutation()
        del self.host.records["f" * 64]
        with patch.object(self.host, "network_peers", return_value={"f" * 64}):
            with self.assertRaisesRegex(w.WebSwitchError, "network-peer"):
                self.switch()
        self.assert_no_mutation()

    def test_master_change_blocks_retirement_even_after_workers_disappear(self):
        self.switch()
        self.host.fail.add("processes")
        with self.assertRaises(w.WebSwitchError):
            self.retire()
        self.assertFalse(any(x.startswith("sigterm:") for x in self.host.events))

    def test_plan_revocation_blocks_every_entry(self):
        self.host.fail.add("plan")
        for action in (lambda: w.verify(self.plan, _host=self.host), self.switch,
                       lambda: w.inspect_pending(self.plan, _host=self.host)):
            with self.assertRaises(w.WebSwitchError):
                action()
        self.assert_no_mutation()

    def test_strict_schema_rejects_shell_paths_unknown_flags_and_duplicates(self):
        value = self.plan.values
        for change in (lambda v: v.update(allow_migration=True),
                       lambda v: v["paths"].update(upstream_include="/trusted/../etc/evil"),
                       lambda v: v["slots"]["new"].update(port=3002),
                       lambda v: v["slots"]["new"].update(ip="0.0.0.0"),
                       lambda v: v.update(expires_at=v["approved_at"] - 1)):
            bad = copy.deepcopy(value)
            change(bad)
            with self.assertRaises(w.WebSwitchError):
                w.validate(bad, int(time.time()))
        with self.assertRaisesRegex(w.WebSwitchError, "duplicate-json-key"):
            w.strict_json('{"version":1,"version":1}')

    def test_mutable_outputs_cannot_alias_plan_or_manifest_inputs(self):
        for path in (self.plan.path.as_posix(), self.plan.values["compatibility"]["new"]["path"],
                     self.plan.values["assets"]["archive"]["path"]):
            value = self.plan.values
            value["paths"]["upstream_include"] = path
            with self.assertRaisesRegex(w.WebSwitchError, "plan-input-output-alias"):
                w.WebSwitchPlan(w.wire(value), self.plan.path).values

    def test_upstream_bytes_are_exclusively_two_fixed_ports(self):
        self.assertEqual(w.upstream(3000), b"proxy_pass http://127.0.0.1:3000;\n")
        for port in (True, "3000", 80, 3002):
            with self.assertRaises(w.WebSwitchError):
                w.upstream(port)

    def test_nonzero_worker_shutdown_timeout_is_rejected_even_inline(self):
        host = w.Host.__new__(w.Host)
        host.value = self.plan.values
        prefix = b"# configuration file /trusted/nginx.conf:\n# configuration file /trusted/web-upstream.conf:\n"
        for raw in (b"http { worker_shutdown_timeout 1s; }", b"events {}\nworker_shutdown_timeout 300s;",
                    b"worker_shutdown_timeout 0s; worker_shutdown_timeout 10ms;"):
            with patch.object(host, "capture", return_value=prefix + raw):
                with self.assertRaisesRegex(w.WebSwitchError, "nginx-forced-worker-timeout"):
                    host.nginx_policy()
        for raw in (b"http {}", b"# worker_shutdown_timeout 5s;\nhttp {}", b"worker_shutdown_timeout 0s;"):
            with patch.object(host, "capture", return_value=prefix + raw):
                host.nginx_policy()

    def test_every_effective_nginx_include_requires_a_file_pin(self):
        host = w.Host.__new__(w.Host)
        host.value = self.plan.values
        raw = b"# configuration file /trusted/nginx.conf:\n# configuration file /trusted/web-upstream.conf:\n"
        with patch.object(host, "capture", return_value=raw):
            host.nginx_policy()
        with patch.object(host, "capture", return_value=raw + b"# configuration file /unreviewed/vhost.conf:\n"):
            with self.assertRaisesRegex(w.WebSwitchError, "nginx-unpinned-configuration"):
                host.nginx_policy()

    def test_adapter_sigterm_and_inspect_have_fixed_argv(self):
        host = w.Host.__new__(w.Host)
        ident = self.plan.values["slots"]["old"]["container"]["id"]
        with patch.object(host, "capture", return_value=b"[{}]") as capture:
            self.assertEqual(host.inspect(ident), {})
            self.assertEqual(capture.call_args.args[0], ["/usr/bin/docker", "inspect", ident])
            host.sigterm(ident)
            self.assertEqual(capture.call_args.args[0], ["/usr/bin/docker", "kill", "--signal", "SIGTERM", ident])

    def test_master_hup_uses_pidfd_and_verifies_after_open(self):
        host = w.Host.__new__(w.Host)
        host.value = self.plan.values
        events = []
        with patch.object(w.os, "pidfd_open", side_effect=lambda pid, flags: events.append("open") or 999, create=True), \
             patch.object(w.signal, "SIGHUP", 1, create=True), \
             patch.object(host, "processes", side_effect=lambda: events.append("verify")), \
             patch.object(w.signal, "pidfd_send_signal", side_effect=lambda *args: events.append("signal"), create=True) as send, \
             patch.object(w.os, "close", side_effect=lambda fd: events.append("close")):
            host.hup()
            self.assertEqual(events, ["open", "verify", "signal", "close"])
            self.assertEqual(send.call_args.args, (999, w.signal.SIGHUP, None, 0))
            events.clear()
            with patch.object(host, "processes", side_effect=w.WebSwitchError("nginx-master-changed")):
                with self.assertRaises(w.WebSwitchError):
                    host.hup()
            self.assertEqual(events, ["open", "close"])

    def test_new_lock_has_own_fixed_name_and_closes_fd_on_failure(self):
        from types import SimpleNamespace
        import stat
        fake_fcntl = SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1)
        with patch.dict(w.sys.modules, {"fcntl": fake_fcntl}), \
             patch.object(w, "protected", return_value=Path("/trusted/state")), \
             patch.object(w.os, "O_NOFOLLOW", 131072, create=True), \
             patch.object(w.os, "O_NONBLOCK", 2048, create=True), \
             patch.object(w.os, "open", return_value=777) as opened, \
             patch.object(w.os, "fstat", return_value=info), \
             patch.object(w.os, "close") as closed:
            with w.switch_lock(Path("/trusted/state")):
                pass
            self.assertEqual(opened.call_args.args[0], Path("/trusted/state/web-switch.lock"))
            closed.assert_called_with(777)
            for key, invalid in (("st_uid", 1000), ("st_nlink", 2), ("st_mode", stat.S_IFREG | 0o666)):
                original = getattr(info, key)
                setattr(info, key, invalid)
                with self.assertRaisesRegex(w.WebSwitchError, "lock-permissions"):
                    with w.switch_lock(Path("/trusted/state")):
                        self.fail("invalid lock acquired")
                setattr(info, key, original)
                closed.assert_called_with(777)
            fake_fcntl.flock = lambda *_: (_ for _ in ()).throw(BlockingIOError())
            with self.assertRaisesRegex(w.WebSwitchError, "web-switch-already-running"):
                with w.switch_lock(Path("/trusted/state")):
                    self.fail("busy lock acquired")
            closed.assert_called_with(777)

    def test_cli_redacts_transport_errors(self):
        import contextlib
        import io
        output = io.StringIO()
        with patch.object(w, "load_plan", side_effect=ValueError("PRIVATE-CONFIG-SECRET")), contextlib.redirect_stderr(output):
            self.assertEqual(w.main(["verify", "--plan", "/trusted/plan.json"]), 1)
        self.assertEqual(output.getvalue(), '{"status": "failed-inspect-required"}\n')


class DurableV2(unittest.TestCase):
    def setUp(self):
        self.plan, self.host = fixture(2)
        patch.object(w.assets, "verify_public_compatibility", return_value={"preserved": 1}).start()
        patch.object(w.assets, "verify_archive", return_value={"manifest_sha256": "e" * 64}).start()
        self.addCleanup(patch.stopall)

    def repin_policy(self, name, policy):
        value = self.plan.values
        pin = value["slots"][name]["container"]
        self.host.records[pin["id"]]["HostConfig"]["RestartPolicy"] = copy.deepcopy(policy)
        pin["runtime_sha256"] = w.runtime_fingerprint(self.host.records[pin["id"]])
        self.plan = w.WebSwitchPlan(w.wire(value), self.plan.path)
        self.host.plan = self.plan

    def assert_unmutated(self):
        self.assertEqual(self.host.files[self.plan.values["paths"]["upstream_include"]], w.upstream(3000))
        self.assertEqual(self.host.journal, {})
        self.assertFalse(any(event.startswith(("write:", "save:", "sigterm:")) or event == "hup" for event in self.host.events))

    def cycle(self):
        baseline = {pin["id"]: copy.deepcopy(self.host.records[pin["id"]]) for pin in
                    [self.plan.values["baseline"][role] for role in ("api", "postgres")] + self.plan.values["baseline"]["jobs"]}
        verified = w.verify(self.plan, _host=self.host)
        self.assertEqual(verified["plan_version"], 2)
        self.assertEqual(verified["purpose"], w.PLAN_PURPOSES[2])
        self.assert_unmutated()
        w.switch(self.plan, allow_switch=True, _host=self.host)
        first = w.retire(self.plan, allow_stop=True, _host=self.host, _wait_seconds=0)
        count = sum(event.startswith("sigterm:") for event in self.host.events)
        self.assertEqual(first, w.retire(self.plan, allow_stop=True, _host=self.host, _wait_seconds=0))
        self.assertEqual(count, 1)
        self.assertEqual(sum(event.startswith("sigterm:") for event in self.host.events), 1)
        new_id = self.plan.values["slots"]["new"]["container"]["id"]
        self.assertEqual(self.host.records[new_id]["HostConfig"]["RestartPolicy"], {"Name": "unless-stopped", "MaximumRetryCount": 0})
        self.assertTrue(self.host.records[new_id]["State"]["Running"])
        self.assertNotIn(w.PENDING, self.host.journal)
        for ident, expected in baseline.items():
            self.assertEqual(self.host.records[ident], expected)

    def test_v2_distinct_release_finishes_with_durable_active_web_and_idempotent_retire(self):
        self.cycle()

    def test_v2_same_digest_same_source_bootstrap_preserves_single_backend(self):
        self.plan, self.host = fixture(2, same_web=True)
        old, new = (self.plan.values["slots"][name]["container"] for name in ("old", "new"))
        self.assertEqual(old["image"], new["image"])
        self.assertEqual(old["source_sha"], new["source_sha"])
        self.assertNotEqual(old["id"], new["id"])
        self.cycle()

    def test_v1_still_refuses_durable_target_even_with_exact_runtime_pin(self):
        self.plan, self.host = fixture()
        self.repin_policy("new", {"Name": "unless-stopped", "MaximumRetryCount": 0})
        with self.assertRaisesRegex(w.WebSwitchError, "web-runtime-isolation"):
            w.switch(self.plan, allow_switch=True, _host=self.host)
        self.assert_unmutated()

    def test_v2_rejects_wrong_fixed_policy_retry_counts_and_unknown_policy_fields(self):
        invalid = [
            ("old", {"Name": "unless-stopped", "MaximumRetryCount": 0}),
            ("old", {"Name": "always", "MaximumRetryCount": 0}),
            ("old", {"Name": "on-failure", "MaximumRetryCount": 0}),
            ("new", {"Name": "no", "MaximumRetryCount": 0}),
            ("new", {"Name": "always", "MaximumRetryCount": 0}),
            ("new", {"Name": "on-failure", "MaximumRetryCount": 3}),
            ("new", {"Name": "unless-stopped", "MaximumRetryCount": 1}),
            ("old", {"Name": "no", "MaximumRetryCount": 1}),
            ("new", {"Name": "unless-stopped", "MaximumRetryCount": False}),
            ("new", {"Name": "unless-stopped", "MaximumRetryCount": "0"}),
            ("new", {"Name": "unless-stopped", "MaximumRetryCount": 0, "extra": True}),
            ("new", {"Name": "unless-stopped"}),
            ("new", {"Name": "unknown", "MaximumRetryCount": 0}),
        ]
        for name, policy in invalid:
            with self.subTest(slot=name, policy=policy):
                self.plan, self.host = fixture(2)
                self.repin_policy(name, policy)
                with self.assertRaisesRegex(w.WebSwitchError, "web-runtime-isolation"):
                    w.switch(self.plan, allow_switch=True, _host=self.host)
                self.assert_unmutated()

    def test_version_purpose_pair_and_no_extra_authority_fields(self):
        value = self.plan.values
        for version, purpose in ((1, w.PLAN_PURPOSES[2]), (2, w.PLAN_PURPOSES[1]), (3, w.PLAN_PURPOSES[2]), (True, w.PLAN_PURPOSES[1])):
            bad = dict(value, version=version, purpose=purpose)
            with self.assertRaisesRegex(w.WebSwitchError, "plan-purpose"):
                w.validate(bad, int(time.time()))
        for field in ("allow_restart", "restart_policy", "allow_active_restart"):
            with self.assertRaisesRegex(w.WebSwitchError, "plan-schema"):
                w.validate(dict(value, **{field: True}), int(time.time()))

    def test_v2_active_policy_drift_blocks_retire_before_old_signal(self):
        w.switch(self.plan, allow_switch=True, _host=self.host)
        new_id = self.plan.values["slots"]["new"]["container"]["id"]
        policy = self.host.records[new_id]["HostConfig"]["RestartPolicy"]
        policy["Name"] = "always"
        with self.assertRaisesRegex(w.WebSwitchError, "container-pin-changed"):
            w.retire(self.plan, allow_stop=True, _host=self.host, _wait_seconds=0)
        self.assertFalse(any(event.startswith("sigterm:") for event in self.host.events))
        self.assertIn(w.PENDING, self.host.journal)
        policy["Name"] = "unless-stopped"
        self.assertEqual(w.retire(self.plan, allow_stop=True, _host=self.host, _wait_seconds=0)["phase"], "retired")


if __name__ == "__main__":
    unittest.main()
