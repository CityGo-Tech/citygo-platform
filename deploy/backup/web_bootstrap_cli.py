"""Local-only bootstrap draft writer. No installer or server transport.

No arguments / --plan are inert. --draft reads two bounded local files and
creates a new private review directory inside this checkout's ignored .local.
It never executes the generated Compose or treats metadata as authorization.
"""
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid

import web_bootstrap as compiler

ROOT = Path(__file__).absolute().parents[2]
MAX_INPUT = 512 * 1024
OUTPUT_FILES = {"canonical.original.json", "request.original.json", "canonical.prepared.json",
                "slot2.compose.json", "draft.json"}


class DraftIOError(Exception):
    """Only a fixed code, never input bytes, is printed on failure."""


def require(condition, code):
    if not condition:
        raise DraftIOError(code)


def read_input(path):
    """Refuse links, special files, hard links and replacement during reading."""
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), "draft-input-link")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 < before.st_size <= MAX_INPUT, "draft-input-file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
                and stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1, "draft-input-raced")
        raw = stream.read(MAX_INPUT + 1)
        after = os.fstat(stream.fileno())
    final = path.lstat()
    for item in (after, final):
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns),
                "draft-input-raced")
    require(len(raw) == before.st_size, "draft-input-size")
    return raw


def write_draft(files, *, root=ROOT):
    """POSIX fd-anchored create-only output; completion record is written last."""
    require(type(files) is dict and set(files) == OUTPUT_FILES, "draft-output-schema")
    for name, raw in files.items():
        require(type(name) is str and name.endswith(".json") and name != ".json"
                and all(ch in "abcdefghijklmnopqrstuvwxyz0123456789-." for ch in name)
                and ".." not in name and type(raw) is bytes and 0 < len(raw) <= MAX_INPUT,
                "draft-output-schema")
    # Windows lacks openat-style dir_fd traversal. Refuse rather than silently
    # weaken containment there; pure compilation and the inert --plan still work.
    require(os.name == "posix" and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
            and all(call in os.supports_dir_fd for call in (os.open, os.mkdir, os.stat)), "draft-platform")
    root = Path(root).absolute()
    descriptors = []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        descriptor = os.open("/", flags)
        descriptors.append(descriptor)
        for part in root.parts[1:]:
            require(part not in (".", ".."), "draft-output-directory")
            descriptor = os.open(part, flags, dir_fd=descriptor)
            descriptors.append(descriptor)
        root_descriptor = descriptor
        for part in (".local", "web-bootstrap-drafts"):
            try:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            descriptor = os.open(part, flags, dir_fd=descriptor)
            descriptors.append(descriptor)
            meta = os.fstat(descriptor)
            require(meta.st_uid == os.getuid() and not meta.st_mode & 0o022, "draft-output-permissions")
        operation = uuid.uuid4().hex
        os.mkdir(operation, mode=0o700, dir_fd=descriptor)
        descriptor = os.open(operation, flags, dir_fd=descriptor)
        descriptors.append(descriptor)
        directory = root / ".local" / "web-bootstrap-drafts" / operation
        for name in [*sorted(set(files) - {"draft.json"}), "draft.json"]:
            file_descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                      0o600, dir_fd=descriptor)
            with os.fdopen(file_descriptor, "wb") as stream:
                stream.write(files[name])
                stream.flush()
                os.fsync(stream.fileno())
        os.fsync(descriptor)
        # The name returned to the caller must still refer to the opened inode.
        # Reopen every component without following a swapped ancestor symlink.
        check = root_descriptor
        for part in (".local", "web-bootstrap-drafts", operation):
            check = os.open(part, flags, dir_fd=check)
            descriptors.append(check)
        current, expected = os.fstat(check), os.fstat(descriptor)
        require((current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino), "draft-output-raced")
        return directory
    except OSError:
        raise DraftIOError("draft-output-directory") from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def run(args):
    if args in ([], ["--plan"]):
        return {"purpose": "citygo-web-bootstrap-draft", "writes": False,
                "serverAccess": False, "readyToApply": False, "deploymentAuthorization": False,
                "execution": "--draft --canonical <local-json> --request <local-json>",
                "applyCommand": None}
    require(len(args) == 5 and args[0] == "--draft" and args[1] == "--canonical"
            and args[3] == "--request", "draft-arguments")
    canonical = read_input(args[2])
    request = read_input(args[4])
    files = compiler.compile_draft(canonical, request, int(time.time()))
    output = write_draft(files)
    return {"status": "draft-created", "output": str(output), "readyToApply": False,
            "deploymentAuthorization": False, "serverAccess": False}


def main(args=None):
    try:
        result = run(sys.argv[1:] if args is None else args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, DraftIOError, compiler.BootstrapError):
        print('{"error":"bootstrap-draft-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
