"""Pure offline bootstrap draft compiler. No IO, executor or live attestation.

The caller supplies canonical bytes and reviewed metadata. Originals remain
byte-for-byte copies; only two API properties change in the prepared copy.
Nothing here creates a production WebSwitchPlan or an installation permission.
"""
import copy
import hashlib
import json
from pathlib import PurePosixPath
import re


LIMIT = 512 * 1024
MIB = 1024 * 1024
PROJECT = "citygo-pilot"
REQUEST_PURPOSE = "citygo-web-bootstrap-draft-request-v1"
PURPOSE = "citygo-web-bootstrap-draft-v1"
HASH = r"[a-f0-9]{64}"
SHA = r"[a-f0-9]{40}"
IMAGE = "sha256:" + HASH
OLD_CIDR = "172.30.92.10/32"
NEW_CIDRS = OLD_CIDR + ",172.30.92.20/32"
PROFILES = frozenset((
    "routerai-credit-v1", "routerai-citygo-10x-v1",
    "routerai-citygo-10x-yookassa-live-v1", "routerai-citygo-10x-yookassa-live-cn-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-v2",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-smsru-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-v1",
    "postpay-actual-v1", "postpay-context64-v1", "postpay-memory-v1", "postpay-native-search-v1",
))
AUTHORIZES = {name: False for name in ("install", "stop", "recreate", "start", "reload", "traffic", "worker", "switch", "rollback")}
PENDING_EVIDENCE = (
    "explicit-owner-authorization-for-installation",
    "fresh-pre-bootstrap-live-inventory-and-all-input-pins",
    "fresh-encrypted-backup-and-isolated-restore",
    "disk-space-above-backup-floor-and-capacity-under-load",
    "external-reload-exclusion-through-pending-settlement",
    "nginx-symlink-and-tls-preservation",
    "actual-image-assets-and-protected-controller-installation",
    "separate-installer-and-canonical-return-reconciliation",
    "fresh-post-bootstrap-v2-runtime-file-and-process-pins",
)


class BootstrapError(Exception):
    """Only fixed diagnostic codes, never original JSON or secret values."""


def require(condition, code):
    if not condition:
        raise BootstrapError(code)


def matches(value, expression):
    return type(value) is str and re.fullmatch(expression, value) is not None


def keys(value, expected, code):
    require(type(value) is dict and set(value) == set(expected), code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wire(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")


def strict_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= LIMIT, "input-size")

    def pairs(items):
        result = {}
        for name, item in items:
            require(name not in result, "duplicate-json-key")
            result[name] = item
        return result

    def constant(_):
        raise BootstrapError("nonfinite-json")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise BootstrapError("invalid-json") from None


def server_path(value):
    require(matches(value, r"/[A-Za-z0-9_./-]+") and len(value) <= 4096
            and "//" not in value and ".." not in PurePosixPath(value).parts
            and str(PurePosixPath(value)) == value and value != "/", "request-pins")
    return value


def pin(value):
    keys(value, ("path", "sha256"), "request-pins")
    server_path(value["path"])
    require(matches(value["sha256"], HASH), "request-pins")


def restart(value, name):
    keys(value, ("Name", "MaximumRetryCount"), "request-baseline")
    require(value["Name"] == name and type(value["MaximumRetryCount"]) is int
            and value["MaximumRetryCount"] == 0, "request-baseline")


def request(value, now):
    keys(value, ("version", "purpose", "operation_id", "observed_at", "expires_at", "observation_sha256",
                 "inventory_complete", "origin", "source_sha", "images", "baseline", "web_network",
                 "originals", "secret_pins", "gates"), "request-shape")
    require(type(value["version"]) is int and value["version"] == 1 and value["purpose"] == REQUEST_PURPOSE,
            "request-purpose")
    require(matches(value["operation_id"], r"[a-f0-9]{32}"), "request-operation")
    require(type(now) is int and type(value["observed_at"]) is int and type(value["expires_at"]) is int
            and 0 <= value["observed_at"] <= now < value["expires_at"] <= value["observed_at"] + 3600,
            "request-time")
    require(matches(value["observation_sha256"], HASH) and value["inventory_complete"] is True, "request-gates")
    require(matches(value["origin"], r"https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}"),
            "request-origin")
    require(matches(value["source_sha"], SHA), "request-source")
    keys(value["images"], ("api", "web"), "request-image")
    for image in value["images"].values():
        keys(image, ("id", "source_sha"), "request-image")
        require(matches(image["id"], IMAGE) and image["source_sha"] == value["source_sha"], "request-image")
    baseline = value["baseline"]
    keys(baseline, ("api_id", "web_id", "postgres_id", "inventory_sha256", "api_restart", "web_restart", "postgres_restart"),
         "request-baseline")
    ids = [baseline[name + "_id"] for name in ("api", "web", "postgres")]
    require(all(matches(ident, HASH) for ident in ids) and len(set(ids)) == 3
            and matches(baseline["inventory_sha256"], HASH), "request-baseline")
    for name, policy in (("api", "no"), ("web", "no"), ("postgres", "unless-stopped")):
        restart(baseline[name + "_restart"], policy)
    keys(value["web_network"], ("id", "name"), "request-network")
    require(matches(value["web_network"]["id"], HASH) and value["web_network"]["name"] == PROJECT + "_web_api",
            "request-network")
    keys(value["originals"], ("compose", "env", "backup_config", "active_release", "autodeploy_current"), "request-pins")
    require(type(value["secret_pins"]) is list and len(value["secret_pins"]) == 3, "request-pins")
    all_pins = list(value["originals"].values()) + value["secret_pins"]
    for item in all_pins:
        pin(item)
    require(len({p["path"] for p in all_pins}) == len(all_pins), "request-pins")
    keys(value["gates"], ("pending", "worker_admission_open", "autodeploy_enabled"), "request-gates")
    require(all(item is False for item in value["gates"].values()), "request-gates")
    return value


def safe_tree(value, depth=0, budget=None):
    """Reject interpolation and hidden arbitrary Compose control directives."""
    if budget is None:
        budget = [10000]
    budget[0] -= 1
    require(depth <= 32 and budget[0] >= 0, "canonical-unsafe")
    require(type(value) in (dict, list, str, int, bool), "canonical-unsafe")
    if type(value) is str:
        require("$" not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value), "canonical-unsafe")
    elif type(value) is dict:
        for name, child in value.items():
            require(type(name) is str and name not in {"build", "include", "extends", "env_file", "post_start", "pre_stop", "develop"},
                    "canonical-unsafe")
            safe_tree(name, depth + 1, budget)
            safe_tree(child, depth + 1, budget)
    elif type(value) is list:
        for child in value:
            safe_tree(child, depth + 1, budget)


COMMON = {"init", "read_only", "user", "restart", "cap_drop", "security_opt", "pids_limit", "mem_limit",
          "memswap_limit", "tmpfs", "entrypoint", "working_dir", "logging", "image", "command", "stop_grace_period"}
OPS_COMMON = (COMMON - {"command", "working_dir"}) | {"profiles", "networks"}
LOGGING = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}


def shared(service, memory, *, ops=False):
    require(service["init"] is True and service["read_only"] is True and service["restart"] == "no"
            and service["cap_drop"] == ["ALL"] and service["security_opt"] == ["no-new-privileges:true"]
            and type(service["pids_limit"]) is int and service["pids_limit"] == 128
            and type(service["mem_limit"]) is int and service["mem_limit"] == memory
            and type(service["memswap_limit"]) is int and service["memswap_limit"] == memory
            and service["logging"] == LOGGING and matches(service["image"], IMAGE), "canonical-runtime")
    if ops:
        require(service["profiles"] == ["ops"] and service["networks"] == ["database"]
                and service["tmpfs"] == ["/tmp:size=64m,mode=1777"], "canonical-runtime")


def health(value, role):
    expected = {"test": ["CMD", "node", "scripts/container-health.mjs", role], "interval": "5s", "timeout": "5s",
                "start_period": "15s", "retries": 12}
    require(value == expected and type(value.get("retries")) is int, "canonical-runtime")


def canonical(value, req):
    safe_tree(value)
    keys(value, ("name", "services", "secrets", "networks"), "canonical-shape")
    require(value["name"] == PROJECT, "canonical-shape")
    keys(value["services"], ("api", "web", "worker", "backup"), "canonical-shape")
    api, web, worker, backup = (value["services"][name] for name in ("api", "web", "worker", "backup"))
    keys(api, COMMON | {"environment", "secrets", "networks", "healthcheck"}, "canonical-shape")
    keys(web, COMMON | {"environment", "ports", "networks", "depends_on", "healthcheck"}, "canonical-shape")
    keys(worker, OPS_COMMON | {"command", "working_dir", "environment", "secrets"}, "canonical-shape")
    keys(backup, OPS_COMMON | {"volumes", "secrets"}, "canonical-shape")
    for role, service in (("api", api), ("web", web)):
        shared(service, 768 * MIB)
        require(service["user"] == "1000:1000" and service["working_dir"] == "/app"
                and service["entrypoint"] == ["node", "scripts/container-runtime.mjs"]
                and service["command"] == [role] and service["stop_grace_period"] == ("330s" if role == "api" else "30s"),
                "canonical-runtime")
        require(service["image"] == req["images"][role]["id"], "canonical-image-binding")
        health(service["healthcheck"], role)
    env = api["environment"]
    common_env = {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0", "API_PORT": "4000",
                  "WEB_ORIGIN": req["origin"], "TRUSTED_PROXY_CIDRS": OLD_CIDR}
    require(type(env) is dict, "canonical-environment")
    if env.get("LLM_PROVIDER") == "disabled":
        expected_env = {**common_env, "LLM_PROVIDER": "disabled"}
    else:
        require(env.get("LLM_PROVIDER") == "routerai" and type(env.get("CITYGO_AI_PROFILE")) is str
                and env["CITYGO_AI_PROFILE"] in PROFILES, "canonical-environment")
        expected_env = {**common_env, "LLM_PROVIDER": "routerai", "CITYGO_AI_PROFILE": env["CITYGO_AI_PROFILE"]}
    require(env == expected_env and web["environment"] == {"PORT": "3000"}, "canonical-environment")
    require(api["tmpfs"] == ["/tmp:size=64m,mode=1777"]
            and web["tmpfs"] == ["/tmp:size=64m,mode=1777", "/app/apps/web/.next/cache:size=64m,uid=1000,gid=1000"]
            and web["ports"] == ["127.0.0.1:3000:3000"]
            and web["depends_on"] == {"api": {"condition": "service_healthy"}}, "canonical-runtime")
    require(api["networks"] == {"web_api": {"ipv4_address": "172.30.92.11"}, "database": {}}
            and web["networks"] == {"web_api": {"ipv4_address": "172.30.92.10"}}, "canonical-network")
    require(value["networks"] == {name: {"external": True, "name": PROJECT + "_" + name}
                                  for name in ("web_api", "database")}
            and all(item["external"] is True for item in value["networks"].values()), "canonical-network")
    keys(value["secrets"], ("api_config", "worker_config", "db_backup_password"), "canonical-secrets")
    for item in value["secrets"].values():
        keys(item, ("file",), "canonical-secrets")
        server_path(item["file"])
    secret_paths = [item["file"] for item in value["secrets"].values()]
    require(len(set(secret_paths)) == 3 and set(secret_paths) == {p["path"] for p in req["secret_pins"]}, "canonical-secrets")
    require(api["secrets"] == [{"source": "api_config", "target": "api.json"}]
            and worker["secrets"] == [{"source": "worker_config", "target": "worker.json"}]
            and backup["secrets"] == ["db_backup_password"], "canonical-secrets")
    for service in (worker, backup):
        shared(service, 256 * MIB, ops=True)
    require(worker["user"] == "1000:1000" and worker["entrypoint"] == ["node", "scripts/container-runtime.mjs"]
            and worker["working_dir"] == "/app" and worker["command"] == ["worker"]
            and worker["stop_grace_period"] == "90s" and worker["environment"] == {"CITYGO_MOUNTED_CONFIG": "1"},
            "canonical-runtime")
    dump = str(PurePosixPath(req["originals"]["compose"]["path"]).parent / "dump.sh")
    require(backup["user"] == "postgres" and backup["entrypoint"] == ["sh", "/opt/citygo/dump.sh"]
            and backup["stop_grace_period"] == "30s"
            and backup["volumes"] == [{"type": "bind", "source": dump, "target": "/opt/citygo/dump.sh", "read_only": True}]
            and backup["volumes"][0]["read_only"] is True, "canonical-runtime")
    return value


def compile_draft(canonical_raw, request_raw, now):
    """Compile immutable review files. This function performs no external work."""
    req = request(strict_json(request_raw), now)
    require(type(canonical_raw) is bytes and 0 < len(canonical_raw) <= LIMIT, "input-size")
    require(digest(canonical_raw) == req["originals"]["compose"]["sha256"], "canonical-hash")
    original = canonical(strict_json(canonical_raw), req)
    prepared = copy.deepcopy(original)
    prepared["services"]["api"]["environment"]["TRUSTED_PROXY_CIDRS"] = NEW_CIDRS
    prepared["services"]["api"]["restart"] = "unless-stopped"
    forward = [
        {"path": "/services/api/environment/TRUSTED_PROXY_CIDRS", "before": OLD_CIDR, "after": NEW_CIDRS},
        {"path": "/services/api/restart", "before": "no", "after": "unless-stopped"},
    ]
    reverse = [{"path": item["path"], "before": item["after"], "after": item["before"]} for item in forward]
    returned = copy.deepcopy(prepared)
    returned["services"]["api"]["environment"]["TRUSTED_PROXY_CIDRS"] = OLD_CIDR
    returned["services"]["api"]["restart"] = "no"
    require(returned == original, "draft-invariant")
    slot = copy.deepcopy(original["services"]["web"])
    del slot["depends_on"]
    slot["restart"] = "unless-stopped"
    slot["ports"] = ["127.0.0.1:3001:3000"]
    slot["networks"]["web_api"]["ipv4_address"] = "172.30.92.20"
    slot2 = {"name": "citygo-web-bootstrap-" + req["operation_id"], "services": {"web": slot},
             "networks": {"web_api": copy.deepcopy(original["networks"]["web_api"])}}
    outputs = {"canonical.original.json": canonical_raw, "request.original.json": request_raw,
               "canonical.prepared.json": wire(prepared), "slot2.compose.json": wire(slot2)}
    require(all(0 < len(raw) <= LIMIT for raw in outputs.values()), "output-size")
    draft = {
        "version": 1, "purpose": PURPOSE, "operation_id": req["operation_id"], "origin": req["origin"], "source_sha": req["source_sha"],
        "readyToApply": False, "productionPlan": False, "authorizes": dict(AUTHORIZES),
        "provenance": {"kind": "operator-supplied-not-live-attestation", "observation_sha256": req["observation_sha256"],
                       "inventory_sha256": req["baseline"]["inventory_sha256"], "inventory_complete": True,
                       "observed_at": req["observed_at"], "expires_at": req["expires_at"]},
        "originals": copy.deepcopy(req["originals"]), "secret_pins": copy.deepcopy(req["secret_pins"]),
        "baseline": copy.deepcopy(req["baseline"]), "web_network": copy.deepcopy(req["web_network"]),
        "files": {name: {"sha256": digest(raw), "size": len(raw)} for name, raw in outputs.items()},
        "forwardDiff": forward, "reverseDiff": reverse,
        "expectedTopology": {"api": {"count": 1, "image": req["images"]["api"]["id"], "restart": "unless-stopped", "trustedProxyCidrs": NEW_CIDRS},
                             "oldWeb": {"image": req["images"]["web"]["id"], "ip": "172.30.92.10", "port": 3000, "restart": "no"},
                             "newWeb": {"project": slot2["name"], "image": req["images"]["web"]["id"], "ip": "172.30.92.20", "port": 3001, "restart": "unless-stopped"}},
        "requiresFreshPostBootstrapPins": True, "legacyResumeAllowed": False,
        "pendingEvidence": list(PENDING_EVIDENCE),
        "returnConditions": ["verify-exact-prepared-hash-before-reverse-diff", "closed-ingress-and-drained-accepted-requests", "fresh-runtime-identities-after-api-recreation",
                             "restore-original-compose-env-config-paths-and-ingress-descriptor", "no-rewrite-of-legacy-active-or-current-receipts",
                             "fresh-legacy-approval-not-historical-resume", "no-automatic-rollback-or-pending-removal"],
    }
    outputs["draft.json"] = wire(draft)
    require(len(outputs["draft.json"]) <= LIMIT, "output-size")
    return outputs
