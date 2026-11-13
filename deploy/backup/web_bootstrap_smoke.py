#!/usr/bin/env python3
"""Synthetic Compose CONFIG validation only; default execution is inert.

--disposable uses the test fixture, private temporary files and three local
`docker compose config` calls. It does not contact a Docker daemon, execute a
generated service, read live configuration or attest production compatibility.
"""
import copy
from contextlib import contextmanager
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


MAX_OUTPUT = 2 * 1024 * 1024
TIMEOUT = 60
COMPOSE_FILES = ("canonical.original.json", "canonical.prepared.json", "slot2.compose.json")
OUTPUT_FILES = frozenset((*COMPOSE_FILES, "request.original.json", "draft.json"))
OLD_CIDR = "172.30.92.10/32"
NEW_CIDRS = OLD_CIDR + ",172.30.92.20/32"
API_DIFFS = frozenset(("/services/api/environment/TRUSTED_PROXY_CIDRS", "/services/api/restart"))


class SmokeError(Exception):
    """Only fixed redacted diagnostics leave the smoke process."""


def require(condition, code):
    if not condition:
        raise SmokeError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def strict_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_OUTPUT, "smoke-output-size")

    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "smoke-output-json")
            value[key] = item
        return value

    def constant(_):
        raise SmokeError("smoke-output-json")

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        require(type(value) is dict, "smoke-output-json")
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise SmokeError("smoke-output-json") from None


def diff_paths(old, new, path=""):
    """Exact, type-sensitive structural comparison of bounded synthetic JSON."""
    if type(old) is not type(new):
        return {path}
    if type(old) is dict:
        changed = set()
        for key in old.keys() | new.keys():
            child = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key not in old or key not in new:
                changed.add(child)
            else:
                changed.update(diff_paths(old[key], new[key], child))
        return changed
    if type(old) is list:
        if len(old) != len(new):
            return {path}
        changed = set()
        for index, (before, after) in enumerate(zip(old, new)):
            changed.update(diff_paths(before, after, path + "/" + str(index)))
        return changed
    return set() if old == new else {path}


def verify_normalized(original, prepared, slot, request):
    """Reject extra normalized changes rather than masking them from a diff."""
    require(all(type(item) is dict for item in (original, prepared, slot)), "smoke-config-schema")
    require(original.get("name") == prepared.get("name") == "citygo-pilot", "smoke-project")
    services = original.get("services")
    require(type(services) is dict and set(services) == {"api", "web", "worker", "backup"}
            and type(prepared.get("services")) is dict and set(prepared["services"]) == set(services),
            "smoke-services")
    require(diff_paths(original, prepared) == API_DIFFS, "smoke-api-delta")
    old_api, new_api = services["api"], prepared["services"]["api"]
    require(old_api["restart"] == "no" and new_api["restart"] == "unless-stopped"
            and old_api["environment"]["TRUSTED_PROXY_CIDRS"] == OLD_CIDR
            and new_api["environment"]["TRUSTED_PROXY_CIDRS"] == NEW_CIDRS, "smoke-api-values")
    require(old_api["image"] == new_api["image"] == request["images"]["api"]["id"], "smoke-api-image")
    require(set(slot) == {"name", "services", "networks"}
            and slot["name"] == "citygo-web-bootstrap-" + request["operation_id"]
            and type(slot["services"]) is dict and set(slot["services"]) == {"web"}, "smoke-slot-topology")
    require(slot["networks"] == {"web_api": original["networks"]["web_api"]}
            and slot["networks"]["web_api"].get("external") is True, "smoke-slot-network")
    old_web, new_web = services["web"], slot["services"]["web"]
    require(old_web["image"] == new_web["image"] == request["images"]["web"]["id"], "smoke-slot-image")
    require(old_web["restart"] == "no" and set(old_web["networks"]) == {"web_api"}
            and old_web["networks"]["web_api"]["ipv4_address"] == "172.30.92.10"
            and set(old_web["depends_on"]) == {"api"}, "smoke-old-slot")
    ports = old_web["ports"]
    require(type(ports) is list and len(ports) == 1 and type(ports[0]) is dict
            and ports[0].get("host_ip") == "127.0.0.1" and ports[0].get("target") == 3000
            and type(ports[0].get("target")) is int and ports[0].get("published") == "3000"
            and ports[0].get("protocol") == "tcp", "smoke-slot-port")
    expected_web = copy.deepcopy(old_web)
    del expected_web["depends_on"]
    expected_web["restart"] = "unless-stopped"
    expected_web["ports"][0]["published"] = "3001"
    expected_web["networks"]["web_api"]["ipv4_address"] = "172.30.92.20"
    require(new_web == expected_web, "smoke-slot-delta")
    # Everything outside the two API fields is byte-equivalent as normalized
    # JSON, including ops services, secret paths, profile, networks and images.
    immutable = copy.deepcopy(prepared)
    immutable["services"]["api"]["restart"] = old_api["restart"]
    immutable["services"]["api"]["environment"]["TRUSTED_PROXY_CIDRS"] = OLD_CIDR
    require(wire(immutable) == wire(original), "smoke-runtime-invariant")
    return {"apiDeltaPaths": sorted(API_DIFFS), "singletonApi": True,
            "databaseAndOpsUnchanged": True, "runtimeProfileAndSecretReferencesUnchanged": True,
            "sameWebImage": True, "slotOnlyWeb": True, "noDaemonCommands": True,
            "productionRuntimeVerified": False, "tariffContentsVerified": False}


def system_path():
    if os.name == "nt":
        return r"C:\Windows\System32;C:\Windows;C:\Program Files\Docker\Docker\resources\bin"
    return "/usr/local/bin:/usr/bin:/bin"


def find_docker():
    executable = shutil.which("docker", path=system_path())
    require(executable is not None, "smoke-compose-unavailable")
    return str(Path(executable).resolve())


def limited_environment(directory):
    """No inherited daemon/context/proxy/plugin/env-file configuration."""
    root = Path(directory)
    home, config = root / "home", root / "docker-config"
    home.mkdir(mode=0o700)
    config.mkdir(mode=0o700)
    (config / "config.json").write_bytes(b"{}\n")
    environment = {"PATH": system_path(), "HOME": str(home), "USERPROFILE": str(home),
                   "DOCKER_CONFIG": str(config), "XDG_CONFIG_HOME": str(home / ".config"),
                   "COMPOSE_DISABLE_ENV_FILE": "1", "LANG": "C", "LC_ALL": "C"}
    if os.name == "nt":
        environment.update({"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows",
                            "TEMP": str(root), "TMP": str(root)})
    else:
        environment["TMPDIR"] = str(root)
    return environment


@contextmanager
def output_stream(directory):
    # delete=False avoids the Windows delete-on-close flag; the enclosing
    # private directory plus exact-path finally cleanup is portable.
    stream = tempfile.NamedTemporaryFile(dir=directory, delete=False)
    path = Path(stream.name)
    try:
        yield stream
    finally:
        stream.close()
        path.unlink(missing_ok=True)


def command_output(command, directory, environment):
    """No shell, no live working directory and no unbounded captured logs."""
    with output_stream(directory) as output, output_stream(directory) as errors:
        try:
            result = subprocess.run(command, cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=errors, shell=False, check=False, timeout=TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            raise SmokeError("smoke-compose-process") from None
        require(result.returncode == 0, "smoke-compose-failed")
        output.seek(0, os.SEEK_END)
        require(0 < output.tell() <= MAX_OUTPUT, "smoke-output-size")
        errors.seek(0, os.SEEK_END)
        require(errors.tell() <= MAX_OUTPUT, "smoke-output-size")
        output.seek(0)
        return output.read(MAX_OUTPUT + 1)


def compile_fixture():
    compiler = importlib.import_module("web_bootstrap")
    fixtures = importlib.import_module("test_web_bootstrap")
    canonical, request, now = fixtures.fixture()
    request_raw = wire(request)
    try:
        files = compiler.compile_draft(canonical, request_raw, now)
    except compiler.BootstrapError:
        raise SmokeError("smoke-fixture-rejected") from None
    return files, canonical, request_raw, request


def disposable():
    files, canonical_raw, request_raw, request = compile_fixture()
    require(type(files) is dict and set(files) == OUTPUT_FILES, "smoke-compiled-files")
    require(files["canonical.original.json"] == canonical_raw
            and files["request.original.json"] == request_raw, "smoke-original-bytes")
    for raw in files.values():
        require(type(raw) is bytes and 0 < len(raw) <= MAX_OUTPUT, "smoke-compiled-files")
    draft = strict_json(files["draft.json"])
    require(draft.get("readyToApply") is False and draft.get("productionPlan") is False
            and type(draft.get("authorizes")) is dict and len(draft["authorizes"]) > 0
            and all(value is False for value in draft["authorizes"].values()), "smoke-authority")
    require(draft["files"] == {name: {"sha256": digest(raw), "size": len(raw)}
                               for name, raw in files.items() if name != "draft.json"}, "smoke-compiled-pins")
    docker = find_docker()
    with tempfile.TemporaryDirectory(prefix="citygo-bootstrap-compose-") as directory:
        root = Path(directory)
        environment = limited_environment(root)
        empty_env = root / "empty.env"
        empty_env.write_bytes(b"")
        version_raw = command_output([docker, "compose", "version", "--short"], directory, environment)
        try:
            version = version_raw.decode("ascii").strip()
        except UnicodeError:
            raise SmokeError("smoke-compose-version") from None
        require(re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version) is not None,
                "smoke-compose-version")
        normalized = {}
        for name in COMPOSE_FILES:
            path = root / name
            path.write_bytes(files[name])
            raw = command_output([docker, "compose", "--env-file", str(empty_env), "--project-directory", directory,
                                  "--profile", "ops", "--file", str(path), "config", "--no-interpolate", "--format", "json"],
                                 directory, environment)
            normalized[name] = strict_json(raw)
        proofs = verify_normalized(*(normalized[name] for name in COMPOSE_FILES), request)
    return {"purpose": "citygo-web-bootstrap-synthetic-compose-smoke-v1", "status": "passed",
            "syntheticOnly": True, "serverAccess": False, "deploymentAuthorization": False,
            "readyToApply": False, "composeVersion": version, "proofs": proofs,
            "files": {name: {"sha256": digest(raw), "size": len(raw)} for name, raw in sorted(files.items())},
            "normalized": {name: {"sha256": digest(wire(value))} for name, value in sorted(normalized.items())}}


def run(args):
    if args in ([], ["--plan"]):
        return {"purpose": "citygo-web-bootstrap-synthetic-compose-smoke-v1", "executes": False,
                "writes": False, "serverAccess": False, "readyToApply": False,
                "deploymentAuthorization": False, "execution": "--disposable",
                "commands": ["docker compose version --short", "docker compose config (three synthetic files only)"]}
    require(args == ["--disposable"], "smoke-arguments")
    return disposable()


def main(args=None):
    try:
        print(json.dumps(run(sys.argv[1:] if args is None else args), sort_keys=True))
        return 0
    except (SmokeError, OSError, ValueError, KeyError, TypeError, ImportError):
        print('{"error":"bootstrap-synthetic-smoke-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
