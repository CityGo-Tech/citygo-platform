"""Local draft IO only; synthetic files, no daemon, network or server access."""
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

import web_bootstrap_cli as cli


def files():
    return {name: b'{}\n' for name in cli.OUTPUT_FILES}


class LocalDraft(unittest.TestCase):
    def test_default_and_plan_do_no_io_or_compilation(self):
        with patch.object(cli, "read_input") as read, patch.object(cli, "write_draft") as write, \
                patch.object(cli.compiler, "compile_draft") as compile_draft:
            for args in ([], ["--plan"]):
                result = cli.run(args)
                self.assertFalse(result["writes"])
                self.assertFalse(result["serverAccess"])
                self.assertFalse(result["readyToApply"])
                self.assertFalse(result["deploymentAuthorization"])
                self.assertIsNone(result["applyCommand"])
            read.assert_not_called()
            write.assert_not_called()
            compile_draft.assert_not_called()

    def test_mutating_and_incomplete_cli_flags_are_rejected_before_io(self):
        with patch.object(cli, "read_input") as read:
            for args in (["--apply"], ["--install"], ["--plan", "--draft"], ["--draft"],
                         ["--draft", "--canonical", "x", "--request", "y", "--output", "/etc"],
                         ["--draft", "--request", "x", "--canonical", "y"]):
                with self.subTest(args=args), self.assertRaises(cli.DraftIOError):
                    cli.run(args)
            read.assert_not_called()

    def test_compile_failure_writes_nothing_and_main_redacts_input(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(cli, "read_input", return_value=b'synthetic-private-value'), \
                patch.object(cli.compiler, "compile_draft", side_effect=cli.compiler.BootstrapError("rejected")), \
                patch.object(cli, "write_draft") as write, contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(errors):
            self.assertEqual(cli.main(["--draft", "--canonical", "synthetic-private-path", "--request", "x"]), 1)
            write.assert_not_called()
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(errors.getvalue()), {"error": "bootstrap-draft-rejected"})
        self.assertNotIn("synthetic-private", errors.getvalue())

    def test_draft_success_uses_actual_clock_and_never_authorizes(self):
        with patch.object(cli, "read_input", side_effect=[b'canonical', b'request']), \
                patch.object(cli.compiler, "compile_draft", return_value=files()) as compile_draft, \
                patch.object(cli, "write_draft", return_value=Path("synthetic-output")) as write, \
                patch.object(cli.time, "time", return_value=2000000000):
            result = cli.run(["--draft", "--canonical", "x", "--request", "y"])
        compile_draft.assert_called_once_with(b'canonical', b'request', 2000000000)
        write.assert_called_once()
        for name in ("readyToApply", "deploymentAuthorization", "serverAccess"):
            self.assertIs(result[name], False)

    def test_reads_exact_bytes_without_modifying_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.json"
            raw = b'{ "preserve-whitespace": true }\n'
            source.write_bytes(raw)
            self.assertEqual(cli.read_input(source), raw)
            self.assertEqual(source.read_bytes(), raw)

    def test_empty_large_and_directory_inputs_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.json"
            for raw in (b'', b'x' * (cli.MAX_INPUT + 1)):
                source.write_bytes(raw)
                with self.assertRaises(cli.DraftIOError):
                    cli.read_input(source)
            with self.assertRaises(cli.DraftIOError):
                cli.read_input(directory)

    @unittest.skipUnless(os.name == "posix", "POSIX fd-anchored writer")
    def test_outputs_are_private_unique_and_never_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            first = cli.write_draft(files(), root=root)
            first_raw = {p.name: p.read_bytes() for p in first.iterdir()}
            second = cli.write_draft(files(), root=root)
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, Path(root) / ".local" / "web-bootstrap-drafts")
            self.assertEqual({p.name: p.read_bytes() for p in first.iterdir()}, first_raw)
            self.assertEqual(set(first_raw), cli.OUTPUT_FILES)
            if sys.platform.startswith("linux"):
                self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o700)
                for path in first.iterdir():
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_output_schema_rejects_unknown_names_before_creating_directory(self):
        with tempfile.TemporaryDirectory() as root:
            for bad in ({}, {**files(), "../escape.json": b'{}'}, {**files(), "apply.sh": b'bad'},
                        {**files(), "draft.json": b''}):
                with self.assertRaises(cli.DraftIOError):
                    cli.write_draft(bad, root=root)
                self.assertFalse((Path(root) / ".local").exists())

    def test_nonposix_draft_writer_refuses_before_creating_output(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(cli.os, "name", "nt"):
                with self.assertRaisesRegex(cli.DraftIOError, "draft-platform"):
                    cli.write_draft(files(), root=root)
            self.assertFalse((Path(root) / ".local").exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux anchored directory traversal")
    def test_parent_replacement_never_redirects_writes_outside_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir()
            local = root / ".local"
            local.mkdir(mode=0o700)
            original_open = os.open
            replaced = False

            def replace_parent(name, flags, *args, **kwargs):
                nonlocal replaced
                result = original_open(name, flags, *args, **kwargs)
                if name == ".local" and kwargs.get("dir_fd") is not None and not replaced:
                    local.rename(root / "original-local")
                    local.symlink_to(outside, target_is_directory=True)
                    replaced = True
                return result

            with patch.object(cli.os, "open", side_effect=replace_parent):
                # os.supports_dir_fd is an identity-based set; keep its support
                # declaration aligned with the instrumented POSIX open wrapper.
                with patch.object(cli.os, "supports_dir_fd", {cli.os.open, os.mkdir, os.stat}):
                    with self.assertRaises(cli.DraftIOError):
                        cli.write_draft(files(), root=root)
            self.assertTrue(replaced)
            self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected output permissions")
    def test_writable_existing_output_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = root / ".local"
            local.mkdir()
            local.chmod(0o777)
            with self.assertRaisesRegex(cli.DraftIOError, "draft-output-permissions"):
                cli.write_draft(files(), root=root)
            self.assertEqual(list(local.iterdir()), [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux inode/link proof")
    def test_links_and_special_inputs_rejected_and_no_output_symlink_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            source.write_bytes(b'{}')
            link = root / "link.json"
            link.symlink_to(source)
            with self.assertRaises(cli.DraftIOError):
                cli.read_input(link)
            link.unlink()
            os.link(source, link)
            with self.assertRaises(cli.DraftIOError):
                cli.read_input(source)
            link.unlink()
            fifo = root / "fifo"
            os.mkfifo(fifo)
            with self.assertRaises(cli.DraftIOError):
                cli.read_input(fifo)
            outside = root / "outside"
            outside.mkdir()
            (root / ".local").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(cli.DraftIOError):
                cli.write_draft(files(), root=root)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
