#!/usr/bin/python3
"""Synthetic connected client + bounded trusted-gateway counter witness.

No checkout, registration, credentials, shell, host mounts or paid APIs. This
does NOT admit jobs or prove L2/IPv6 bypass resistance. A timeout alone is not
proof of filtering: host acceptance also requires gateway DROP counter deltas.
"""
import base64
import hashlib
import ipaddress
import json
import os
import re
import socket
import ssl
import stat
import sys
import time
import types


SCRIPT = "/usr/local/sbin/citygo-private-network-canary.py"
HELPER = "/usr/local/lib/citygo-ci/offline-clone-canary.py"
CONFIG = "/var/lib/citygo-ci-network/config.json"
HELPER_SHA = "c10465066ce2908fa72d6416811a6bc426c96aef90584b8c0639e9a45a97e0b4"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
HOSTNAME = "api.github.com"
CLIENT = "10.203.0.2"
GATEWAY = "10.203.0.1"
SPOOF = "10.203.0.6"


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(value, code):
    if not value:
        raise Refused(code)


def report_bytes(value):
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    require(len(raw) <= 1022, "report_too_large")
    return raw


def counted_rules(raw):
    """Strip only native counter syntax; return rule/chain counts in order."""
    require(type(raw) is str and raw.isascii() and len(raw) <= 262144, "counter_shape_invalid")
    lines, rules, chains = [], {}, {}
    table = None
    for line in raw.splitlines():
        if line.startswith("*"):
            table = line[1:]
            require(table in ("filter", "nat", "raw", "mangle", "security") and table not in rules, "counter_table_invalid")
            rules[table], chains[table] = {}, {}
        elif line.startswith(":"):
            match = re.fullmatch(r":([A-Z]+) (ACCEPT|DROP) \[([0-9]+):([0-9]+)\]", line)
            require(table is not None and match is not None and match[1] not in chains[table], "counter_chain_invalid")
            packets = int(match[3])
            require(packets <= 10**12, "counter_range_invalid")
            chains[table][match[1]] = packets
            rules[table][match[1]] = []
        elif line.startswith("["):
            match = re.fullmatch(r"\[([0-9]+):([0-9]+)\] (-A ([A-Z]+) .+)", line)
            require(table is not None and match is not None and match[4] in rules[table], "counter_rule_invalid")
            packets = int(match[1])
            require(packets <= 10**12, "counter_range_invalid")
            rules[table][match[4]].append(packets)
            line = match[3]
        elif line.startswith("-A"):
            raise Refused("rule_counter_missing")
        elif line == "COMMIT":
            table = None
        lines.append(line)
    require(table is None and "filter" in rules, "counter_table_invalid")
    return "\n".join(lines) + "\n", rules, chains


def counter_metrics(raw, expected, verify, normalize):
    bare, rules, chains = counted_rules(raw)
    verify(bare, expected)
    parsed = normalize(bare)["filter"]
    result = dict(forwardDenied=chains["filter"]["FORWARD"], sourceSpoofDenied=0,
                  gatewayInputDenied=0, httpsAllowed=0, dnsAllowed=0)
    for chain, items in parsed["rules"].items():
        require(len(items) == len(rules["filter"][chain]), "counter_binding_invalid")
        for item, count in zip(items, rules["filter"][chain]):
            fields = set(item)
            if ("-j", "DROP", False) in fields and chain == "FORWARD":
                if ("-s", CLIENT + "/32", True) in fields:
                    result["sourceSpoofDenied"] += count
                else:
                    result["forwardDenied"] += count
            if ("-j", "DROP", False) in fields and chain == "INPUT" and ("-i", "lan0", False) in fields:
                result["gatewayInputDenied"] += count
            if chain == "FORWARD" and ("-i", "lan0", False) in fields and ("-j", "ACCEPT", False) in fields:
                if ("--dport", "443", False) in fields:
                    result["httpsAllowed"] += count
                if ("--dport", "53", False) in fields:
                    result["dnsAllowed"] += count
    return result


def observe_gateway(guest, policy, value, initial, observe, verify, normalize, clock=time.monotonic, pause=time.sleep):
    require(initial.get("policyApplied") is True and guest.mutation_permitted is True, "verified_gateway_required")
    generated, _, _ = observe(guest, value, policy)
    require(generated["ipv4Sha256"] == initial["ipv4Sha256"] and generated["ipv6Sha256"] == initial["ipv6Sha256"], "witness_policy_changed")
    started, tick = clock(), 0
    try:
        while clock() - started < 180:
            again, _, _ = observe(guest, value, policy)
            require(again == generated and guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"1", "witness_network_changed")
            raw = guest.command(["/usr/sbin/iptables-save", "-c"]).decode("ascii")
            metrics = counter_metrics(raw, generated["ipv4Restore"], verify, normalize)
            verify(guest.command(["/usr/sbin/ip6tables-save"]).decode("ascii"), generated["ipv6Restore"])
            report = dict(version=1, scope="private_ci_gateway_counter_witness", operationId=value["operationId"],
                          stage="observing_synthetic_client", hostSnapshotSha256=value["hostSnapshotSha256"],
                          ipv4Sha256=initial["ipv4Sha256"], ipv6Sha256=initial["ipv6Sha256"], tick=tick,
                          guestIsolationVerified=False, ciJobsAdmitted=False, **metrics)
            guest.publish(value["operationId"], report_bytes(report))
            tick += 1
            pause(2)
    finally:
        # In-guest bounded fail-closed window, NOT external VM cleanup/watchdog.
        guest.command(["/usr/sbin/sysctl", "-w", "net.ipv4.ip_forward=0"])
    require(guest.command(["/usr/sbin/sysctl", "-n", "net.ipv4.ip_forward"]).strip() == b"0", "witness_close_readback_failed")
    guest.publish(value["operationId"], report_bytes(dict(version=1, scope="private_ci_gateway_counter_witness",
        operationId=value["operationId"], stage="observation_window_closed", tick=tick,
        ciJobsAdmitted=False, guestIsolationVerified=False)))


def client_config(value):
    fields = {"schemaVersion", "operationId", "gatewayOperationId", "hostSnapshotSha256", "mac", "hostIPv4", "productionIPv4"}
    require(type(value) is dict and set(value) == fields and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "config_fields_invalid")
    for key in ("operationId", "gatewayOperationId"):
        require(type(value[key]) is str and re.fullmatch(UUID, value[key]), "operation_invalid")
    require(value["operationId"] != value["gatewayOperationId"] and type(value["hostSnapshotSha256"]) is str and
            re.fullmatch(r"[a-f0-9]{64}", value["hostSnapshotSha256"]), "binding_invalid")
    require(type(value["mac"]) is str and re.fullmatch(r"02(?::[a-f0-9]{2}){5}", value["mac"]), "mac_invalid")
    for key, limit in (("hostIPv4", 128), ("productionIPv4", 64)):
        items = value[key]
        require(type(items) is list and 1 <= len(items) <= limit and all(type(x) is str for x in items) and len(set(items)) == len(items), "addresses_invalid")
        for item in items:
            try:
                address = ipaddress.IPv4Address(item)
            except ValueError:
                raise Refused("addresses_invalid") from None
            require(str(address) == item and not address.is_multicast and not address.is_unspecified and
                    address not in ipaddress.IPv4Network("10.203.0.0/30"), "addresses_invalid")
    targets = sorted(set(value["hostIPv4"] + value["productionIPv4"] + ["169.254.169.254"]))
    selected = [item for item in targets if not ipaddress.IPv4Address(item).is_loopback]
    require(len(selected) <= 48, "probe_window_exceeded")
    return selected


def validate_client_seed(guest, value):
    seed = guest.seed()
    require(type(seed) is dict and set(seed) == {"write_files", "runcmd"}, "seed_invalid")
    paths = ((SCRIPT, "0700"), (HELPER, "0600"), (CONFIG, "0600"))
    files = seed["write_files"]
    require(type(files) is list and len(files) == 3, "seed_invalid")
    for item, (path, mode) in zip(files, paths):
        require(type(item) is dict and set(item) == {"path", "owner", "permissions", "encoding", "content"} and
                item["path"] == path and item["owner"] == "root:root" and item["permissions"] == mode and item["encoding"] == "b64", "seed_invalid")
        try:
            embedded = base64.b64decode(item["content"], validate=True)
        except (ValueError, TypeError):
            raise Refused("seed_invalid") from None
        require(embedded == guest.read(path, 131072), "seed_bytes_changed")
    require(seed["runcmd"] == [["/usr/bin/python3", "-I", "-B", SCRIPT, "--client", "--operation-id", value["operationId"],
                                  "--acknowledge", "RUN_CONNECTED_CLIENT:" + value["operationId"]]], "seed_command_invalid")


def run_client(guest, value):
    targets = client_config(value)
    uid, architecture, release = guest.facts()
    require(uid == 0 and architecture == "x86_64" and release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "24.04", "trusted_client_required")
    require(guest.command(["/usr/bin/cloud-id"]).strip() == b"nocloud" and
            guest.command(["/usr/bin/cloud-init", "query", "v1.instance_id"]).strip() == ("citygo-network-client-" + value["operationId"]).encode("ascii"), "client_identity_invalid")
    validate_client_seed(guest, value)
    guest.validate_bounds()
    addresses = json.loads(guest.command(["/usr/sbin/ip", "-j", "address", "show", "dev", "ci0"]))
    require(type(addresses) is list and len(addresses) == 1 and addresses[0].get("address") == value["mac"], "client_interface_changed")
    selected = [(x.get("family"), x.get("local"), x.get("prefixlen")) for x in addresses[0].get("addr_info", [])]
    require(selected == [("inet", CLIENT, 30)], "client_address_changed")
    routes = json.loads(guest.command(["/usr/sbin/ip", "-j", "-4", "route", "show", "default"]))
    require(type(routes) is list and len(routes) == 1 and routes[0].get("dev") == "ci0" and routes[0].get("gateway") == GATEWAY, "client_route_changed")
    routes6 = json.loads(guest.command(["/usr/sbin/ip", "-j", "-6", "route", "show", "default"]))
    require(routes6 == [], "ipv6_default_route_present")
    # Fixed public host, direct TLS/hostname validation. No environment proxy,
    # redirects, credentials, browser, API keys, model or payment requests.
    answers = guest.resolve_public()
    require(answers and all(ipaddress.IPv4Address(x).is_global for x in answers), "public_dns_failed")
    guest.public_https(answers[0])
    for target in targets:
        require(not guest.tcp_connect(target, 443), "denied_target_reachable")
    for port in (22, 443):
        require(not guest.tcp_connect(GATEWAY, port), "gateway_service_reachable")
    spoof_added = False
    try:
        guest.command(["/usr/sbin/ip", "address", "add", SPOOF + "/32", "dev", "ci0"])
        spoof_added = True
        guest.send_spoof()
    finally:
        if spoof_added:
            guest.command(["/usr/sbin/ip", "address", "del", SPOOF + "/32", "dev", "ci0"])
    return dict(version=1, scope="private_ci_connected_client", operationId=value["operationId"], gatewayOperationId=value["gatewayOperationId"],
                hostSnapshotSha256=value["hostSnapshotSha256"], stage="synthetic_client_completed", dnsOk=True, httpsOk=True,
                negativeProbeCount=len(targets), gatewayProbeCount=2, sourceSpoofSent=True, ipv6DefaultRouteAbsent=True,
                guestIsolationVerified=False, ciJobsAdmitted=False)


def load_helper():
    fd = os.open(HELPER, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022, "helper_owner_invalid")
        raw = os.read(fd, 131073)
        require(len(raw) <= 131072 and hashlib.sha256(raw).hexdigest() == HELPER_SHA, "helper_pin_invalid")
    finally:
        os.close(fd)
    module = types.ModuleType("citygo_network_kvp")
    exec(compile(raw, HELPER, "exec"), module.__dict__)
    return module


def main(arguments):
    if len(arguments) == 3 and arguments[:2] == ["--plan", "--operation-id"] and re.fullmatch(UUID, arguments[2]):
        print(json.dumps(dict(stage="plan_only_unverified", operationId=arguments[2], ciJobsAdmitted=False), separators=(",", ":")))
        return 0
    if not (len(arguments) == 5 and arguments[:2] == ["--client", "--operation-id"] and re.fullmatch(UUID, arguments[2]) and
            arguments[3:] == ["--acknowledge", "RUN_CONNECTED_CLIENT:" + arguments[2]]):
        print('{"stage":"refused","ciJobsAdmitted":false}')
        return 2
    guest = None
    try:
        require(sys.platform == "linux" and os.geteuid() == 0, "linux_root_required")
        helper = load_helper()
        class Client(helper.Guest):
            def validate_bounds(self):
                helper.validate_mounts(self.read("/proc/self/mountinfo", 262144))
                self.workspace_absent()

            def resolve_public(self):
                raw = self.command(["/usr/bin/getent", "ahostsv4", HOSTNAME], timeout=12).decode("ascii")
                return sorted(set(line.split()[0] for line in raw.splitlines() if line.split()))

            def public_https(self, address):
                with socket.create_connection((address, 443), timeout=8) as raw:
                    with ssl.create_default_context().wrap_socket(raw, server_hostname=HOSTNAME) as tls:
                        tls.sendall(("GET /meta HTTP/1.1\r\nHost: " + HOSTNAME + "\r\nUser-Agent: CityGo-synthetic-network-canary\r\nConnection: close\r\n\r\n").encode("ascii"))
                        status = tls.recv(4096).split(b"\r\n", 1)[0]
                        require(re.fullmatch(rb"HTTP/1\.[01] [234][0-9]{2} [\x20-\x7e]{0,100}", status), "public_https_failed")

            def tcp_connect(self, address, port):
                try:
                    with socket.create_connection((address, port), timeout=1):
                        return True
                except OSError:
                    return False

            def send_spoof(self):
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
                    channel.settimeout(1)
                    channel.bind((SPOOF, 0))
                    channel.sendto(b"CityGo synthetic source-filter canary", ("1.1.1.1", 53))
        guest = Client()
        value = helper.unique_json(guest.read(CONFIG, 32768).decode("ascii"))
        require(value.get("operationId") == arguments[2], "config_operation_changed")
        report = run_client(guest, value)
        guest.publish(arguments[2], helper.report_bytes(report))
        print(json.dumps(report, separators=(",", ":")))
        return 0
    except Exception as error:
        if guest is not None:
            try:
                code = getattr(error, "code", None)
                report = dict(version=1, scope="private_ci_connected_client", operationId=arguments[2], stage="failed_preserved",
                              code=code if type(code) is str and re.fullmatch(r"[a-z_]{1,64}", code) else "native_client_failed",
                              ciJobsAdmitted=False, guestIsolationVerified=False)
                guest.publish(arguments[2], helper.report_bytes(report))
            except Exception:
                pass
        print('{"stage":"failed_preserved","ciJobsAdmitted":false}')
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
