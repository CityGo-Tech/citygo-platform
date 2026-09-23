"""Called ONLY by disposable Linux CI. Real pg_dump/age; local S3 transport fixture.

Returns the decrypted synthetic dump in stdout to the parent's isolated restore.
There are no real cloud credentials or outgoing object-storage requests.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import backup as b
import release as r
import worker as w
from test_backup import MemoryStore


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--disposable":
        raise RuntimeError("Explicit disposable fixture required")
    os.umask(0o077)
    fixture = b.read_json(b.protected(sys.argv[2]))
    if not fixture["project"].startswith("citygo-pilot-test-"):
        raise RuntimeError("Disposable project required")
    with tempfile.TemporaryDirectory(prefix="citygo-backup-restore-test-") as temp:
        directory = Path(temp)
        state = directory / "state"
        state.mkdir(mode=0o700)
        identity = directory / "recovery-identity.txt"
        env = b.clean_env(directory)
        b.run([b.executable("age-keygen"), "-o", str(identity)], env)
        recipient = subprocess.check_output([b.executable("age-keygen"), "-y", str(identity)], env=env, text=True).strip()
        config = b.validate({
            **fixture, "version": 1, "upload_enabled": True,
            "state_dir": str(state), "recipient": recipient,
            "storage_credentials_file": str(directory / "not-used.json"),
            "endpoint": b.ENDPOINT, "bucket": "citygo-disposable-fixture", "prefix": "citygo/fixture",
        })
        store = MemoryStore()
        result = b.perform_backup(config, storage_factory=lambda *_: store)
        b.check_freshness(config)
        # Exercise the real dump/encryption pipeline inside one continuous lease.
        # This harness does NOT claim application quiescence or migrate anything.
        with r.release_window(config, "b" * 40) as window:
            checkpoint = window.backup(storage_factory=lambda *_: store)
            result = checkpoint["backup"]
            if checkpoint["migration_authorized"] is not False:
                raise RuntimeError("Backup must not authorize migration")
            for action in (lambda: b.perform_backup(config), lambda: w.open_admission(config)):
                try:
                    action()
                except b.BackupError as error:
                    if str(error) != "already-running": raise
                else:
                    raise RuntimeError("Release window released its lock too early")
        try:
            w.open_admission(config)
        except b.BackupError as error:
            if str(error) != "operation-unsettled": raise
        else:
            raise RuntimeError("Finished checkpoint reopened admission")
        ciphertext = store.objects[result["key"]]
        if not ciphertext.startswith(b"age-encryption.org/v1\n"):
            raise RuntimeError("Not an age archive")
        archive = directory / "downloaded.age"
        archive.write_bytes(ciphertext)
        # Authenticate the entire archive before giving any bytes to pg_restore.
        dump = subprocess.check_output([b.executable("age"), "--decrypt", "-i", str(identity), str(archive)],
                                       env=env, stderr=subprocess.DEVNULL, timeout=60)
        if not dump.startswith(b"PGDMP"):
            raise RuntimeError("Not a custom PostgreSQL dump")
        if len(store.objects) != 4:
            raise RuntimeError("Standalone and release archives/manifests required")
        marker = store.objects[result["key"].replace(".dump.age", ".complete.json")]
        if json.loads(marker)["sha256"] != result["sha256"]:
            raise RuntimeError("Manifest mismatch")
        sys.stdout.buffer.write(dump)


if __name__ == "__main__":
    main()
