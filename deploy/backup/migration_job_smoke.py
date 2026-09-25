"""Disposable CI only: real retained jobs container, stdin, PG/age, local S3."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

import backup as b
import migration_job as m
import release as r
from test_backup import MemoryStore, sample
from test_image_gate import FakeStore, inspection


def main():
    b.require(len(sys.argv) == 3 and sys.argv[1] == "--disposable", "disposable-required")
    os.umask(0o077)
    fixture = json.loads(Path(sys.argv[2]).read_bytes())
    b.require(re.fullmatch(r"citygo-pilot-test-[a-f0-9]{12}", fixture["project"]), "disposable-required")
    b.require(m.t.matches(fixture["image_id"], m.t.DIGEST) and m.t.matches(fixture["network_id"], m.t.HASH), "fixture-identity")
    ids = []
    with tempfile.TemporaryDirectory(prefix="migration-job-fixture-") as tmp:
        directory = Path(tmp)
        compose = directory / "compose.yml"
        compose.write_text(json.dumps(fixture["compose"])); compose.chmod(0o600)
        (directory / "pilot.env").write_bytes(b"# fixture\n"); (directory / "pilot.env").chmod(0o600)
        env = b.clean_env(directory)
        identity = directory / "identity.txt"
        b.run([b.executable("age-keygen"), "-o", str(identity)], env)
        recipient = subprocess.check_output([b.executable("age-keygen"), "-y", str(identity)], env=env, text=True).strip()
        source = fixture["plan"]["targetSha"]
        reference = "ghcr.io/citygo-tech/citygo-platform-jobs@sha256:" + "d" * 64
        store = FakeStore()
        # Real tested local image, synthetic registry binding only. Real registry
        # provenance is covered by registry-smoke, not claimed by this fixture.
        store.values[reference] = inspection(reference, fixture["image_id"], source)
        for failure in (False, True):
            state = directory / ("failed" if failure else "success"); state.mkdir(mode=0o700)
            config = b.validate({**sample(directory), "project": fixture["project"], "recipient": recipient,
                                 "state_dir": str(state)})
            transport = None
            def factory(cfg, path):
                nonlocal transport
                transport = m.Docker(cfg, path)
                return transport
            def guard():
                # Fixture starts no Web/API/Worker yet. Verify only PostgreSQL
                # is running on this synthetic project; no live ingress claimed.
                result = subprocess.check_output([b.executable("docker"), "ps", "--format",
                    '{{.Label "com.docker.compose.service"}}', "--filter", "label=com.docker.compose.project=" + config["project"]], env=env, text=True)
                b.require(result.splitlines() == ["postgres"], "fixture-writer-active")
                with_asserted = False
                try:
                    with b.lock(state): pass
                except b.BackupError as error:
                    with_asserted = str(error) == "already-running"
                b.require(with_asserted, "fixture-lock-not-held")
            with r.release_window(config, source) as window:
                objects = MemoryStore()
                window.backup(storage_factory=lambda *_: objects, min_free=0)
                b.require(len(objects.objects) == 2, "fixture-backup")
                request = copy.deepcopy(fixture["plan"])
                request["operationId"] = str(uuid.UUID(window._operation["id"]))
                if failure:
                    request["currentMigrations"] = request["targetMigrations"]
                    request["grantsSha256"] = "f" * 64
                args = (window, request, reference, fixture["image_id"], fixture["network_id"], fixture["secret"])
                options = dict(allow_migration=True, guard=guard, transport_factory=factory, image_store_factory=lambda _: store)
                if failure:
                    try: m._execute_in_window(*args, **options)
                    except b.BackupError: pass
                    else: raise b.BackupError("fixture-failure-accepted")
                    b.require(not list(state.glob("*.success.json")), "fixture-false-success")
                else:
                    proof = m._execute_in_window(*args, **options)
                    b.require(proof["result"]["committed"] is True and proof["traffic_authorized"] is False, "fixture-result")
                try: m._execute_in_window(*args, **options)
                except b.BackupError as error: b.require(str(error) == "migration-already-attempted", "fixture-retry-reason")
                else: raise b.BackupError("fixture-retry")
            b.require((state / "operation-pending.json").exists(), "fixture-pending")
            created = json.loads(next(state.glob("*.container.json")).read_bytes())
            ident = created["container_id"]; ids.append(ident)
            observed = transport.inspect(ident)
            b.require(observed["State"]["Status"] == "exited"
                      and observed["State"]["ExitCode"] == (1 if failure else 0), "fixture-exit")
            b.require(len(list(state.glob("*.intent.json"))) == 1, "fixture-intent")
        print(json.dumps({"ok": True, "containers": ids}))


if __name__ == "__main__": main()
