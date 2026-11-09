"""CLI dispatch only; no root operations, files, daemon or server calls."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

import web_controller_install_cli as cli


class CommandLine(unittest.TestCase):
    def test_default_and_plan_never_call_install_inspect_or_reconcile(self):
        with patch.object(cli.installer, "install_package") as install, \
                patch.object(cli.installer, "reconcile_package") as reconcile, \
                patch.object(cli.installer, "inspect_install") as inspect:
            for args in ([], ["--plan"]):
                result = cli.run(args)
                self.assertIs(result["writes"], False)
                self.assertIs(result["activation_authorized"], False)
                self.assertIs(result["runtime_changed"], False)
            for function in (install, reconcile, inspect):
                function.assert_not_called()

    def test_only_exact_install_and_reconcile_flags_dispatch(self):
        for operation, name, permission in (("install", "install_package", "allow_install"),
                                            ("reconcile", "reconcile_package", "allow_reconcile")):
            with self.subTest(operation=operation), patch.object(cli.installer, name, return_value={"status": "fixture"}) as call:
                self.assertEqual(cli.run([operation, "--source", "synthetic-source", "--approval", "synthetic-cap", "--allow-" + operation]),
                                 {"status": "fixture"})
                call.assert_called_once_with("synthetic-source", "synthetic-cap", **{permission: True})

    def test_inspection_has_no_capability_or_mutation_flag(self):
        with patch.object(cli.installer, "inspect_install", return_value={"status": "fixture"}) as inspect:
            cli.run(["inspect"])
            inspect.assert_called_once_with()
            inspect.reset_mock()
            cli.run(["inspect", "--manifest", "a" * 64])
            inspect.assert_called_once_with("a" * 64)

    def test_unknown_partial_runtime_and_path_override_flags_reject_before_operations(self):
        with patch.object(cli.installer, "install_package") as install, \
                patch.object(cli.installer, "reconcile_package") as reconcile, \
                patch.object(cli.installer, "inspect_install") as inspect:
            for args in (["activate"], ["--allow-install"], ["install"],
                         ["install", "--source", "x", "--approval", "y"],
                         ["install", "--source", "x", "--approval", "y", "--allow-reconcile"],
                         ["install", "--source", "x", "--approval", "y", "--allow-install", "--now", "1"],
                         ["install", "--source", "x", "--approval", "y", "--allow-install", "--root", "/etc"],
                         ["inspect", "--allow-install"], ["--plan", "install"]):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    cli.run(args)
            for function in (install, reconcile, inspect):
                function.assert_not_called()

    def test_failure_is_redacted_and_default_main_remains_inert(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(cli, "run", side_effect=ValueError("private sentinel")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(cli.main(["install"]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(errors.getvalue()), {"error": "inactive-controller-operation-rejected"})
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(cli.main([]), 0)
        self.assertIs(json.loads(output.getvalue())["writes"], False)
        self.assertEqual(errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
