#!/usr/bin/python3
"""Pure IPv4 gateway policy renderer, NOT an installer or CI admission.

Only the dedicated trusted Linux gateway may consume these iptables-restore
documents. Never apply them on Windows, WSL, Docker Desktop or production.
WAN/host/production observations must be refreshed for every network change.
"""
import hashlib
import ipaddress
import json
import re
import sys


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


SPECIAL = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)
DNS = ("1.1.1.1", "8.8.8.8")
FIELDS = {
    "schemaVersion", "operationId", "hostSnapshotSha256", "wanAddressIPv4",
    "wanPrefix", "wanGatewayIPv4", "dhcpServerIPv4", "hostIPv4",
    "productionIPv4", "additionalDeniedPrefixes",
}
LAN = ipaddress.IPv4Network("10.203.0.0/30")
CLIENT = "10.203.0.2/32"
GATEWAY = "10.203.0.1"


def address(value):
    require(type(value) is str, "address_invalid")
    try:
        parsed = ipaddress.IPv4Address(value)
    except ValueError:
        raise Refused("address_invalid") from None
    require(str(parsed) == value and not parsed.is_multicast and
            not parsed.is_unspecified and int(parsed) != 4294967295, "address_invalid")
    return parsed


def prefix(value):
    require(type(value) is str, "prefix_invalid")
    try:
        parsed = ipaddress.IPv4Network(value, strict=True)
    except ValueError:
        raise Refused("prefix_invalid") from None
    require(str(parsed) == value and parsed.prefixlen >= 8, "prefix_invalid")
    return parsed


def values(value, kind, minimum, maximum):
    require(type(value) is list and minimum <= len(value) <= maximum and
            all(type(item) is str for item in value) and len(set(value)) == len(value), "list_invalid")
    return [str(kind(item)) for item in value]


def unique_json(raw):
    def pairs(items):
        output = {}
        for key, value in items:
            require(key not in output, "duplicate_key")
            output[key] = value
        return output
    try:
        require(type(raw) is str and 2 <= len(raw) <= 32768, "config_size_invalid")
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise Refused("json_invalid") from None


def render(config):
    require(type(config) is dict and set(config) == FIELDS, "config_fields_invalid")
    require(type(config["schemaVersion"]) is int and config["schemaVersion"] == 1, "version_invalid")
    operation = config["operationId"]
    require(type(operation) is str and re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", operation), "operation_invalid")
    require(type(config["hostSnapshotSha256"]) is str and
            re.fullmatch(r"[a-f0-9]{64}", config["hostSnapshotSha256"]), "snapshot_hash_required")
    wan = prefix(config["wanPrefix"])
    wan_ip, wan_gateway, dhcp = [address(config[key]) for key in
                               ("wanAddressIPv4", "wanGatewayIPv4", "dhcpServerIPv4")]
    require(not wan.overlaps(LAN) and wan.prefixlen <= 30 and all(
        item in wan and item not in (wan.network_address, wan.broadcast_address)
        for item in (wan_ip, wan_gateway, dhcp)) and wan_ip != wan_gateway and wan_ip != dhcp,
        "wan_binding_invalid")
    hosts = values(config["hostIPv4"], address, 1, 128)
    production = values(config["productionIPv4"], address, 1, 64)
    extra = values(config["additionalDeniedPrefixes"], prefix, 0, 256)
    require(str(dhcp) not in production and str(wan_gateway) not in production, "dhcp_production_collision")
    blocked = sorted(set(SPECIAL + (str(wan),) + tuple(extra) +
                         tuple(item + "/32" for item in hosts + production)),
                     key=lambda item: (int(ipaddress.IPv4Network(item).network_address),
                                       ipaddress.IPv4Network(item).prefixlen))
    # A VPN/default-route inventory must not silently turn into an allow-all or
    # an unusable policy. Explicit classification is outside this pure module.
    for resolver in DNS:
        require(not any(ipaddress.IPv4Address(resolver) in ipaddress.IPv4Network(item)
                        for item in blocked), "dns_collides_with_denial")
    lines = ["*filter", ":INPUT DROP [0:0]", ":FORWARD DROP [0:0]", ":OUTPUT DROP [0:0]",
             "-A INPUT -i lo -j ACCEPT", "-A OUTPUT -o lo -j ACCEPT",
             "-A INPUT -i lan0 -j DROP", "-A INPUT -m conntrack --ctstate INVALID -j DROP",
             "-A FORWARD -m conntrack --ctstate INVALID -j DROP",
             "-A OUTPUT -m conntrack --ctstate INVALID -j DROP",
             f"-A INPUT -i wan0 -s {dhcp}/32 -p udp --sport 67 --dport 68 -j ACCEPT",
             "-A OUTPUT -o wan0 -d 255.255.255.255/32 -p udp --sport 68 --dport 67 -j ACCEPT",
             f"-A OUTPUT -o wan0 -d {dhcp}/32 -p udp --sport 68 --dport 67 -j ACCEPT",
             f"-A FORWARD -i lan0 ! -s {CLIENT} -j DROP"]
    # Denials precede established-session acceptance, including on re-apply.
    # Incoming replies are also denied for private/special/host/prod sources.
    for item in blocked:
        lines += [f"-A FORWARD -i lan0 -d {item} -j DROP",
                  f"-A FORWARD -i wan0 -s {item} -j DROP",
                  f"-A OUTPUT -d {item} -j DROP"]
    lines += ["-A INPUT -i wan0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
              f"-A FORWARD -i wan0 -o lan0 -d {CLIENT} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
              "-A OUTPUT -o wan0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
              f"-A FORWARD -i lan0 -o wan0 -s {CLIENT} -p tcp --dport 443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT",
              "-A OUTPUT -o wan0 -p tcp --dport 443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT"]
    for resolver in DNS:
        for protocol in ("udp", "tcp"):
            lines += [f"-A FORWARD -i lan0 -o wan0 -s {CLIENT} -d {resolver}/32 -p {protocol} --dport 53 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT",
                      f"-A OUTPUT -o wan0 -d {resolver}/32 -p {protocol} --dport 53 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT"]
    lines += ["COMMIT", "*nat", ":PREROUTING ACCEPT [0:0]", ":INPUT ACCEPT [0:0]",
              ":OUTPUT ACCEPT [0:0]", ":POSTROUTING ACCEPT [0:0]",
              f"-A POSTROUTING -s {CLIENT} -o wan0 -j MASQUERADE", "COMMIT"]
    ipv4 = "\n".join(lines) + "\n"
    ipv6 = ("*filter\n:INPUT DROP [0:0]\n:FORWARD DROP [0:0]\n:OUTPUT DROP [0:0]\n"
            "-A INPUT -i lo -j ACCEPT\n-A OUTPUT -o lo -j ACCEPT\nCOMMIT\n")
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return {
        "schemaVersion": 1, "scope": "private_ci_gateway_policy_plan", "operationId": operation,
        "configSha256": hashlib.sha256(canonical.encode("ascii")).hexdigest(),
        "hostSnapshotSha256": config["hostSnapshotSha256"],
        "lanGatewayIPv4": GATEWAY, "clientIPv4": CLIENT.split("/")[0],
        "ipv4Restore": ipv4, "ipv6Restore": ipv6,
        "ipv4Sha256": hashlib.sha256(ipv4.encode("ascii")).hexdigest(),
        "ipv6Sha256": hashlib.sha256(ipv6.encode("ascii")).hexdigest(),
        "policyApplied": False, "guestIsolationVerified": False, "ciJobsAdmitted": False,
        "requiresFreshHostSnapshot": True, "indirectProxyIsolationProven": False,
    }


def main(arguments):
    try:
        require(len(arguments) == 3 and arguments[:2] == ["--plan", "--config-json"], "arguments_invalid")
        output = render(unique_json(arguments[2]))
        print(json.dumps(output, sort_keys=True, separators=(",", ":")))
        return 0
    except Refused:
        print('{"scope":"private_ci_gateway_policy_plan","stage":"refused","policyApplied":false,"ciJobsAdmitted":false}')
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
