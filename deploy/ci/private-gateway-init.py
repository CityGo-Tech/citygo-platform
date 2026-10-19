#!/usr/bin/python3
"""Initialize only a trusted, dedicated NoCloud Ubuntu gateway, never a CI job.

Default --plan is pure. No credentials, downloads, shell commands, runner or
host mounts. Native policy readback is mandatory before IPv4 forwarding.
Failure after mutation disables forwarding but preserves rules/evidence.
"""
import base64
import datetime
import hashlib
import ipaddress
import json
import os
import re
import shlex
import stat
import sys
import types


SCRIPT = "/usr/local/sbin/citygo-private-gateway-init.py"
POLICY = "/usr/local/lib/citygo-ci/private-gateway-policy.py"
HELPER = "/usr/local/lib/citygo-ci/offline-clone-canary.py"
CONFIG = "/var/lib/citygo-ci-gateway/config.json"
RESULT = "/var/lib/citygo-ci-gateway/result.json"
INTENT = "/var/lib/citygo-ci-gateway/initialization-intent.json"
FAILURE = "/var/lib/citygo-ci-gateway/failure.json"
POLICY_SHA = "980c8195e5cb8a01fc86997758d380daa919a2d2ca0bed9df28e05a0766083f3"
HELPER_SHA = "c10465066ce2908fa72d6416811a6bc426c96aef90584b8c0639e9a45a97e0b4"
WITNESS = "/usr/local/sbin/citygo-private-network-canary.py"
WITNESS_SHA = "4acb5eb963cabaa6dd0f49600c066557dbccf12a98fb480486b7f9eb871bb53d"
UNITS = ("docker.socket", "docker.service", "containerd.service", "ssh.socket", "ssh.service")
FIELDS = {"schemaVersion", "operationId", "capturedAt", "hostSnapshotSha256", "wanMac", "lanMac",
          "expectedWanPrefix", "expectedWanGatewayIPv4", "hostIPv4", "productionIPv4", "additionalDeniedPrefixes"}
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(value, code):
    if not value:
        raise Refused(code)


def failure_report(operation, phase, code):
    # Only bounded static machine codes; never exception messages, argv, raw
    # rules, paths or subprocess output in the host-facing KVP channel.
    return {"version": 1, "scope": "private_ci_gateway_initialization", "operationId": operation,
            "stage": "failed_preserved", "policyApplied": False, "guestIsolationVerified": False, "ciJobsAdmitted": False,
            "failurePhase": phase if type(phase) is str and re.fullmatch(r"[a-z_]{1,64}", phase) else "unknown",
            "failureCode": code if type(code) is str and re.fullmatch(r"[a-z_]{1,64}", code) else "native_operation_failed"}


def config(value, now):
    require(type(value) is dict and set(value) == FIELDS and type(value["schemaVersion"]) is int and
            value["schemaVersion"] == 1, "config_fields_invalid")
    require(type(value["operationId"]) is str and re.fullmatch(UUID, value["operationId"]), "operation_invalid")
    require(type(value["hostSnapshotSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["hostSnapshotSha256"]), "snapshot_invalid")
    require(type(value["capturedAt"]) is str and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?Z", value["capturedAt"]), "capture_time_invalid")
    try:
        captured = datetime.datetime.fromisoformat(value["capturedAt"].replace("Z", "+00:00"))
    except ValueError:
        raise Refused("capture_time_invalid") from None
    require(-60 <= (now - captured).total_seconds() <= 900, "host_snapshot_stale")
    for key in ("wanMac", "lanMac"):
        require(type(value[key]) is str and re.fullmatch(r"02(?::[a-f0-9]{2}){5}", value[key]), "mac_invalid")
    require(value["wanMac"] != value["lanMac"], "mac_not_unique")
    try:
        wan = ipaddress.IPv4Network(value["expectedWanPrefix"], strict=True)
        gateway = ipaddress.IPv4Address(value["expectedWanGatewayIPv4"])
    except (ValueError, TypeError):
        raise Refused("wan_invalid") from None
    private = (ipaddress.IPv4Network("10.0.0.0/8"), ipaddress.IPv4Network("172.16.0.0/12"), ipaddress.IPv4Network("192.168.0.0/16"))
    require(str(wan) == value["expectedWanPrefix"] and 8 <= wan.prefixlen <= 30 and
            any(wan.subnet_of(item) for item in private) and not wan.overlaps(ipaddress.IPv4Network("10.203.0.0/30")) and
            str(gateway) == value["expectedWanGatewayIPv4"] and gateway in wan and
            gateway not in (wan.network_address, wan.broadcast_address), "wan_invalid")
    # Reuse the pinned pure renderer's strict list/address/prefix validation
    # after runtime DHCP observation, before any mutation.
    for key, minimum, maximum in (("hostIPv4", 1, 128), ("productionIPv4", 1, 64), ("additionalDeniedPrefixes", 0, 256)):
        items = value[key]
        require(type(items) is list and minimum <= len(items) <= maximum and all(type(x) is str for x in items) and
                len(set(items)) == len(items), "config_list_invalid")
    return value


def normalize_tables(raw):
    """Compare native iptables-save semantics, never ignore unknown rules.

    Counters/comments, option order, automatic tcp/udp match and conntrack state
    ordering may differ. Rule order within each chain MUST remain identical.
    """
    require(type(raw) is str and raw.isascii() and len(raw) <= 262144, "rules_shape_invalid")
    tables = {}
    current = None
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("*"):
            require(current is None and line[1:] in ("filter", "nat", "raw", "mangle", "security") and line[1:] not in tables, "rules_table_invalid")
            current = {"chains": {}, "rules": {}}
            tables[line[1:]] = current
            continue
        require(current is not None, "rules_table_invalid")
        if line == "COMMIT":
            current = None
            continue
        if line.startswith(":"):
            match = re.fullmatch(r":([A-Z]+) (ACCEPT|DROP) \[[0-9]+:[0-9]+\]", line)
            require(match is not None and match[1] not in current["chains"], "rules_chain_invalid")
            current["chains"][match[1]] = match[2]
            current["rules"][match[1]] = []
            continue
        tokens = shlex.split(line)
        require(len(tokens) >= 4 and tokens[0] == "-A" and tokens[1] in current["chains"], "rules_line_invalid")
        chain = tokens[1]
        pairs = []
        index = 2
        negate = False
        seen = set()
        protocol = tokens[tokens.index("-p") + 1] if "-p" in tokens else None
        while index < len(tokens):
            option = tokens[index]
            if option == "!":
                require(not negate, "rules_option_invalid")
                negate = True
                index += 1
                continue
            require(option in ("-i", "-o", "-s", "-d", "-p", "--sport", "--dport", "--ctstate", "-j", "-m") and
                    index + 1 < len(tokens), "rules_option_invalid")
            item = tokens[index + 1]
            index += 2
            if option == "-m" and item in ("tcp", "udp") and item == protocol and not negate:
                continue
            key = (option, item if option == "-m" else "")
            require(key not in seen, "rules_duplicate_option")
            seen.add(key)
            if option in ("-s", "-d"):
                try:
                    item = str(ipaddress.ip_network(item, strict=False))
                except ValueError:
                    raise Refused("rules_address_invalid") from None
            if option == "--ctstate":
                states = item.split(",")
                require(len(states) == len(set(states)) and set(states) <= {"INVALID", "NEW", "ESTABLISHED", "RELATED"}, "rules_states_invalid")
                item = ",".join(sorted(states))
            pairs.append((option, item, negate))
            negate = False
        require(not negate, "rules_option_invalid")
        current["rules"][chain].append(tuple(sorted(pairs)))
    require(current is None and tables, "rules_table_invalid")
    return tables


def verify_rules(actual, expected):
    observed = normalize_tables(actual)
    wanted = normalize_tables(expected)
    for name, table in wanted.items():
        require(observed.get(name) == table, "rules_readback_mismatch")
    for name, table in observed.items():
        if name in wanted:
            continue
        allowed = {"PREROUTING", "INPUT", "FORWARD", "OUTPUT", "POSTROUTING"}
        require(set(table["chains"]) <= allowed and all(x == "ACCEPT" for x in table["chains"].values()) and
                all(not x for x in table["rules"].values()), "unexpected_active_table")


def table_names(raw):
    # Only choose fixed native table names, never interpolate rule/chain text
    # into a command. This is not policy acceptance: readback still compares
    # every final chain/rule. Docker may leave user chains after service stop.
    require(type(raw) is str and raw.isascii() and len(raw) <= 262144, "rules_shape_invalid")
    names = [line[1:] for line in raw.splitlines() if line.startswith("*")]
    require(len(names) <= 5 and len(set(names)) == len(names) and
            all(name in ("filter", "nat", "raw", "mangle", "security") for name in names), "rules_table_invalid")
    return sorted(set(names) | {"filter"})


def clear_owned_gateway_tables(guest):
    # This runs ONLY in the dedicated, identity/seed-verified trusted gateway,
    # with Docker/SSH masked, forwarding=0 and no CI attachment admitted.
    # Set all filter policies DROP in BOTH families before the first flush.
    require(getattr(guest, "mutation_permitted", False) is True and
            guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"0", "closed_owned_gateway_required")
    families = []
    for binary, save in (("iptables", "iptables-save"), ("ip6tables", "ip6tables-save")):
        families.append((binary, table_names(guest.command(["/usr/sbin/" + save]).decode("ascii"))))
    for binary, _ in families:
        for chain in ("INPUT", "FORWARD", "OUTPUT"):
            guest.command(["/usr/sbin/" + binary, "--wait", "5", "-t", "filter", "-P", chain, "DROP"])
    for binary, tables in families:
        for table in tables:
            guest.command(["/usr/sbin/" + binary, "--wait", "5", "-t", table, "-F"])
            guest.command(["/usr/sbin/" + binary, "--wait", "5", "-t", table, "-X"])


def read_root_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and info.st_mode & 0o022 == 0, "root_file_required")
        raw = os.read(fd, maximum + 1)
        require(len(raw) <= maximum, "file_too_large")
        return raw
    finally:
        os.close(fd)


def load_pinned(path, expected, name):
    raw = read_root_file(path, 131072)
    require(hashlib.sha256(raw).hexdigest() == expected, "library_hash_mismatch")
    module = types.ModuleType(name)
    # Execute the SAME hash-verified bytes, not a second mutable path read.
    exec(compile(raw, path, "exec"), module.__dict__)
    return module


def observed_policy(guest, value, policy):
    addresses = policy.unique_json(guest.command(["/usr/sbin/ip", "-j", "address", "show"]).decode("ascii"))
    require(type(addresses) is list and len(addresses) <= 8, "interfaces_invalid")
    selected = {}
    for item in addresses:
        require(type(item) is dict and item.get("ifname") in ("lo", "docker0", "wan0", "lan0"), "interface_unexpected")
        name = item["ifname"]
        require(name not in selected, "interface_duplicate")
        selected[name] = item
    require("wan0" in selected and "lan0" in selected, "gateway_interfaces_missing")
    for name, mac in (("wan0", value["wanMac"]), ("lan0", value["lanMac"])):
        require(selected[name].get("address") == mac and type(selected[name].get("ifindex")) is int, "interface_mac_mismatch")
    require(selected["lan0"].get("addr_info") == [{"family": "inet", "local": "10.203.0.1", "prefixlen": 30}] or
            [(x.get("family"), x.get("local"), x.get("prefixlen")) for x in selected["lan0"].get("addr_info", [])] == [("inet", "10.203.0.1", 30)], "lan_address_invalid")
    wan_addresses = [x for x in selected["wan0"].get("addr_info", []) if x.get("family") == "inet"]
    require(len(wan_addresses) == 1 and not any(x.get("family") == "inet6" for x in selected["wan0"].get("addr_info", [])), "wan_address_invalid")
    wan = wan_addresses[0]
    try:
        network = str(ipaddress.IPv4Network(str(wan["local"]) + "/" + str(wan["prefixlen"]), strict=False))
    except (ValueError, KeyError):
        raise Refused("wan_address_invalid") from None
    require(network == value["expectedWanPrefix"], "wan_prefix_changed")
    routes = policy.unique_json(guest.command(["/usr/sbin/ip", "-j", "-4", "route", "show", "default"]).decode("ascii"))
    require(type(routes) is list and len(routes) == 1 and routes[0].get("dev") == "wan0" and
            routes[0].get("gateway") == value["expectedWanGatewayIPv4"], "wan_route_changed")
    lease = guest.read("/run/systemd/netif/leases/" + str(selected["wan0"]["ifindex"]), 16384).decode("ascii")
    servers = re.findall(r"^SERVER_ADDRESS=([^\n]+)$", lease, re.MULTILINE)
    require(len(servers) == 1, "dhcp_server_unobserved")
    return policy.render({"schemaVersion": 1, "operationId": value["operationId"],
                          "hostSnapshotSha256": value["hostSnapshotSha256"], "wanAddressIPv4": wan["local"],
                          "wanPrefix": network, "wanGatewayIPv4": value["expectedWanGatewayIPv4"], "dhcpServerIPv4": servers[0],
                          "hostIPv4": value["hostIPv4"], "productionIPv4": value["productionIPv4"],
                          "additionalDeniedPrefixes": value["additionalDeniedPrefixes"]}), wan["local"], servers[0]


def validate_seed(seed, value, guest, canary_observation=False):
    require(type(seed) is dict and set(seed) == {"write_files", "runcmd", "bootcmd"}, "seed_fields_invalid")
    paths = ((SCRIPT, "0700"), (POLICY, "0600"), (HELPER, "0600"), (CONFIG, "0600"))
    require(type(canary_observation) is bool, "seed_mode_invalid")
    if canary_observation:
        paths += ((WITNESS, "0700"),)
    files = seed["write_files"]
    require(type(files) is list and len(files) == len(paths), "seed_files_invalid")
    for item, (path, mode) in zip(files, paths):
        require(type(item) is dict and set(item) == {"path", "owner", "permissions", "encoding", "content"} and
                item["path"] == path and item["owner"] == "root:root" and item["permissions"] == mode and item["encoding"] == "b64", "seed_files_invalid")
        try:
            embedded = base64.b64decode(item["content"], validate=True)
        except (ValueError, TypeError):
            raise Refused("seed_content_invalid") from None
        require(embedded == guest.read(path, 131072), "seed_content_mismatch")
    require(seed["bootcmd"] == [["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"]], "seed_bootcmd_invalid")
    command = ["/usr/bin/python3", "-I", "-B", SCRIPT, "--apply", "--operation-id", value["operationId"],
               "--acknowledge", "INITIALIZE_PRIVATE_GATEWAY:" + value["operationId"]]
    if canary_observation:
        command += ["--observe-canary"]
    require(seed["runcmd"] == [command], "seed_command_invalid")


def initialize(guest, policy, value, now, do_apply, canary_observation=False):
    config(value, now)
    report = {"version": 1, "scope": "private_ci_gateway_initialization", "operationId": value["operationId"],
              "stage": "plan_only_unverified", "policyApplied": False, "guestIsolationVerified": False, "ciJobsAdmitted": False}
    if not do_apply:
        return report
    uid, architecture, release = guest.facts()
    require(uid == 0 and architecture == "x86_64" and release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "24.04", "trusted_ubuntu_root_required")
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
            guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() == ("citygo-gateway-" + value["operationId"]).encode("ascii"), "instance_identity_invalid")
    validate_seed(guest.seed(), value, guest, canary_observation)
    require(guest.info(RESULT) is None and guest.info(INTENT) is None, "attempt_already_exists")
    mutation_started = False
    try:
        guest.mutation_permitted = True
        guest.phase = "write_intent"
        guest.record(INTENT, report)
        mutation_started = True
        guest.phase = "disable_forwarding"
        guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
        for unit in UNITS:
            guest.phase = "mask_" + unit.replace(".", "_")
            guest.command(["/usr/bin/systemctl", "mask", "--now", unit], timeout=20)
            require(guest.is_masked(unit), "service_not_masked")
            require(guest.command(["/usr/bin/systemctl", "is-active", unit], missing_ok=True) is None, "service_still_active")
        # Recheck forwarding after stopping Docker, which can enable it.
        guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
        guest.phase = "observe_network"
        generated, wan, dhcp = observed_policy(guest, value, policy)
        guest.phase = "test_rules"
        for binary, key in (("iptables-restore", "ipv4Restore"), ("ip6tables-restore", "ipv6Restore")):
            guest.command(["/usr/sbin/" + binary, "--wait", "5", "--test"], generated[key].encode("ascii"))
        guest.phase = "clear_owned_gateway_tables"
        clear_owned_gateway_tables(guest)
        guest.phase = "apply_rules"
        for binary, key in (("iptables-restore", "ipv4Restore"), ("ip6tables-restore", "ipv6Restore")):
            guest.command(["/usr/sbin/" + binary, "--wait", "5"], generated[key].encode("ascii"))
        guest.phase = "readback_rules"
        verify_rules(guest.command(["/usr/sbin/iptables-save"]).decode("ascii"), generated["ipv4Restore"])
        verify_rules(guest.command(["/usr/sbin/ip6tables-save"]).decode("ascii"), generated["ipv6Restore"])
        # No networking generation change during rule installation is admitted.
        guest.phase = "recheck_network"
        again, _, _ = observed_policy(guest, value, policy)
        require(again == generated, "gateway_network_changed")
        config(value, guest.now())
        guest.phase = "enable_forwarding"
        guest.command(["/usr/sbin/sysctl", "-w", "net.ipv6.conf.all.forwarding=0"])
        guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=1"])
        require(guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"1", "forwarding_readback_failed")
        # IPv4 forwarding flips kernel router defaults; verify policy again.
        verify_rules(guest.command(["/usr/sbin/iptables-save"]).decode("ascii"), generated["ipv4Restore"])
        verify_rules(guest.command(["/usr/sbin/ip6tables-save"]).decode("ascii"), generated["ipv6Restore"])
        report.update({"stage": "gateway_policy_installed", "policyApplied": True, "rulesReadbackVerified": True,
                       "forwardingEnabled": True, "hostSnapshotSha256": value["hostSnapshotSha256"],
                       "ipv4Sha256": generated["ipv4Sha256"], "ipv6Sha256": generated["ipv6Sha256"],
                       "wanIPv4": wan, "dhcpServerIPv4": dhcp})
        return report
    except Exception:
        if mutation_started:
            try:
                guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
            except Exception:
                pass
        raise


def main(arguments):
    if len(arguments) == 3 and arguments[:2] == ["--plan", "--operation-id"] and re.fullmatch(UUID, arguments[2]):
        print(json.dumps({"scope": "private_ci_gateway_initialization", "operationId": arguments[2], "stage": "plan_only_unverified",
                          "policyApplied": False, "guestIsolationVerified": False, "ciJobsAdmitted": False}, separators=(",", ":")))
        return 0
    observation = len(arguments) == 6 and arguments[5] == "--observe-canary"
    if not ((len(arguments) == 5 or observation) and arguments[:2] == ["--apply", "--operation-id"] and re.fullmatch(UUID, arguments[2]) and
            arguments[3:5] == ["--acknowledge", "INITIALIZE_PRIVATE_GATEWAY:" + arguments[2]]):
        print('{"stage":"refused","policyApplied":false,"ciJobsAdmitted":false}')
        return 2
    guest = None
    try:
        require(sys.platform == "linux" and os.geteuid() == 0, "linux_root_required")
        policy = load_pinned(POLICY, POLICY_SHA, "citygo_gateway_policy")
        helper = load_pinned(HELPER, HELPER_SHA, "citygo_gateway_kvp")
        witness = load_pinned(WITNESS, WITNESS_SHA, "citygo_gateway_witness") if observation else None
        class Gateway(helper.Guest):
            mutation_permitted = False

            def now(self):
                return datetime.datetime.now(datetime.timezone.utc)

            def is_masked(self, unit):
                require(unit in UNITS, "service_invalid")
                path = "/etc/systemd/system/" + unit
                item = self.info(path)
                return item is not None and stat.S_ISLNK(item.st_mode) and item.st_uid == 0 and os.readlink(path) == "/dev/null"

            def record(self, path, value):
                require(path in (INTENT, RESULT, FAILURE) and self.mutation_permitted, "record_path_invalid")
                for directory in ("/var", "/var/lib", "/var/lib/citygo-ci-gateway"):
                    item = self.info(directory)
                    require(item is not None and stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and item.st_mode & 0o022 == 0, "record_directory_invalid")
                raw = helper.report_bytes(value)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    with os.fdopen(fd, "wb", closefd=False) as target:
                        target.write(raw)
                        target.flush()
                        os.fsync(fd)
                finally:
                    os.close(fd)
                require(self.read(path, 1022) == raw, "record_readback_failed")
        guest = Gateway()
        value = policy.unique_json(read_root_file(CONFIG, 32768).decode("ascii"))
        require(value.get("operationId") == arguments[2], "config_operation_mismatch")
        result = initialize(guest, policy, value, guest.now(), True, observation)
        guest.phase = "publish_result"
        guest.record(RESULT, result)
        guest.publish(arguments[2], helper.report_bytes(result))
        if witness is not None:
            guest.phase = "observe_synthetic_client"
            witness.observe_gateway(guest, policy, value, result, observed_policy, verify_rules, normalize_tables)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        # This catch also covers a publish failure AFTER forwarding. Best
        # effort closes forwarding, never restores permissive previous rules.
        if guest is not None and guest.mutation_permitted:
            try:
                guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
            except Exception:
                pass
            failed = failure_report(arguments[2], getattr(guest, "phase", None), getattr(error, "code", None))
            try:
                guest.record(FAILURE, failed)
            except Exception:
                pass
            try:
                guest.publish(arguments[2], helper.report_bytes(failed))
            except Exception:
                pass
        print('{"scope":"private_ci_gateway_initialization","stage":"failed_preserved","policyApplied":false,"ciJobsAdmitted":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
