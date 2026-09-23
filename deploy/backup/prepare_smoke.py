"""Disposable CI only: real host TLS, API stop and pg_dump/age; local S3 fixture."""
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tempfile

import backup as b
import prepare as p
import worker as w
from test_backup import MemoryStore
from test_target import synthetic_selection


def main():
    b.require(len(sys.argv) == 3 and sys.argv[1] == "--disposable", "disposable-required")
    os.umask(0o077)
    path = b.protected(sys.argv[2])
    fixture = b.read_json(path)
    base = fixture["backup"]
    b.require(re.fullmatch(r"citygo-pilot-test-[0-9a-f]{12}", base["project"]), "disposable-required")
    b.require(fixture["origin"] == "https://pilot.example.test"
              and Path(fixture["ingress_directory"]) == path.parent / "ingress"
              and Path(base["compose_env"]) == path.parent / "backup.env", "disposable-required")
    b.require(type(fixture.get("worker_id")) is str
              and re.fullmatch(r"[0-9a-f]{64}", fixture["worker_id"]), "fixture-worker-id")
    with tempfile.TemporaryDirectory(prefix="prepare-fixture-", dir=path.parent) as temp:
        directory = Path(temp)
        state = directory / "state"; state.mkdir(mode=0o700)
        identity = directory / "identity.txt"
        env = b.clean_env(directory)
        b.run([b.executable("age-keygen"), "-o", str(identity)], env)
        recipient = subprocess.check_output([b.executable("age-keygen"), "-y", str(identity)], env=env, text=True).strip()
        config = b.validate({**base, "version": 1, "upload_enabled": True,
            "state_dir": str(state), "recipient": recipient, "storage_credentials_file": str(directory / "unused"),
            "endpoint": b.ENDPOINT, "bucket": "synthetic-no-upload", "prefix": "citygo/fixture"})
        observed = {"worker_exit_race_verified": False}
        class FixtureHost(p.Host):
            def __init__(self, *args):
                super().__init__(*args)
                # Trust only this synthetic certificate; verification stays ON.
                self.context = ssl.create_default_context(cafile=fixture["certificate"])
                self.first_inventory = None

            def inventory(self):
                values = super().inventory()
                if self.first_inventory is None:
                    self.first_inventory = p.validate_inventory(values, base["project"], fixture["images"], initial=True)
                return values

            def database_network(self):
                if not observed["worker_exit_race_verified"]:
                    # ONLY the disposable latch created above, never a server
                    # Worker. No timing assumption or real job/DB mutation.
                    worker = self.first_inventory.get(fixture["worker_id"], {})
                    b.require(worker.get("Name") == "/" + base["project"] + "-prepare-worker"
                              and worker.get("Labels", {}).get("com.docker.compose.service") == "worker"
                              and worker.get("State", {}).get("Running") is True, "fixture-worker-target")
                    original = super().database_network()
                    p.check_network(original, self.first_inventory)
                    super().stop_writer(worker)
                    stopped = self.inspect(worker["Id"])
                    b.require(p.identity(stopped) == p.identity(worker), "fixture-worker-replaced")
                    p.stopped_cleanly(stopped)
                    network = super().database_network()
                    b.require(worker["Id"] not in network["peers"], "fixture-worker-endpoint-retained")
                    # Negative control: the old strict two-read check MUST fail
                    # on this exact real Docker state before reconciliation.
                    try:
                        p.check_network(network, self.first_inventory, original)
                    except b.BackupError as error:
                        b.require(str(error) == "database-network-missing-peer", "fixture-race-reason")
                    else:
                        raise b.BackupError("fixture-race-not-reproduced")
                    observed["worker_exit_race_verified"] = True
                    return network
                return super().database_network()
        store = MemoryStore()
        # This is a synthetic offline approval fixture, NOT GitHub provenance or
        # authorization for the user's server. No target file is ever executed.
        selection = synthetic_selection(directory, config, fixture["images"], fixture["origin"])
        w.open_admission(config)
        proof = p.prepare(config, "b" * 40, fixture["origin"], fixture["ingress_directory"], fixture["images"],
            allow_stop=True, allow_upload=True, selection=selection, host_factory=FixtureHost, storage_factory=lambda *_: store)
        b.require(proof["migration_authorized"] is False and (state / "operation-pending.json").exists(), "fixture-pending")
        b.require(not (state / w.ADMISSION).exists(), "fixture-admission")
        b.require(not (Path(fixture["ingress_directory"]) / "traffic-open").exists(), "fixture-ingress")
        try:
            w.open_admission(config)
        except b.BackupError as error:
            b.require(str(error) == "operation-unsettled", "fixture-pending")
        else:
            raise b.BackupError("fixture-reopened")
        archive = directory / "readback.age"
        archive.write_bytes(store.objects[proof["backup"]["key"]])
        dump = subprocess.check_output([b.executable("age"), "--decrypt", "-i", str(identity), str(archive)],
                                       env=env, stderr=subprocess.DEVNULL, timeout=60)
        b.require(dump.startswith(b"PGDMP") and len(store.objects) == 2, "fixture-dump")
        b.require(b.read_json(state / "release-prepared.json") == proof, "fixture-receipt")
        b.require(proof["target"]["artifact_id"] == "456" and proof["target"]["migration_authorized"] is False, "fixture-target")
        b.require(observed["worker_exit_race_verified"], "fixture-race-not-reproduced")
        print(json.dumps({"ok": True, "migration_authorized": False, **observed,
                          "roles": sorted(v["role"] for v in proof["containers"])}))


if __name__ == "__main__": main()
