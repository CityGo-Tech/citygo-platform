"""Synthetic smoke contract tests; no executable, Docker or network is used."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import web_bootstrap_smoke as smoke


def compiled():
    files, canonical_raw, request_raw, request = smoke.compile_fixture()
    return files, canonical_raw, request_raw, request


def normalized(files):
    """Model only Compose syntax normalization, never a real parser substitute."""
    result = []
    for name in smoke.COMPOSE_FILES:
        item = json.loads(files[name])
        for service in item["services"].values():
            if "ports" in service:
                host, published, target = service["ports"][0].split(":")
                service["ports"] = [{"host_ip": host, "published": published, "target": int(target),
                                     "protocol": "tcp", "mode": "ingress"}]
            if "depends_on" in service:
                for dependency in service["depends_on"].values():
                    dependency["restart"] = False
        result.append(item)
    return result


class SyntheticComposeSmoke(unittest.TestCase):
    def test_default_and_plan_do_not_import_fixture_or_execute_or_write(self):
        with patch.object(smoke.importlib, "import_module") as imports, \
                patch.object(smoke.subprocess, "run") as execute, \
                patch.object(smoke.tempfile, "TemporaryDirectory") as directory, \
                patch.object(smoke, "disposable") as disposable:
            for args in ([], ["--plan"]):
                value = smoke.run(args)
                self.assertFalse(value["executes"])
                self.assertFalse(value["writes"])
                self.assertFalse(value["serverAccess"])
                self.assertFalse(value["readyToApply"])
                self.assertFalse(value["deploymentAuthorization"])
            imports.assert_not_called()
            execute.assert_not_called()
            directory.assert_not_called()
            disposable.assert_not_called()

    def test_unknown_duplicate_or_mutating_flags_reject_before_fixture(self):
        with patch.object(smoke, "disposable") as disposable:
            for args in (["--apply"], ["--draft"], ["--disposable", "--file", "/etc/live.json"],
                         ["--plan", "--disposable"], ["--disposable", "--disposable"], ["--up"]):
                with self.subTest(args=args), self.assertRaises(smoke.SmokeError):
                    smoke.run(args)
            disposable.assert_not_called()

    def test_normalized_exact_two_api_changes_and_single_same_image_web(self):
        files, _, _, request = compiled()
        proof = smoke.verify_normalized(*normalized(files), request)
        self.assertEqual(proof["apiDeltaPaths"], sorted(smoke.API_DIFFS))
        for name in ("singletonApi", "databaseAndOpsUnchanged", "runtimeProfileAndSecretReferencesUnchanged",
                     "sameWebImage", "slotOnlyWeb", "noDaemonCommands"):
            self.assertTrue(proof[name])
        self.assertFalse(proof["productionRuntimeVerified"])
        self.assertFalse(proof["tariffContentsVerified"])

    def test_extra_api_billing_profile_or_secret_change_is_not_masked(self):
        files, _, _, request = compiled()
        mutations = (
            lambda value: value["services"]["api"]["environment"].update({"CITYGO_AI_PROFILE": "changed"}),
            lambda value: value["services"]["api"].update({"image": "sha256:" + "f" * 64}),
            lambda value: value["secrets"]["api_config"].update({"file": "/other/api.json"}),
            lambda value: value["services"]["worker"].update({"restart": "always"}),
            lambda value: value["networks"]["database"].update({"name": "other_database"}),
            lambda value: value["services"].update({"postgres": {"image": "postgres"}}),
            lambda value: value.update({"volumes": {"new_db": {}}}),
        )
        for mutate in mutations:
            original, prepared, slot = normalized(files)
            mutate(prepared)
            with self.subTest(mutate=mutate), self.assertRaises(smoke.SmokeError):
                smoke.verify_normalized(original, prepared, slot, request)

    def test_slot_rejects_extra_api_external_network_public_port_or_security_change(self):
        files, _, _, request = compiled()
        mutations = (
            lambda value: value["services"].update({"api": {}}),
            lambda value: value.update({"secrets": {"api_config": {"file": "/private/api.json"}}}),
            lambda value: value["networks"].update({"database": {"external": True}}),
            lambda value: value["networks"]["web_api"].update({"external": False}),
            lambda value: value["services"]["web"]["networks"].update({"database": {}}),
            lambda value: value["services"]["web"]["ports"][0].update({"host_ip": "0.0.0.0"}),
            lambda value: value["services"]["web"].update({"read_only": False}),
            lambda value: value["services"]["web"].update({"restart": "always"}),
            lambda value: value["services"]["web"].update({"image": "sha256:" + "f" * 64}),
            lambda value: value["services"]["web"].update({"depends_on": {"api": {}}}),
        )
        for mutate in mutations:
            original, prepared, slot = normalized(files)
            mutate(slot)
            with self.subTest(mutate=mutate), self.assertRaises(smoke.SmokeError):
                smoke.verify_normalized(original, prepared, slot, request)

    def test_type_sensitive_diff_does_not_equate_boolean_with_integer(self):
        self.assertEqual(smoke.diff_paths({"n": 1}, {"n": True}), {"/n"})
        self.assertEqual(smoke.diff_paths({"a/b": 1}, {"a/b": 2}), {"/a~1b"})

    def test_environment_discards_remote_context_proxy_credentials_and_user_config(self):
        hostile = {"DOCKER_HOST": "tcp://remote.invalid:2375", "DOCKER_CONTEXT": "production",
                   "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "/private/certs",
                   "DOCKER_CONFIG": "/private/docker", "DOCKER_CLI_PLUGIN_EXTRA_DIRS": "/private/plugin",
                   "HTTP_PROXY": "https://proxy.invalid", "HTTPS_PROXY": "https://proxy.invalid",
                   "ALL_PROXY": "https://proxy.invalid", "COMPOSE_FILE": "/private/compose.yml",
                   "COMPOSE_PROFILES": "production", "COMPOSE_ENV_FILES": "/private/live.env",
                   "HOME": "/private/home", "PATH": "/private/bin", "AWS_SECRET_ACCESS_KEY": "sentinel"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, hostile, clear=True):
            environment = smoke.limited_environment(directory)
            self.assertEqual(environment["PATH"], smoke.system_path())
            self.assertEqual(environment["COMPOSE_DISABLE_ENV_FILE"], "1")
            self.assertEqual(environment["HOME"], str(Path(directory) / "home"))
            self.assertEqual(environment["DOCKER_CONFIG"], str(Path(directory) / "docker-config"))
            for name in hostile.keys() - {"DOCKER_CONFIG", "HOME", "PATH"}:
                self.assertNotIn(name, environment)
            self.assertEqual((Path(environment["DOCKER_CONFIG"]) / "config.json").read_bytes(), b"{}\n")

    def test_docker_lookup_uses_only_fixed_system_path(self):
        with patch.object(smoke.shutil, "which", return_value=None) as which:
            with self.assertRaises(smoke.SmokeError):
                smoke.find_docker()
            which.assert_called_once_with("docker", path=smoke.system_path())

    def test_disposable_issues_only_four_fixed_no_shell_commands_and_removes_temp(self):
        files, canonical_raw, request_raw, request = compiled()
        expected = normalized(files)
        calls, temporary = [], []

        def execute(command, **kwargs):
            calls.append((command, kwargs.copy()))
            directory = Path(kwargs["cwd"])
            temporary.append(directory)
            self.assertTrue(directory.name.startswith("citygo-bootstrap-compose-"))
            self.assertFalse(kwargs["shell"])
            self.assertFalse(kwargs["check"])
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            self.assertEqual(kwargs["timeout"], 60)
            self.assertEqual(Path(kwargs["env"]["HOME"]).parent, directory)
            if command[1:] == ["compose", "version", "--short"]:
                kwargs["stdout"].write(b"2.40.3\n")
            else:
                index = len(calls) - 2
                path = directory / smoke.COMPOSE_FILES[index]
                self.assertEqual(command, ["/fixed/docker", "compose", "--env-file", str(directory / "empty.env"),
                                           "--project-directory", str(directory), "--profile", "ops", "--file", str(path),
                                           "config", "--no-interpolate", "--format", "json"])
                self.assertEqual((directory / "empty.env").read_bytes(), b"")
                self.assertEqual(path.read_bytes(), files[smoke.COMPOSE_FILES[index]])
                kwargs["stdout"].write(smoke.wire(expected[index]))
            return SimpleNamespace(returncode=0)

        with patch.object(smoke, "compile_fixture", return_value=(files, canonical_raw, request_raw, request)), \
                patch.object(smoke, "find_docker", return_value="/fixed/docker"), \
                patch.object(smoke.subprocess, "run", side_effect=execute):
            result = smoke.run(["--disposable"])
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(not directory.exists() for directory in temporary))
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["composeVersion"], "2.40.3")
        self.assertFalse(result["serverAccess"])
        self.assertFalse(result["deploymentAuthorization"])
        self.assertFalse(result["readyToApply"])
        self.assertEqual(set(result["files"]), set(files))
        self.assertNotIn(request["origin"], json.dumps(result))
        self.assertNotIn("fixture-api.json", json.dumps(result))

    def test_modified_original_or_pin_or_authority_rejected_before_compose(self):
        for mutation in ("original", "pin", "authority"):
            files, canonical_raw, request_raw, request = compiled()
            files = copy.deepcopy(files)
            if mutation == "original":
                files["canonical.original.json"] += b" "
            else:
                draft = json.loads(files["draft.json"])
                if mutation == "pin":
                    draft["files"]["slot2.compose.json"]["sha256"] = "f" * 64
                else:
                    draft["authorizes"]["start"] = True
                files["draft.json"] = smoke.wire(draft)
            with self.subTest(mutation=mutation), \
                    patch.object(smoke, "compile_fixture", return_value=(files, canonical_raw, request_raw, request)), \
                    patch.object(smoke, "find_docker") as find:
                with self.assertRaises(smoke.SmokeError):
                    smoke.disposable()
                find.assert_not_called()

    def test_config_failure_timeout_output_limit_and_redacted_main(self):
        with tempfile.TemporaryDirectory() as directory:
            for failure in (OSError("private path sentinel"), subprocess.TimeoutExpired(["private"], 60)):
                with patch.object(smoke.subprocess, "run", side_effect=failure), self.assertRaises(smoke.SmokeError):
                    smoke.command_output(["/fixed/docker", "compose", "version", "--short"], directory, {})
            for raw, code in ((b"version\n", 1), (b"x" * (smoke.MAX_OUTPUT + 1), 0), (b"", 0)):
                def execute(command, **kwargs):
                    kwargs["stdout"].write(raw)
                    kwargs["stderr"].write(b"private path sentinel")
                    return SimpleNamespace(returncode=code)
                with patch.object(smoke.subprocess, "run", side_effect=execute), self.assertRaises(smoke.SmokeError):
                    smoke.command_output(["/fixed/docker", "compose", "version", "--short"], directory, {})
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(smoke, "run", side_effect=smoke.SmokeError("private path sentinel")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(smoke.main(["--disposable"]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(errors.getvalue()), {"error": "bootstrap-synthetic-smoke-rejected"})

    def test_duplicate_nonfinite_nonobject_and_oversized_json_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'[]', b'null', b'not-json',
                    b'{}' + b' ' * smoke.MAX_OUTPUT):
            with self.subTest(raw=raw[:50]), self.assertRaises(smoke.SmokeError):
                smoke.strict_json(raw)


if __name__ == "__main__":
    unittest.main()
