"""No external requests: CLI transport is mocked; Linux tests use real age."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import backup as b

RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"


def sample(directory=PurePosixPath("/tmp/citygo-fixture")):
    return dict(version=1, upload_enabled=True, source_sha="a" * 40,
                project="citygo-fixture", compose_file=str(directory / "compose.yml"),
                compose_env=str(directory / "pilot.env"), state_dir=str(directory / "state"),
                recipient=RECIPIENT, storage_credentials_file=str(directory / "storage.json"),
                endpoint=b.ENDPOINT, bucket="citygo-fixture", prefix="citygo/pilot")


class Validation(unittest.TestCase):
    def test_explicit_schema(self):
        self.assertEqual(b.validate(sample()), sample())
        for extra in ("private_key", "command", "env", "webhook"):
            with self.subTest(extra=extra), self.assertRaises(b.BackupError):
                b.validate({**sample(), extra: "not-allowed"})
        with self.assertRaises(b.BackupError):
            b.validate([])

    def test_rejects_redirects_credentials_plugins_and_path_injection(self):
        bad = {
            "endpoint": ["http://s3.cloud.ru", "https://s3.cloud.ru.evil.test", "https://user:secret@s3.cloud.ru", "https://s3.cloud.ru/path"],
            "recipient": ["AGE-SECRET-KEY-1-DO-NOT-PRINT", "age1plugin", "ssh-rsa key", RECIPIENT + "\n"],
            "bucket": ["../other", "a\nb", "-option", "https://example.test"],
            "prefix": ["citygo/../other", "other/pilot", "citygo/a/b", "citygo/"],
            "source_sha": ["main", "A" * 40, "a" * 39],
            "project": ["other", "citygo-a;ls", "citygo-a\n"],
            "upload_enabled": ["true", 1], "version": [True, 2],
            "compose_env": ["relative.env", "/etc/../env", "/etc/foo\0bar"],
        }
        for field, values in bad.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(b.BackupError):
                    b.validate({**sample(), field: value})

    def test_environment_is_closed(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "never", "AWS_SECRET_ACCESS_KEY": "never", "DOCKER_HOST": "tcp://other", "HTTP_PROXY": "never"}):
            env = b.clean_env(Path("/tmp/private"))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertEqual(env["DOCKER_HOST"], "unix:///var/run/docker.sock")

    def test_hashes_and_size_cap(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "cipher"
            path.write_bytes(b"encrypted-fixture")
            size, sha, md5 = b.digest(path)
            self.assertEqual(size, 17)
            self.assertEqual(len(sha), 64)
            self.assertEqual(len(md5), 24)
            with patch.object(b, "MAX_BYTES", 2), self.assertRaises(b.BackupError):
                b.digest(path)
            path.write_bytes(b"")
            with self.assertRaises(b.BackupError):
                b.digest(path)


class MemoryStore:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.fault = None

    def put(self, key, path):
        self.calls.append(("put", key))
        if self.fault == "put" or (self.fault == "manifest" and key.endswith(".json")):
            raise RuntimeError("sensitive upstream error that must be hidden")
        self.objects[key] = path.read_bytes()

    def get(self, key, path):
        self.calls.append(("get", key))
        data = self.objects[key]
        if self.fault == "readback" or (self.fault == "marker-readback" and key.endswith(".json")):
            data = b"corrupted"
        path.write_bytes(data)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux operator permissions/locks")
class Operations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-backup-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = sample(self.directory)
        self.state = self.directory / "state"
        self.state.mkdir(mode=0o700)
        for name in ("compose.yml", "pilot.env"):
            (self.directory / name).write_text("# synthetic fixture\n")
            (self.directory / name).chmod(0o600)
        self.store = MemoryStore()
        self.encrypt = lambda _c, path, _e: path.write_bytes(b"ciphertext-fixture" * 30)

    def perform(self, **kwargs):
        return b.perform_backup(self.config, storage_factory=lambda *_: self.store,
                                encryptor=kwargs.pop("encryptor", self.encrypt), min_free=0, **kwargs)

    def test_success_requires_both_readbacks_and_unique_keys(self):
        first = self.perform()
        b.check_freshness(self.config)
        second = self.perform()
        self.assertNotEqual(first["key"], second["key"])
        self.assertEqual([x[0] for x in self.store.calls], ["put", "get", "put", "get"] * 2)
        self.assertEqual(len(self.store.objects), 4)
        self.assertFalse(list(self.state.glob(".attempt-*")))
        self.assertEqual((self.state / "last-success.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.state / "last-success.json").read_text())["key"], second["key"])

    def test_failure_never_refreshes_success_or_prints_error(self):
        self.perform()
        previous = (self.state / "last-success.json").read_bytes()
        for fault in ("put", "readback", "manifest", "marker-readback"):
            with self.subTest(fault=fault):
                self.store.fault = fault
                with self.assertRaises(b.BackupError) as caught:
                    self.perform()
                self.assertNotIn("sensitive", str(caught.exception))
                self.assertEqual((self.state / "last-success.json").read_bytes(), previous)
                with self.assertRaisesRegex(b.BackupError, "last-attempt-failed"):
                    b.check_freshness(self.config)
                self.assertFalse(list(self.state.glob(".attempt-*")))
        self.store.fault = None
        self.perform()
        b.check_freshness(self.config)

    def test_failed_dump_never_uploads(self):
        def fail(_config, path, _env):
            path.write_bytes(b"partial encrypted output")
            raise RuntimeError("raw database error")
        with self.assertRaisesRegex(b.BackupError, "dump-encrypt"):
            self.perform(encryptor=fail)
        self.assertEqual(self.store.calls, [])
        self.assertFalse((self.state / "last-success.json").exists())

    def test_disabled_and_low_disk_never_upload(self):
        self.config["upload_enabled"] = False
        with self.assertRaisesRegex(b.BackupError, "upload-disabled"):
            self.perform()
        self.config["upload_enabled"] = True
        with patch.object(b.shutil, "disk_usage", return_value=type("Disk", (), {"free": -1})()):
            with self.assertRaisesRegex(b.BackupError, "preflight"):
                self.perform()
        self.assertEqual(self.store.calls, [])

    def test_exclusive_maintenance_lock(self):
        with b.lock(self.state):
            with self.assertRaisesRegex(b.BackupError, "already-running"):
                self.perform()
        self.assertEqual(self.store.calls, [])

    def test_freshness_missing_stale_future_corrupt_and_failure(self):
        with self.assertRaises(b.BackupError):
            b.check_freshness(self.config)
        for start, verified in ((1, 2), (10001, 10002), (9900, 9899), (True, 9999), (9900, float("nan"))):
            b.atomic_json(self.state / "last-success.json", {"snapshot_started_at": start, "verified_at": verified, "configuration_sha256": b.configuration_fingerprint(self.config)})
            with self.assertRaises(b.BackupError):
                b.check_freshness(self.config, now=10000)
        b.atomic_json(self.state / "last-success.json", {"snapshot_started_at": 9900, "verified_at": 9999, "configuration_sha256": b.configuration_fingerprint(self.config)})
        b.check_freshness(self.config, now=10000)
        b.atomic_json(self.state / "last-failure.json", {"failed_at": 10000})
        with self.assertRaises(b.BackupError):
            b.check_freshness(self.config, now=10000)

    def test_receipt_for_changed_destination_or_database_is_not_fresh(self):
        self.perform()
        self.config["bucket"] = "another-bucket"
        with self.assertRaisesRegex(b.BackupError, "configuration-changed"):
            b.check_freshness(self.config)
        self.config["bucket"] = "citygo-fixture"
        (self.directory / "pilot.env").write_text("CITYGO_DB_VOLUME=other\n")
        with self.assertRaisesRegex(b.BackupError, "configuration-changed"):
            b.check_freshness(self.config)

    def test_symlinks_and_open_permissions_rejected(self):
        link = self.directory / "link"
        link.symlink_to(self.state)
        with self.assertRaises(b.BackupError):
            b.protected(link, directory=True)
        self.state.chmod(0o755)
        with self.assertRaises(b.BackupError):
            self.perform()

    def test_s3_explicit_endpoint_closed_env_and_no_destructive_commands(self):
        creds = self.directory / "storage.json"
        creds.write_text(json.dumps({"access_key_id": "fixture-id", "secret_access_key": "fixture-secret"}))
        creds.chmod(0o600)
        archive = self.directory / "encrypted.age"
        archive.write_bytes(b"encrypted")
        with patch.object(b, "executable", return_value="/usr/local/bin/aws"), patch.object(b, "run") as run:
            storage = b.S3(self.config, self.directory)
            storage.put("citygo/pilot/object.age", archive)
            storage.get("citygo/pilot/object.age", self.directory / "readback.age")
        for args, env in (call.args for call in run.call_args_list):
            self.assertIn(b.ENDPOINT, args)
            self.assertNotIn("--no-verify-ssl", args)
            self.assertNotIn("fixture-secret", " ".join(args))
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertEqual(env["AWS_EC2_METADATA_DISABLED"], "true")
            self.assertIn(args[args.index("s3api") + 1], ("put-object", "get-object"))
        self.assertIn("--content-md5", run.call_args_list[0].args[0])

    def test_cli_requires_permission_and_hides_config_contents(self):
        config_file = self.directory / "config.json"
        config_file.write_text(json.dumps(self.config))
        config_file.chmod(0o600)
        result = subprocess.run([sys.executable, "-B", str(Path(b.__file__)), "backup", "--config", str(config_file)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("explicit-upload-required", result.stderr)
        config_file.write_text('{"secret": "DO-NOT-PRINT"')
        result = subprocess.run([sys.executable, "-B", str(Path(b.__file__)), "check", "--config", str(config_file)], capture_output=True, text=True)
        self.assertNotIn("DO-NOT-PRINT", result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("age"), "real age is installed in Linux CI")
    def test_real_age_roundtrip_failed_producer_and_timeout(self):
        identity = self.directory / "identity.txt"
        subprocess.run(["age-keygen", "-o", str(identity)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.config["recipient"] = subprocess.check_output(["age-keygen", "-y", str(identity)], text=True).strip()
        fake = self.directory / "docker-fixture"
        # The real age process consumes a pipe, never a plaintext spool.
        def fixture(body):
            fake.write_text(f"#!{sys.executable}\nimport sys,time\nif sys.argv[1] == 'rm': sys.exit(0)\n{body}\n")
            fake.chmod(0o700)
        real_age = shutil.which("age")
        def executable(name):
            return str(fake) if name == "docker" else real_age
        output = self.directory / "output.age"
        fixture("sys.stdout.buffer.write(b'PGDMP-fictional-database')")
        with patch.object(b, "executable", side_effect=executable):
            b.encrypt(self.config, output, b.clean_env(self.directory))
            restored = subprocess.check_output(["age", "--decrypt", "-i", str(identity), str(output)])
            self.assertEqual(restored, b"PGDMP-fictional-database")
            self.assertNotIn(restored, output.read_bytes())
            output.unlink()
            fixture("sys.stdout.buffer.write(b'partial dump');sys.stdout.flush();sys.exit(1)")
            with self.assertRaisesRegex(b.BackupError, "dump-failed"):
                b.encrypt(self.config, output, b.clean_env(self.directory))
            output.unlink()
            fixture("time.sleep(10)")
            start = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                b.encrypt(self.config, output, b.clean_env(self.directory), timeout=0.2)
            self.assertLess(time.monotonic() - start, 5)
        # Damaged authenticated ciphertext cannot be a successful restore.
        output.unlink()
        fixture("sys.stdout.buffer.write(b'PGDMP-fictional-database')")
        with patch.object(b, "executable", side_effect=executable):
            b.encrypt(self.config, output, b.clean_env(self.directory))
        data = bytearray(output.read_bytes())
        data[-1] ^= 1
        output.write_bytes(data)
        damaged = subprocess.run(["age", "--decrypt", "-i", str(identity), str(output)], capture_output=True)
        self.assertNotEqual(damaged.returncode, 0)


if __name__ == "__main__":
    unittest.main()
