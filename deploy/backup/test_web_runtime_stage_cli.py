"""Argument routing only; no actual server, Docker, files or capabilities."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

import web_runtime_stage_cli as cli


class Routes(unittest.TestCase):
    def test_default_and_plan_are_inert_without_inspecting_server(self):
        with patch.object(cli.controller, "stage") as stage, \
                patch.object(cli.controller, "inspect_stage") as inspect, \
                patch.object(cli.controller, "adopt_prepared") as adopt:
            for args in ([], ["--plan"]):
                result = cli.run(args)
                for key in ("writes", "runtime_changed", "serverAccess", "opensTraffic", "clearsLegacyBarrier"):
                    self.assertIs(result[key], False)
            for call in (stage, inspect, adopt):
                call.assert_not_called()

    def test_stage_and_adopt_require_their_exact_distinct_switches(self):
        with patch.object(cli.controller, "stage", return_value={"status": "fixture"}) as stage:
            cli.run(["stage", "--planfile", "plan", "--approval", "cap", "--allow-stage"])
            stage.assert_called_once_with("plan", "cap", allow_stage=True)
        with patch.object(cli.controller, "adopt_prepared", return_value={"status": "fixture"}) as adopt:
            cli.run(["adopt-prepared", "--planfile", "plan", "--approval", "cap", "--allow-adopt"])
            adopt.assert_called_once_with("plan", "cap", allow_adopt=True)

    def test_inspection_passes_no_mutation_permission(self):
        with patch.object(cli.controller, "inspect_stage", return_value={"status": "fixture"}) as inspect:
            cli.run(["inspect", "--planfile", "plan"])
            inspect.assert_called_once_with("plan")

    def test_override_retry_activation_and_mismatched_flags_refuse_before_operation(self):
        with patch.object(cli.controller, "stage") as stage, \
                patch.object(cli.controller, "inspect_stage") as inspect, \
                patch.object(cli.controller, "adopt_prepared") as adopt:
            for args in (["stage"], ["resume"], ["backout"], ["open"],
                         ["stage", "--planfile", "p", "--approval", "a", "--allow-adopt"],
                         ["adopt-prepared", "--planfile", "p", "--approval", "a", "--allow-stage"],
                         ["stage", "--planfile", "p", "--approval", "a", "--allow-stage", "--now", "1"],
                         ["stage", "--planfile", "p", "--approval", "a", "--allow-stage", "--root", "/etc"],
                         ["inspect", "--planfile", "p", "--allow-stage"], ["--plan", "--allow-stage"]):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    cli.run(args)
            for call in (stage, inspect, adopt):
                call.assert_not_called()

    def test_diagnostics_do_not_echo_inputs_or_original_exceptions(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(cli, "run", side_effect=ValueError("private-value")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(cli.main(["stage"]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(errors.getvalue()), {"error": "web-runtime-stage-rejected"})


if __name__ == "__main__":
    unittest.main()
