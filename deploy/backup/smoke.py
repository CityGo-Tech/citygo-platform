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
        if len(store.objects) != 2:
            raise RuntimeError("Archive and completion manifest required")
        marker = next(value for key, value in store.objects.items() if key.endswith(".complete.json"))
        if json.loads(marker)["sha256"] != result["sha256"]:
            raise RuntimeError("Manifest mismatch")
        sys.stdout.buffer.write(dump)


if __name__ == "__main__":
    main()
