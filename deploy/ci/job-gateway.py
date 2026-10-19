#!/usr/bin/python3
"""Trusted disposable JOB gateway; unchanged short canaries stay unchanged.

One public, hash-bound job plan fixes the guest deadline. Reuses the pinned
initializer/policy/counter/L2 guards, closes forwarding on every exit, and grants
NO permission to register a runner. External host watchdog remains mandatory.
"""
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import time

SCRIPT = "/usr/local/sbin/citygo-job-gateway.py"
LEASE = "/usr/local/lib/citygo-ci/job-lease.py"
PLAN = "/var/lib/citygo-ci-gateway/job-plan.json"
INITIALIZER = "/usr/local/sbin/citygo-private-gateway-init.py"
INITIALIZER_SHA = "bf6546ca7ee07f91939f5d9bdf06b450208a4a22a9d80d58f08b9b93cf98b417"
LEASE_SHA = "5e410154ff5eec081b07f22c5288e5299a4ea5756ec02711409f741455cbbdd0"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"


def require(value, code):
    if not value:
        raise ValueError("ci_job_gateway_" + code)


def command(operation, sha):
    return ["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", operation,
            "--expected-job-plan-sha256", sha, "--acknowledge", "RUN_JOB_GATEWAY:" + operation + ":" + sha]


def validate_seed(seed, guest, initializer, operation, sha):
    require(type(seed) is dict and set(seed) == {"write_files", "bootcmd", "runcmd"}, "seed")
    paths = [(INITIALIZER, "0700"), (initializer.POLICY, "0600"), (initializer.HELPER, "0600"),
             (initializer.CONFIG, "0600"), (initializer.WITNESS, "0700"), (SCRIPT, "0700"), (LEASE, "0600"), (PLAN, "0600")]
    files = seed["write_files"]
    require(type(files) is list and len(files) == len(paths), "seed_files")
    for item, (path, mode) in zip(files, paths):
        require(type(item) is dict and set(item) == {"path", "owner", "permissions", "encoding", "content"} and
                item["path"] == path and item["owner"] == "root:root" and item["permissions"] == mode and
                item["encoding"] == "b64" and type(item["content"]) is str, "seed_file")
        try:
            actual = base64.b64decode(item["content"], validate=True)
        except (ValueError, TypeError):
            raise ValueError("ci_job_gateway_seed_encoding") from None
        require(actual == guest.read(path, 131072), "seed_changed")
    require(seed["bootcmd"] == [["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"]] and
            seed["runcmd"] == [command(operation, sha)] and
            hashlib.sha256(guest.read(PLAN, 16384)).hexdigest() == sha, "seed_binding")
    # Only AFTER complete physical seed verification, project its unchanged five
    # initializer records into the narrow legacy initializer API. This adapter
    # does not add trusted files/commands to that API or change any old guards.
    return dict(write_files=files[:5], bootcmd=seed["bootcmd"], runcmd=[[
        "/usr/bin/python3", "-I", "-B", INITIALIZER, "--apply", "--operation-id", operation,
        "--acknowledge", "INITIALIZE_PRIVATE_GATEWAY:" + operation, "--observe-runner-canary"]])


def observe(guest, initializer, policy, witness, value, initial, lease, sha, link, pause=time.sleep):
    require(initial.get("policyApplied") is True and guest.mutation_permitted is True, "verified_policy")
    tick = 0
    try:
        lease.require_live()
        generated, _, _ = initializer.observed_policy(guest, value, policy)
        require(generated["ipv4Sha256"] == initial["ipv4Sha256"] and generated["ipv6Sha256"] == initial["ipv6Sha256"], "policy_changed")
        # Absolute plan limits, not a renewable timeout. Every native command is
        # independently bounded and the runtime adapter checks lease before it.
        while lease.remaining() > 0:
            again, _, _ = initializer.observed_policy(guest, value, policy)
            require(again == generated and guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"1", "network_changed")
            raw = guest.command(["/usr/sbin/iptables-save", "-c"]).decode("ascii")
            metrics = witness.counter_metrics(raw, generated["ipv4Restore"], initializer.verify_rules, initializer.normalize_tables)
            metrics.update(link.snapshot())
            initializer.verify_rules(guest.command(["/usr/sbin/ip6tables-save"]).decode("ascii"), generated["ipv6Restore"])
            lease.require_live()
            report = dict(version=1, scope="private_ci_job_gateway_witness", operationId=value["operationId"],
                          stage="observing_ci_job", jobPlanSha256=sha, hostSnapshotSha256=value["hostSnapshotSha256"],
                          ipv4Sha256=initial["ipv4Sha256"], ipv6Sha256=initial["ipv6Sha256"], tick=tick,
                          ciJobsAdmitted=False, **metrics)
            guest.publish(value["operationId"], witness.report_bytes(report))
            tick += 1
            pause(min(2, lease.remaining()))
    finally:
        try:
            guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
        finally:
            link.close()
    require(guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"0", "close_readback")


def main(args):
    if args == ["--plan"]:
        print('{"stage":"plan_only_unverified","ciJobsAdmitted":false}')
        return 0
    if not (len(args) == 7 and args[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, args[2]) and
            args[3] == "--expected-job-plan-sha256" and re.fullmatch(r"[a-f0-9]{64}", args[4]) and
            args[5:] == ["--acknowledge", "RUN_JOB_GATEWAY:" + args[2] + ":" + args[4]]):
        print('{"stage":"refused","ciJobsAdmitted":false}')
        return 2
    guest = None
    try:
        require(sys.platform == "linux" and os.geteuid() == 0, "linux_root")
        # Bootstrap loader verifies bytes before exec; never import from cwd.
        import types
        fd = os.open(INITIALIZER, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            item = os.fstat(fd)
            require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and item.st_nlink == 1 and not item.st_mode & 0o022, "initializer_owner")
            raw = os.read(fd, 131073)
            require(len(raw) <= 131072 and hashlib.sha256(raw).hexdigest() == INITIALIZER_SHA, "initializer_pin")
        finally:
            os.close(fd)
        initializer = types.ModuleType("job_gateway_initializer")
        exec(compile(raw, INITIALIZER, "exec"), initializer.__dict__)
        lease_lib = initializer.load_pinned(LEASE, LEASE_SHA, "job_gateway_lease")
        raw_plan = initializer.read_root_file(PLAN, 16384)
        plan = lease_lib.parse_plan(raw_plan, args[4], args[2], "gateway")
        lease = lease_lib.Lease(plan, args[2], "gateway")
        helper = initializer.load_pinned(initializer.HELPER, initializer.HELPER_SHA, "job_gateway_kvp")
        policy = initializer.load_pinned(initializer.POLICY, initializer.POLICY_SHA, "job_gateway_policy")
        witness = initializer.load_pinned(initializer.WITNESS, initializer.WITNESS_SHA, "job_gateway_witness")

        class Gateway(helper.Guest):
            mutation_permitted = False
            validated_projection = None

            def now(self):
                return datetime.datetime.now(datetime.timezone.utc)

            def command(self, argv, *params, **kwargs):
                if argv not in (["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"],
                                ["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]):
                    lease.require_live()
                return super().command(argv, *params, **kwargs)

            def seed(self):
                return self.validated_projection if self.validated_projection is not None else super().seed()

            def is_masked(self, unit):
                require(unit in initializer.UNITS, "service")
                path = "/etc/systemd/system/" + unit
                item = self.info(path)
                return item is not None and stat.S_ISLNK(item.st_mode) and item.st_uid == 0 and os.readlink(path) == "/dev/null"

            def record(self, path, report):
                require(path in (initializer.INTENT, initializer.RESULT, initializer.FAILURE) and self.mutation_permitted, "record")
                for directory in ("/var", "/var/lib", "/var/lib/citygo-ci-gateway"):
                    item = self.info(directory)
                    require(item is not None and stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022, "record_directory")
                raw = helper.report_bytes(report)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as target:
                    target.write(raw)
                    target.flush()
                    os.fsync(target.fileno())
                require(self.read(path, 1022) == raw, "record_readback")

        guest = Gateway()
        guest.validated_projection = validate_seed(guest.seed(), guest, initializer, args[2], args[4])
        value = policy.unique_json(initializer.read_root_file(initializer.CONFIG, 32768).decode("ascii"))
        require(value.get("operationId") == args[2], "operation")
        result = initializer.initialize(guest, policy, value, guest.now(), True, True, True)
        lease.require_live()
        guest.record(initializer.RESULT, result)
        guest.publish(args[2], helper.report_bytes(result))
        capture = witness.PacketWitness(guest, value)
        observe(guest, initializer, policy, witness, value, result, lease, args[4], capture)
        print('{"stage":"job_gateway_lease_closed","ciJobsAdmitted":false}')
        return 0
    except Exception:
        if guest is not None and guest.mutation_permitted:
            try:
                guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
            except Exception:
                pass
        print('{"stage":"failed_preserved","ciJobsAdmitted":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
