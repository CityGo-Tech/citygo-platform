"""Validate the closed Nginx epoch witness with a disposable Unix HTTP peer."""
from contextlib import contextmanager
import os
from pathlib import Path
import re
import socket
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

import web_bootstrap_ingress_witness as witness


OPERATION = "a" * 32
SITE = "b" * 64
REVIEW = "c" * 64
TOKEN = "d" * 64


def epoch(**overrides):
    return witness.epoch_token(**({
        "operation": OPERATION,
        "direction": "install",
        "site_sha256": SITE,
        "review_sha256": REVIEW,
    } | overrides))


class EpochRenderTests(unittest.TestCase):
    def test_token_is_deterministic_and_binds_each_field(self):
        original = epoch()
        self.assertRegex(original, r"^[0-9a-f]{64}$")
        self.assertEqual(epoch(), original)
        alternatives = (
            {"operation": "e" * 32}, {"direction": "baseline"}, {"direction": "restore"},
            {"site_sha256": "e" * 64}, {"review_sha256": "e" * 64},
        )
        self.assertEqual(len({epoch(**value) for value in alternatives} | {original}), 6)

    def test_token_refuses_noncanonical_input(self):
        for value in (
            {"operation": "A" * 32}, {"operation": "a" * 31}, {"operation": 1},
            {"direction": "apply"}, {"direction": True}, {"site_sha256": "g" * 64},
            {"site_sha256": "b" * 63}, {"review_sha256": "c" * 65},
        ):
            with self.subTest(value=value), self.assertRaises(witness.WitnessError):
                epoch(**value)

    def test_block_binds_only_a_unix_socket_with_a_compiled_token(self):
        for path in (witness.WITNESS_SOCKET, "/tmp/citygo-witness-test/epoch.sock", "/tmp/" + "x" * 95):
            with self.subTest(path=path):
                config = witness.render_witness(TOKEN, path)
                self.assertIsInstance(config, bytes)
                self.assertEqual(
                    re.findall(rb"(?m)^\s*listen\s+([^;]+);", config),
                    [b"unix:" + os.fsencode(path)],
                )
                self.assertIn(TOKEN.encode("ascii"), config)
                for upstream in (b"proxy_pass", b"fastcgi_pass", b"uwsgi_pass"):
                    self.assertNotIn(upstream, config)
        self.assertEqual(os.fspath(witness.WITNESS_SOCKET), "/run/citygo-nginx-epoch/epoch.sock")

    def test_block_refuses_token_or_path_syntax_injection(self):
        for token in ("d" * 63, "D" * 64, "d" * 63 + ";", None):
            with self.subTest(token=token), self.assertRaises(witness.WitnessError):
                witness.render_witness(token)
        for path in (
            "relative/epoch.sock", "/tmp/epoch.sock; include anything", "/tmp/epoch\n.sock",
            "/tmp/\u00e9.sock", "/tmp/" + "x" * 96, "/tmp/../epoch.sock",
        ):
            with self.subTest(path=path), self.assertRaises(witness.WitnessError):
                witness.render_witness(TOKEN, path)


def http_response(*, status=b"200 OK", cache=b"no-store", media=b"text/plain",
                  length=b"65", body=TOKEN.encode("ascii") + b"\n"):
    return (
        b"HTTP/1.1 " + status + b"\r\nCache-Control: " + cache + b"\r\nContent-Type: " + media
        + b"\r\nContent-Length: " + length + b"\r\nConnection: close\r\n\r\n" + body
    )


@unittest.skipUnless(sys.platform == "linux" and hasattr(socket, "SO_PEERCRED"),
                     "requires Linux Unix peer credentials")
class EpochProtocolTests(unittest.TestCase):
    @contextmanager
    def peer(self, reply):
        with TemporaryDirectory(prefix="epoch-") as temporary, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            path = Path(temporary) / "epoch.sock"
            server.bind(os.fspath(path))
            os.chmod(path, 0o600)
            server.listen(1)
            server.settimeout(2)
            requests, errors = [], []

            def respond():
                try:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(2)
                        request = b""
                        while b"\r\n\r\n" not in request and len(request) < 4096:
                            chunk = connection.recv(4096)
                            if not chunk:
                                return
                            request += chunk
                        requests.append(request)
                        connection.sendall(reply)
                except OSError as error:
                    errors.append(error)

            worker = Thread(target=respond, daemon=True)
            worker.start()
            try:
                yield path, requests
            finally:
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive(), "Unix fixture peer did not finish")
                self.assertEqual(errors, [])

    def test_accepts_exact_token_from_pinned_unix_peer(self):
        with self.peer(http_response()) as (path, requests):
            self.assertEqual(witness.read_epoch(path, master_pid=os.getpid(), owner_uid=os.geteuid()), TOKEN)
        self.assertEqual(len(requests), 1)
        self.assertTrue(requests[0].startswith(b"GET "))

    def test_wrong_master_rejected_before_http(self):
        with self.peer(http_response()) as (path, requests):
            with self.assertRaises(witness.WitnessError):
                witness.read_epoch(path, master_pid=os.getpid() + 1, owner_uid=os.geteuid())
        self.assertEqual(requests, [])

    def test_refuses_wrong_socket_owner_context_and_symlink(self):
        with TemporaryDirectory(prefix="epoch-") as temporary, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            directory = Path(temporary)
            path = directory / "epoch.sock"
            server.bind(os.fspath(path))
            uid = os.geteuid()
            with self.assertRaisesRegex(witness.WitnessError, "^epoch-directory$"):
                witness.read_epoch(path, master_pid=os.getpid(), owner_uid=uid + 1)
            directory.chmod(0o755)
            with self.assertRaisesRegex(witness.WitnessError, "^epoch-directory$"):
                witness.read_epoch(path, master_pid=os.getpid(), owner_uid=uid)
            directory.chmod(0o700)
            alias = directory / "alias.sock"
            alias.symlink_to(path)
            with self.assertRaisesRegex(witness.WitnessError, "^epoch-socket$"):
                witness.read_epoch(alias, master_pid=os.getpid(), owner_uid=uid)

    def test_refuses_invalid_http_proof_from_pinned_peer(self):
        for changes in (
            {"status": b"503 Service Unavailable"}, {"cache": b"public"}, {"media": b"application/json"},
            {"cache": b"no-store\r\nCache-Control: no-store"}, {"length": b"64"},
            {"body": b"G" + TOKEN[1:].encode("ascii") + b"\n"},
            {"body": TOKEN.encode("ascii") + b" "},
        ):
            with self.subTest(changes=changes), self.peer(http_response(**changes)) as (path, _):
                with self.assertRaises(witness.WitnessError):
                    witness.read_epoch(path, master_pid=os.getpid(), owner_uid=os.geteuid())


if __name__ == "__main__":
    unittest.main()
