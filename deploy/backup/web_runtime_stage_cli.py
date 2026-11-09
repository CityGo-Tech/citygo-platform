"""Explicit manual runtime-stage routes; no argument/default execution is inert."""
import json
import sys

import web_runtime_stage as controller


def run(args):
    if args in ([], ["--plan"]):
        return {"purpose": "citygo-web-runtime-stage-cli-v1", "writes": False,
                "runtime_changed": False, "serverAccess": False, "opensTraffic": False,
                "operations": ["stage (fresh capability)", "inspect (read-only)",
                               "adopt-prepared (fresh capability, no Docker mutations)"],
                "clearsLegacyBarrier": False}
    if len(args) == 3 and args[:2] == ["inspect", "--planfile"]:
        return controller.inspect_stage(args[2])
    if len(args) == 6 and args[1] == "--planfile" and args[3] == "--approval":
        if args[0] == "stage" and args[5] == "--allow-stage":
            return controller.stage(args[2], args[4], allow_stage=True)
        if args[0] == "adopt-prepared" and args[5] == "--allow-adopt":
            return controller.adopt_prepared(args[2], args[4], allow_adopt=True)
    raise ValueError("runtime-stage-arguments")


def main(args=None):
    try:
        print(json.dumps(run(sys.argv[1:] if args is None else args), sort_keys=True))
        return 0
    except (OSError, ValueError, controller.StageError):
        print('{"error":"web-runtime-stage-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
