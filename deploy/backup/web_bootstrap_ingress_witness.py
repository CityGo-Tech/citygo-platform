"""Render and observe a compiled Nginx epoch over a protected Unix socket.

Only a disposable caller is wired. Installation, source-file locks, live TLS
gates and Nginx process-generation checks are responsibilities of the caller.
"""
from hashlib import sha256
import http.client
import os
from pathlib import PurePosixPath
import re
import socket
import stat
import struct
import sys

WITNESS_SOCKET = "/run/citygo-nginx-epoch/epoch.sock"
DIRECTIONS = ("baseline", "install", "restore")


class WitnessError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise WitnessError(code)


def is_hex(value, count):
    return type(value) is str and len(value) == count and re.fullmatch("[0-9a-f]+", value) is not None


def epoch_token(*, operation, direction, site_sha256, review_sha256):
    require(is_hex(operation, 32) and direction in DIRECTIONS
            and is_hex(site_sha256, 64) and is_hex(review_sha256, 64), "epoch-binding")
    fields = ("citygo-nginx-epoch-v1", operation, direction, site_sha256, review_sha256)
    return sha256("\n".join(fields).encode("ascii")).hexdigest()


def socket_name(value):
    path = os.fspath(value) if isinstance(value, os.PathLike) else value
    require(type(path) is str and 1 < len(path) <= 100
            and re.fullmatch(r"(?:/[A-Za-z0-9_.-]+){2,}", path)
            and all(part not in (".", "..") for part in path.split("/")[1:]), "epoch-socket-path")
    return path


def render_witness(token, socket_path=WITNESS_SOCKET):
    path = socket_name(socket_path)
    require(is_hex(token, 64), "epoch-token")
    return f"""# Closed Web handoff proof. No TCP listener or reverse proxy.
server {{
    listen unix:{path};
    server_name _;
    access_log off;
    server_tokens off;
    charset off;
    location = /epoch {{
        if ($request_method != GET) {{ return 405; }}
        default_type text/plain;
        add_header Cache-Control no-store always;
        return 200 "{token}\\n";
    }}
    location / {{ return 404; }}
}}
""".encode("ascii")


def read_epoch(socket_path, *, master_pid, owner_uid):
    require(sys.platform.startswith("linux") and type(master_pid) is int and master_pid > 0
            and type(owner_uid) is int and owner_uid >= 0, "epoch-peer")
    path = PurePosixPath(socket_name(socket_path))
    # Anchor the name in the exact directory to keep a replacement parent out of
    # the connect() lookup. The installer must protect the name's ancestors.
    folder = None
    try:
        folder = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent = os.fstat(folder)
        require(parent.st_uid == owner_uid and stat.S_IMODE(parent.st_mode) == 0o700, "epoch-directory")
        original = os.stat(path.name, dir_fd=folder, follow_symlinks=False)
        require(stat.S_ISSOCK(original.st_mode) and original.st_uid == owner_uid, "epoch-socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(f"/proc/self/fd/{folder}/{path.name}")
            pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require((pid, uid) == (master_pid, owner_uid), "epoch-peer")
            connection.sendall(b"GET /epoch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            with http.client.HTTPResponse(connection) as response:
                response.begin()
                require(response.status == 200
                        and response.headers.get_all("cache-control") == ["no-store"]
                        and response.headers.get_all("content-type") == ["text/plain"]
                        and response.headers.get_all("content-length") == ["65"]
                        and response.headers.get_all("transfer-encoding") is None, "epoch-response")
                raw = response.read(65)
                require(re.fullmatch(rb"[0-9a-f]{64}\n", raw), "epoch-response")
        final = os.stat(path.name, dir_fd=folder, follow_symlinks=False)
        require(os.path.samestat(original, final), "epoch-socket")
        return raw[:-1].decode("ascii")
    except (OSError, http.client.HTTPException):
        raise WitnessError("epoch-probe-failed") from None
    finally:
        if folder is not None:
            os.close(folder)
