"""Offline synthetic bootstrap drafts only: no Docker, secrets or server calls."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import start as legacy
import web_bootstrap as compiler


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fixture():
    """Public synthetic schema example; never a production admission or pin."""
    now = 2000000000
    source = "a" * 40
    origin = "https://pilot.example.test"
    images = {role: {"local_id": "sha256:" + digit * 64}
              for role, digit in (("api", "1"), ("web", "2"), ("jobs", "3"), ("postgres", "4"))}
    secret_paths = {"api_config": "/etc/citygo/fixture-api.json",
                    "worker_config": "/etc/citygo/fixture-worker.json",
                    "db_backup_password": "/etc/citygo/fixture-backup-password"}
    directory = "/var/lib/citygo-backup/release-" + source
    canonical = legacy.compose_spec("citygo-pilot", origin, images, secret_paths["api_config"],
                                    legacy.POSTPAY_NATIVE_SEARCH_PROFILE)
    shared = {"init": True, "read_only": True, "restart": "no", "profiles": ["ops"],
              "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "pids_limit": 128,
              "mem_limit": 256 * 1024 ** 2, "memswap_limit": 256 * 1024 ** 2,
              "tmpfs": ["/tmp:size=64m,mode=1777"], "networks": ["database"],
              "logging": copy.deepcopy(canonical["services"]["api"]["logging"])}
    canonical["services"]["worker"] = {
        **copy.deepcopy(shared), "user": "1000:1000", "stop_grace_period": "90s",
        "image": images["jobs"]["local_id"], "entrypoint": ["node", "scripts/container-runtime.mjs"],
        "working_dir": "/app", "command": ["worker"], "environment": {"CITYGO_MOUNTED_CONFIG": "1"},
        "secrets": [{"source": "worker_config", "target": "worker.json"}]}
    canonical["services"]["backup"] = {
        **copy.deepcopy(shared), "user": "postgres", "stop_grace_period": "30s",
        "image": images["postgres"]["local_id"], "entrypoint": ["sh", "/opt/citygo/dump.sh"],
        "volumes": [{"type": "bind", "source": directory + "/dump.sh",
                     "target": "/opt/citygo/dump.sh", "read_only": True}],
        "secrets": ["db_backup_password"]}
    canonical["secrets"].update({name: {"file": path} for name, path in secret_paths.items()})
    raw = encoded(canonical)
    no_restart = {"Name": "no", "MaximumRetryCount": 0}
    def pin(path, digit):
        return {"path": path, "sha256": digit * 64}
    request = {
        "version": 1, "purpose": "citygo-web-bootstrap-draft-request-v1", "operation_id": "b" * 32,
        "observed_at": now - 5, "expires_at": now + 600, "observation_sha256": "c" * 64,
        "inventory_complete": True, "origin": origin, "source_sha": source,
        "images": {role: {"id": images[role]["local_id"], "source_sha": source} for role in ("api", "web")},
        "baseline": {"api_id": "5" * 64, "web_id": "6" * 64, "postgres_id": "7" * 64,
                     "inventory_sha256": "8" * 64, "api_restart": copy.deepcopy(no_restart),
                     "web_restart": copy.deepcopy(no_restart),
                     "postgres_restart": {"Name": "unless-stopped", "MaximumRetryCount": 0}},
        "web_network": {"id": "9" * 64, "name": "citygo-pilot_web_api"},
        "originals": {"compose": {"path": directory + "/compose.json", "sha256": sha(raw)},
                      "env": pin(directory + "/empty.env", "a"),
                      "backup_config": pin("/etc/citygo/backup.json", "b"),
                      "active_release": pin("/var/lib/citygo-backup/active-release.json", "c"),
                      "autodeploy_current": pin("/var/lib/citygo-backup/autodeploy/current.json", "d")},
        "secret_pins": [pin(path, digit) for path, digit in zip(secret_paths.values(), ("e", "f", "0"))],
        "gates": {"pending": False, "worker_admission_open": False, "autodeploy_enabled": False}}
    return raw, request, now


def apply_diff(document, changes):
    result = copy.deepcopy(document)
    for change in changes:
        assert set(change) == {"path", "before", "after"}
        parts = change["path"].split("/")[1:]
        node = result
        for part in parts[:-1]:
            node = node[part.replace("~1", "/").replace("~0", "~")]
        key = parts[-1].replace("~1", "/").replace("~0", "~")
        assert node[key] == change["before"]
        node[key] = copy.deepcopy(change["after"])
    return result


class Draft(unittest.TestCase):
    def setUp(self):
        self.raw, self.request, self.now = fixture()

    def compile(self, *, canonical=None, request=None, now=None):
        return compiler.compile_draft(self.raw if canonical is None else canonical,
                                      encoded(self.request if request is None else request),
                                      self.now if now is None else now)

    def changed_canonical(self, mutate):
        canonical = json.loads(self.raw)
        mutate(canonical)
        raw = encoded(canonical)
        request = copy.deepcopy(self.request)
        request["originals"]["compose"]["sha256"] = sha(raw)
        return raw, request

    def reject_request(self, mutate, code=None):
        request = copy.deepcopy(self.request)
        mutate(request)
        with self.assertRaises(compiler.BootstrapError) as error:
            self.compile(request=request)
        if code:
            self.assertEqual(str(error.exception), code)
        self.assertRegex(str(error.exception), r"^[a-z][a-z0-9-]+$")

    def reject_canonical(self, mutate):
        raw, request = self.changed_canonical(mutate)
        with self.assertRaises(compiler.BootstrapError):
            self.compile(canonical=raw, request=request)

    def test_exact_outputs_original_bytes_and_only_two_forward_deltas(self):
        request_raw = b" \n" + encoded(self.request)
        files = compiler.compile_draft(self.raw, request_raw, self.now)
        self.assertEqual(set(files), {"canonical.original.json", "request.original.json", "canonical.prepared.json",
                                      "slot2.compose.json", "draft.json"})
        self.assertTrue(all(type(raw) is bytes for raw in files.values()))
        self.assertEqual(files["canonical.original.json"], self.raw)
        self.assertEqual(files["request.original.json"], request_raw)
        canonical = json.loads(self.raw)
        prepared = json.loads(files["canonical.prepared.json"])
        expected = copy.deepcopy(canonical)
        expected["services"]["api"]["environment"]["TRUSTED_PROXY_CIDRS"] = "172.30.92.10/32,172.30.92.20/32"
        expected["services"]["api"]["restart"] = "unless-stopped"
        self.assertEqual(prepared, expected)
        draft = json.loads(files["draft.json"])
        self.assertEqual({item["path"] for item in draft["forwardDiff"]},
                         {"/services/api/environment/TRUSTED_PROXY_CIDRS", "/services/api/restart"})
        self.assertEqual(len(draft["forwardDiff"]), 2)
        self.assertEqual(apply_diff(canonical, draft["forwardDiff"]), prepared)
        self.assertEqual(apply_diff(prepared, draft["reverseDiff"]), canonical)
        self.assertEqual(set(draft["files"]), set(files) - {"draft.json"})
        for name, pin in draft["files"].items():
            self.assertEqual(pin, {"sha256": sha(files[name]), "size": len(files[name])})

    def test_same_image_slot_is_separate_single_web_with_no_api_dependency(self):
        files = self.compile()
        canonical = json.loads(self.raw)
        slot = json.loads(files["slot2.compose.json"])
        self.assertEqual(set(slot), {"name", "services", "networks"})
        self.assertEqual(slot["name"], "citygo-web-bootstrap-" + self.request["operation_id"])
        expected = copy.deepcopy(canonical["services"]["web"])
        del expected["depends_on"]
        expected["restart"] = "unless-stopped"
        expected["ports"] = ["127.0.0.1:3001:3000"]
        expected["networks"]["web_api"]["ipv4_address"] = "172.30.92.20"
        self.assertEqual(slot["services"], {"web": expected})
        self.assertEqual(slot["networks"], {"web_api": canonical["networks"]["web_api"]})

    def test_draft_never_authorizes_operations_or_legacy_recovery(self):
        draft = json.loads(self.compile()["draft.json"])
        self.assertIs(draft["readyToApply"], False)
        self.assertIs(draft["productionPlan"], False)
        self.assertEqual(draft["authorizes"], {name: False for name in
                         ("install", "stop", "recreate", "start", "reload", "traffic", "worker", "switch", "rollback")})
        self.assertTrue(all(value is False for value in draft["authorizes"].values()))
        self.assertIs(draft["requiresFreshPostBootstrapPins"], True)
        self.assertIs(draft["legacyResumeAllowed"], False)
        self.assertTrue(draft["pendingEvidence"])
        # Opaque metadata pins bind operator assertions; the compiler neither
        # observes the machine nor upgrades those assertions to live proof.
        request = copy.deepcopy(self.request)
        request["observation_sha256"] = "d" * 64
        changed = self.compile(request=request)
        self.assertNotEqual(changed["request.original.json"], self.compile()["request.original.json"])
        self.assertIs(json.loads(changed["draft.json"])["readyToApply"], False)

    def test_operator_metadata_is_bound_without_claiming_live_or_recovery_attestation(self):
        draft = json.loads(self.compile()["draft.json"])
        self.assertEqual(draft["provenance"], {
            "kind": "operator-supplied-not-live-attestation",
            "observation_sha256": self.request["observation_sha256"],
            "inventory_sha256": self.request["baseline"]["inventory_sha256"],
            "inventory_complete": True, "observed_at": self.request["observed_at"],
            "expires_at": self.request["expires_at"]})
        for name in ("originals", "secret_pins", "baseline", "web_network"):
            self.assertEqual(draft[name], self.request[name])
        for condition in ("verify-exact-prepared-hash-before-reverse-diff",
                          "closed-ingress-and-drained-accepted-requests",
                          "fresh-runtime-identities-after-api-recreation",
                          "no-rewrite-of-legacy-active-or-current-receipts",
                          "fresh-legacy-approval-not-historical-resume",
                          "no-automatic-rollback-or-pending-removal"):
            self.assertIn(condition, draft["returnConditions"])
        for gate in ("external-reload-exclusion-through-pending-settlement",
                     "fresh-encrypted-backup-and-isolated-restore",
                     "separate-installer-and-canonical-return-reconciliation",
                     "fresh-post-bootstrap-v2-runtime-file-and-process-pins"):
            self.assertIn(gate, draft["pendingEvidence"])
        self.assertEqual(draft["expectedTopology"]["api"]["count"], 1)
        self.assertEqual(draft["expectedTopology"]["api"]["image"], self.request["images"]["api"]["id"])
        self.assertEqual(draft["expectedTopology"]["oldWeb"]["image"], self.request["images"]["web"]["id"])
        self.assertEqual(draft["expectedTopology"]["newWeb"]["image"], self.request["images"]["web"]["id"])

    def test_all_existing_legacy_profiles_keep_their_exact_environment(self):
        original = json.loads(self.raw)
        for profile in legacy.PROFILE_VERSIONS:
            with self.subTest(profile=profile):
                images = {role: {"local_id": self.request["images"][role]["id"]} for role in ("api", "web")}
                old = legacy.compose_spec("citygo-pilot", self.request["origin"], images,
                                          original["secrets"]["api_config"]["file"], profile)
                raw, request = self.changed_canonical(lambda c: c["services"]["api"].update(
                    environment=old["services"]["api"]["environment"]))
                prepared = json.loads(self.compile(canonical=raw, request=request)["canonical.prepared.json"])
                expected = {**old["services"]["api"]["environment"],
                            "TRUSTED_PROXY_CIDRS": "172.30.92.10/32,172.30.92.20/32"}
                self.assertEqual(prepared["services"]["api"]["environment"], expected)

    def test_compile_is_deterministic_and_does_not_call_io_or_transports(self):
        expected = self.compile()
        with patch("builtins.open", side_effect=AssertionError("file I/O")), \
                patch.object(Path, "read_bytes", side_effect=AssertionError("file read")), \
                patch.object(Path, "write_bytes", side_effect=AssertionError("file write")), \
                patch("subprocess.run", side_effect=AssertionError("process")), \
                patch("subprocess.Popen", side_effect=AssertionError("process")), \
                patch("socket.socket", side_effect=AssertionError("network")), \
                patch("os.system", side_effect=AssertionError("shell")), \
                patch("os.kill", side_effect=AssertionError("signal")):
            self.assertEqual(self.compile(), expected)

    def test_request_shape_purpose_types_and_unknown_authority_are_rejected(self):
        for mutate in (
            lambda r: r.update(version=True), lambda r: r.update(version=2),
            lambda r: r.update(purpose="citygo-staged-web-switch-v2"),
            lambda r: r.update(allow_switch=True), lambda r: r.update(inventory_complete=1),
            lambda r: r["images"].update(jobs=r["images"]["api"]),
            lambda r: r["baseline"].update(allow_recovery=True),
            lambda r: r["gates"].update(force=True),
            lambda r: r.update(state={"phase": "stop-requested"}),
        ):
            with self.subTest(mutate=mutate):
                self.reject_request(mutate)

    def test_freshness_is_bounded_and_inventory_cannot_be_partial(self):
        for mutate in (
            lambda r: r.update(observed_at=self.now + 1),
            lambda r: r.update(expires_at=self.now),
            lambda r: r.update(expires_at=r["observed_at"] + 3601),
            lambda r: r.update(observed_at=True), lambda r: r.update(expires_at=True),
        ):
            with self.subTest(mutate=mutate):
                self.reject_request(mutate, "request-time")
        self.reject_request(lambda r: r.update(inventory_complete=False))
        for gate in ("pending", "worker_admission_open", "autodeploy_enabled"):
            self.reject_request(lambda r, gate=gate: r["gates"].update({gate: True}), "request-gates")
            self.reject_request(lambda r, gate=gate: r["gates"].update({gate: 0}), "request-gates")

    def test_source_images_ids_origin_and_restart_baseline_fail_closed(self):
        for mutate in (
            lambda r: r.update(source_sha="main"), lambda r: r.update(operation_id="x" * 32),
            lambda r: r.update(origin="https://pilot.example.test/path"),
            lambda r: r["images"]["api"].update(id="node:latest"),
            lambda r: r["images"]["web"].update(source_sha="b" * 40),
            lambda r: r["images"]["api"].update(id="sha256:" + "b" * 64),
            lambda r: r["baseline"].update(web_id=r["baseline"]["api_id"]),
            lambda r: r["baseline"]["api_restart"].update(Name="unless-stopped"),
            lambda r: r["baseline"]["web_restart"].update(MaximumRetryCount=False),
            lambda r: r["baseline"]["postgres_restart"].update(Name="no"),
        ):
            with self.subTest(mutate=mutate):
                self.reject_request(mutate)

    def test_known_canonical_bytes_are_hash_bound(self):
        self.reject_request(lambda r: r["originals"]["compose"].update(sha256="f" * 64), "canonical-hash")
        with self.assertRaises(compiler.BootstrapError) as error:
            self.compile(canonical=self.raw + b"\n")
        self.assertEqual(str(error.exception), "canonical-hash")

    def test_paths_and_opaque_pins_are_closed_and_do_not_accept_aliases(self):
        for mutate in (
            lambda r: r["originals"]["compose"].update(path="relative/compose.json"),
            lambda r: r["originals"]["env"].update(path="//etc/citygo/backup.json"),
            lambda r: r["originals"]["env"].update(path="/" + "a" * 4096),
            lambda r: r["originals"]["env"].update(path="/tmp/../etc/empty.env"),
            lambda r: r["originals"]["env"].update(path="/tmp/$HOME/empty.env"),
            lambda r: r["originals"]["env"].update(path=r["originals"]["compose"]["path"]),
            lambda r: r["secret_pins"][0].update(sha256="not-a-hash"),
            lambda r: r["secret_pins"].append(copy.deepcopy(r["secret_pins"][0])),
            lambda r: r["secret_pins"][0].update(path="/etc/citygo/foreign.json"),
            lambda r: r["web_network"].update(name="foreign_web_api"),
            lambda r: r["web_network"].update(id="latest"),
        ):
            with self.subTest(mutate=mutate):
                self.reject_request(mutate)

    def test_unexpected_services_hooks_volumes_networks_and_secret_shapes_are_rejected(self):
        for mutate in (
            lambda c: c.update(volumes={"database": {}}),
            lambda c: c["services"].update(postgres={"image": "postgres:latest"}),
            lambda c: c["services"].pop("worker"),
            lambda c: c["services"]["web"].update(post_start=[{"command": "unsafe"}]),
            lambda c: c["services"]["api"].update(env_file=["/etc/credentials"]),
            lambda c: c["services"]["web"].update(volumes=["/var/run/docker.sock:/var/run/docker.sock"]),
            lambda c: c["services"]["web"]["networks"]["web_api"].update(aliases=["api"]),
            lambda c: c["networks"]["web_api"].update(external=False),
            lambda c: c["networks"]["database"].update(name="foreign_database"),
            lambda c: c["secrets"]["api_config"].update(environment="PRIVATE_VALUE"),
            lambda c: c["services"]["backup"]["volumes"][0].update(read_only=False),
            lambda c: c["services"]["backup"]["volumes"][0].update(source="/etc/foreign/dump.sh"),
        ):
            with self.subTest(mutate=mutate):
                self.reject_canonical(mutate)

    def test_runtime_environment_and_api_web_network_changes_are_not_reinterpreted(self):
        for mutate in (
            lambda c: c["services"]["api"].update(mem_limit=1024 ** 3),
            lambda c: c["services"]["web"].update(read_only=False),
            lambda c: c["services"]["api"].update(stop_grace_period="30s"),
            lambda c: c["services"]["web"].update(ports=["0.0.0.0:3000:3000"]),
            lambda c: c["services"]["web"]["environment"].update(PORT="3001"),
            lambda c: c["services"]["api"]["environment"].update(TRUSTED_PROXY_CIDRS="172.30.92.0/24"),
            lambda c: c["services"]["api"]["environment"].update(OPENAI_API_KEY="NEVER-EXPOSE-THIS-VALUE"),
            lambda c: c["services"]["api"]["environment"].update(API_POOL_MAX="12"),
            lambda c: c["services"]["api"]["environment"].update(CITYGO_AI_PROFILE="unknown-profile"),
            lambda c: c["services"]["web"]["networks"]["web_api"].update(ipv4_address="172.30.92.20"),
            lambda c: c["services"]["api"]["networks"]["web_api"].update(ipv4_address="172.30.92.12"),
            lambda c: c["services"]["api"].update(image="sha256:" + "f" * 64),
        ):
            with self.subTest(mutate=mutate):
                self.reject_canonical(mutate)

    def test_interpolation_control_characters_duplicate_keys_and_nonfinite_json_are_rejected(self):
        for replacement in ("${PRIVATE}", "value\nunsafe", "value\x00unsafe"):
            self.reject_canonical(lambda c, replacement=replacement:
                                  c["services"]["api"]["environment"].update(LLM_PROVIDER=replacement))
        for raw in (b'{"version":1,"version":1}', b'{"value":NaN}', b'{"value":Infinity}', b"[]", b"{"):
            with self.subTest(raw=raw), self.assertRaises(compiler.BootstrapError):
                compiler.compile_draft(self.raw, raw, self.now)
        duplicate = b'{"name":"citygo-pilot","name":"citygo-pilot"}'
        request = copy.deepcopy(self.request)
        request["originals"]["compose"]["sha256"] = sha(duplicate)
        with self.assertRaises(compiler.BootstrapError):
            self.compile(canonical=duplicate, request=request)

    def test_malformed_nested_types_are_sanitized_not_python_type_errors(self):
        for value in (None, [], "unexpected", 1, True):
            with self.subTest(top=value), self.assertRaises(compiler.BootstrapError):
                compiler.compile_draft(self.raw, encoded(value), self.now)
            raw = encoded(value)
            request = copy.deepcopy(self.request)
            request["originals"]["compose"]["sha256"] = sha(raw)
            with self.subTest(canonical_top=value), self.assertRaises(compiler.BootstrapError):
                self.compile(canonical=raw, request=request)
        for mutate in (
            lambda c: c["services"].update(api=[]),
            lambda c: c["services"]["api"].update(environment=[]),
            lambda c: c["services"]["api"]["environment"].update(CITYGO_AI_PROFILE=[]),
            lambda c: c["services"]["api"]["environment"].update(CITYGO_AI_PROFILE={}),
            lambda c: c["services"]["api"].update(healthcheck=[]),
            lambda c: c["services"]["backup"].update(volumes={}),
            lambda c: c["secrets"].update(api_config=[]),
            lambda c: c["services"]["web"].update(memswap_limit=True),
        ):
            with self.subTest(mutate=mutate):
                self.reject_canonical(mutate)
        for mutate in (
            lambda r: r.update(images=[]), lambda r: r.update(baseline=[]),
            lambda r: r.update(originals=[]), lambda r: r.update(secret_pins={}),
            lambda r: r.update(web_network=[]), lambda r: r.update(gates=[]),
        ):
            with self.subTest(mutate=mutate):
                self.reject_request(mutate)
        for now in (None, True, 1.5, "2000000000"):
            with self.subTest(now=now), self.assertRaises(compiler.BootstrapError):
                compiler.compile_draft(self.raw, encoded(self.request), now)

    def test_bounded_bytes_and_errors_never_echo_input_values(self):
        for raw in (b"", b"x" * (1024 ** 2 + 1), "not-bytes"):
            with self.subTest(kind=type(raw)), self.assertRaises(compiler.BootstrapError):
                compiler.compile_draft(raw, encoded(self.request), self.now)
            with self.subTest(kind=type(raw)), self.assertRaises(compiler.BootstrapError):
                compiler.compile_draft(self.raw, raw, self.now)
        marker = "DO-NOT-ECHO-SYNTHETIC-CREDENTIAL"
        request = {**self.request, marker: marker}
        with self.assertRaises(compiler.BootstrapError) as error:
            self.compile(request=request)
        self.assertNotIn(marker, str(error.exception))
        self.assertRegex(str(error.exception), r"^[a-z][a-z0-9-]+$")

    def test_generated_output_is_bounded_even_when_compact_inputs_fit(self):
        canonical_raw = json.dumps(json.loads(self.raw), separators=(",", ":")).encode()
        request = copy.deepcopy(self.request)
        request["originals"]["compose"]["sha256"] = sha(canonical_raw)
        request_raw = json.dumps(request, separators=(",", ":")).encode()
        input_limit = max(len(canonical_raw), len(request_raw))
        outputs = compiler.compile_draft(canonical_raw, request_raw, self.now)
        self.assertGreater(max(map(len, outputs.values())), input_limit)
        with patch.object(compiler, "LIMIT", input_limit), self.assertRaises(compiler.BootstrapError) as error:
            compiler.compile_draft(canonical_raw, request_raw, self.now)
        self.assertEqual(str(error.exception), "output-size")


if __name__ == "__main__":
    unittest.main()
