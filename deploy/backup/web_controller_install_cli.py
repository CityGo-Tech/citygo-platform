"""Explicit CLI for inactive files only. Default/--plan perform no operation."""
import json
import sys

import web_controller_install as installer


def run(args):
    if args in ([], ["--plan"]):
        return {"purpose": "citygo-inactive-web-controller-install-cli-v1", "writes": False,
                "runtime_changed": False, "activation_authorized": False,
                "operations": ["install (explicit capability)", "inspect (read-only)",
                               "reconcile (fresh explicit capability)"], "serverAccess": False}
    if args == ["inspect"]:
        return installer.inspect_install()
    if len(args) == 3 and args[0] == "inspect" and args[1] == "--manifest":
        return installer.inspect_install(args[2])
    if len(args) == 6 and args[0] in ("install", "reconcile") and args[1] == "--source" \
            and args[3] == "--approval" and args[5] == "--allow-" + args[0]:
        operation = installer.install_package if args[0] == "install" else installer.reconcile_package
        permission = {"allow_install" if args[0] == "install" else "allow_reconcile": True}
        return operation(args[2], args[4], **permission)
    raise ValueError("inactive-install-arguments")


def main(args=None):
    try:
        result = run(sys.argv[1:] if args is None else args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, installer.InstallError):
        print('{"error":"inactive-controller-operation-rejected"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
