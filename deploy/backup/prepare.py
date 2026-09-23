"""Reviewed-controller building block: closed ingress -> drain -> fresh backup.

No CLI, migration, image download, removal, restart, admission reopening or unlock.
Scope is the declared Compose project on one host, not arbitrary DB clients/root.
"""
import copy
import http.client
import json
import os
from pathlib import Path
import re
import socket
import ssl
import tempfile
import time

import backup as b
import release as r
import target as t
import worker as w

SERVICES = {"api", "web", "postgres", "worker", "migrator", "backup"}
GRACE = {"api": 330, "worker": 90}


def hostname(origin):
    # Canonical ASCII HTTPS origin only. No credentials, path, custom port or IP.
    b.require(type(origin) is str and re.fullmatch(
        r"https://(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", origin), "ingress-origin")
    return origin[8:]


def expected_images(images):
    b.require(type(images) is dict and set(images) == SERVICES, "expected-images")
    b.require(all(type(v) is str and re.fullmatch(r"sha256:[0-9a-f]{64}", v) for v in images.values()), "expected-images")
    return copy.deepcopy(images)


def maintenance_response(status, headers, body):
    b.require(status == 503 and len(body) <= 4096, "ingress-not-closed")
    b.require(headers.get("cache-control") == "no-store"
              and headers.get("x-citygo-contract-version") == "1"
              and headers.get("content-type", "").startswith("application/json"), "ingress-not-closed")
    request_id = headers.get("x-request-id", "")
    b.require(re.fullmatch(r"[0-9a-f]{32}", request_id), "ingress-not-closed")
    try:
        value = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise b.BackupError("ingress-not-closed") from None
    b.require(type(value) is dict and value.get("code") == "SERVICE_UNAVAILABLE" and value.get("contractVersion") == "1"
              and value.get("retryable") is False and value.get("requestId") == request_id, "ingress-not-closed")


class _LoopbackTLS(http.client.HTTPSConnection):
    def connect(self):
        # Never follow DNS to another host or use inherited proxies. Certificate
        # validation and SNI still use the declared origin, NOT 127.0.0.1.
        raw = socket.create_connection(("127.0.0.1", 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class Host(w.Docker):
    def __init__(self, config, directory, ingress_directory, origin):
        super().__init__(config, directory)
        self.project = config["project"]
        self.ingress = b.protected(ingress_directory, directory=True, private=False)
        self.host = hostname(origin)
        self.context = ssl.create_default_context()

    def close_ingress(self):
        marker = self.ingress / "traffic-open"
        if os.path.lexists(marker):
            b.protected(marker, private=False).unlink()
        b.sync_directory(self.ingress)
        self.assert_closed()

    def assert_closed(self):
        b.protected(self.ingress, directory=True, private=False)
        b.require(not os.path.lexists(self.ingress / "traffic-open"), "ingress-not-closed")
        for path in ("/", "/api/ready"):
            connection = _LoopbackTLS(self.host, timeout=10, context=self.context)
            try:
                connection.request("GET", path, headers={"Host": self.host, "Connection": "close"})
                response = connection.getresponse()
                maintenance_response(response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(4097))
            finally:
                connection.close()

    def inventory(self):
        ids = self.capture(["ps", "--all", "--no-trunc", "--format", "{{.ID}}",
                            "--filter", "label=com.docker.compose.project=" + self.project]).splitlines()
        b.require(3 <= len(ids) <= 64 and len(set(ids)) == len(ids)
                  and all(re.fullmatch(r"[0-9a-f]{64}", i) for i in ids), "container-inventory")
        values = [self.inspect(i) for i in ids]
        b.require(all(value.get("Id") == ident for value, ident in zip(values, ids)), "container-target")
        return values

    def stop_writer(self, container):
        role = container["Labels"]["com.docker.compose.service"]
        b.require(role in GRACE, "stop-target")
        self.capture(["stop", "--signal", "SIGTERM", "--timeout", str(GRACE[role]), container["Id"]],
                     timeout=GRACE[role] + 30)

    def database_network(self):
        value = json.loads(self.capture(["network", "inspect", "--format",
            '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
            self.project + "_database"]))
        b.require(value.get("Name") == self.project + "_database"
                  and value.get("Labels", {}).get("com.docker.compose.project") == self.project
                  and value.get("Labels", {}).get("com.docker.compose.network") == "database", "database-network")
        return {"id": value.get("Id"), "peers": sorted(value.get("Containers", {}))}


def validate_inventory(values, project, images, *, initial):
    b.require(type(values) is list and 3 <= len(values) <= 64, "container-inventory")
    result, counts = {}, {name: 0 for name in SERVICES}
    for value in values:
        b.require(type(value) is dict, "container-evidence")
        ident, labels, state = value.get("Id", ""), value.get("Labels", {}), value.get("State", {})
        b.require(type(ident) is str and re.fullmatch(r"[0-9a-f]{64}", ident) and ident not in result, "container-evidence")
        b.require(type(labels) is dict and type(state) is dict, "container-evidence")
        b.require(type(value.get("Name")) is str and re.fullmatch(r"/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}", value["Name"]), "container-evidence")
        role = labels.get("com.docker.compose.service")
        b.require(labels.get("com.docker.compose.project") == project and type(role) is str and role in SERVICES, "container-target")
        counts[role] += 1
        b.require(value.get("Image") == images[role], "container-image")
        b.require(type(value.get("RestartCount")) is int and value["RestartCount"] == 0, "container-restarted")
        for key in ("Paused", "Restarting", "OOMKilled"):
            b.require(state.get(key) is False, "container-state")
        b.require(state.get("Error") == "" and state.get("Status") in ("running", "exited")
                  and state.get("Running") is (state["Status"] == "running"), "container-state")
        w.timestamp(state.get("StartedAt"))
        oneoff = labels.get("com.docker.compose.oneoff")
        if role in ("api", "web", "postgres"):
            b.require(oneoff in ("False", "false") and value.get("RestartPolicy") in ("no", "unless-stopped"), "container-runtime")
        else:
            b.require(oneoff in ("True", "true") and value.get("RestartPolicy") == "no", "container-runtime")
        if role in GRACE:
            b.require(value.get("Init") is True and value.get("StopTimeout") == GRACE[role], "container-runtime")
        if role in ("web", "postgres") or (initial and role == "api"):
            b.require(state["Status"] == "running", "container-not-ready")
            if role == "postgres" or initial is True:
                b.require(state.get("Health", {}).get("Status") == "healthy", "container-not-ready")
        elif role in ("migrator", "backup") or initial is False:
            b.require(state["Status"] == "exited", "writer-active")
        if state["Status"] == "exited":
            b.require(type(state.get("ExitCode")) is int and state["ExitCode"] == 0, "unclean-exit")
            b.require(w.timestamp(state.get("FinishedAt")) >= w.timestamp(state["StartedAt"]), "container-evidence")
        result[ident] = copy.deepcopy(value)
    b.require(all(counts[name] == 1 for name in ("api", "web", "postgres")), "container-replicas")
    return result


def identity(value):
    # Never persist environment, health logs, mounts or arbitrary engine errors.
    return {"id": value["Id"], "image": value["Image"], "name": value.get("Name"),
            "role": value["Labels"]["com.docker.compose.service"],
            "started_at": value["State"]["StartedAt"], "restart_count": value["RestartCount"],
            "init": value.get("Init"), "grace": value.get("StopTimeout"),
            "restart_policy": value["RestartPolicy"]}


def same_inventory(before, after):
    b.require(set(before) == set(after), "container-set-changed")
    b.require(all(identity(before[i]) == identity(after[i]) for i in before), "container-replaced")


def stopped_cleanly(value):
    state = value["State"]
    b.require(state.get("Status") == "exited" and state.get("Running") is False
              and type(state.get("ExitCode")) is int and state["ExitCode"] == 0
              and state.get("Error") == ""
              and all(state.get(k) is False for k in ("Paused", "Restarting", "OOMKilled")), "unclean-exit")
    b.require(w.timestamp(state.get("FinishedAt")) >= w.timestamp(state["StartedAt"]), "container-evidence")


def evidence(value):
    return {**identity(value), "status": value["State"]["Status"],
            "exit_code": value["State"].get("ExitCode"), "finished_at": value["State"].get("FinishedAt")}


def check_network(network, containers, original=None):
    b.require(type(network) is dict and type(network.get("id")) is str
              and re.fullmatch(r"[0-9a-f]{64}", network["id"]), "database-network")
    peers = network.get("peers")
    b.require(type(peers) is list and all(type(i) is str for i in peers)
              and len(set(peers)) == len(peers), "database-network")
    allowed = {i for i, v in containers.items() if identity(v)["role"] != "web"}
    required = {i for i in allowed if containers[i]["State"]["Running"]}
    b.require(required <= set(peers) <= allowed, "database-network-peers")
    if original is not None:
        b.require(network["id"] == original["id"], "database-network-changed")


def prepare(config, target_sha, origin, ingress_directory, images, *, allow_stop=False,
            allow_upload=False, selection=None, host_factory=Host, storage_factory=b.S3, encryptor=b.encrypt, min_free=b.MIN_FREE):
    """Prepare only; keep pending/ingress closed on success AND every failure.

    Explicit booleans are required by trusted callers. No command/config hook or
    CLI exposes the injected transports (only the disposable tests replace them).
    """
    b.require(allow_stop is True and allow_upload is True, "explicit-prepare-permission-required")
    config = copy.deepcopy(b.validate(config))
    images = expected_images(images)
    hostname(origin)
    b.require(type(target_sha) is str and re.fullmatch(r"[0-9a-f]{40}", target_sha), "release-target")
    b.require(config["upload_enabled"], "upload-disabled")
    ingress_directory = b.protected(ingress_directory, directory=True, private=False)
    b.require(type(selection) is t.Selection, "target-selection-required")
    selected = selection.verify(config, target_sha, origin, images)
    def check_selection():
        b.require(selection.verify(config, target_sha, origin, images) == selected, "target-selection-changed")
    # Closing admission is restrictive and does not interrupt an active Worker.
    # If one still owns maintenance.lock, entry fails; there is no polling/retry.
    w.pause(config)
    with r.release_window(config, target_sha) as window:
        state = b.protected(config["state_dir"], directory=True)
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=state) as temp:
            host = host_factory(config, Path(temp), ingress_directory, origin)
            host.close_ingress()
            before = validate_inventory(host.inventory(), config["project"], images, initial=True)
            network = host.database_network()
            check_network(network, before)
            # Stop only fully validated API/Worker IDs, never names/wildcards.
            for ident, value in sorted(before.items(), key=lambda pair: (identity(pair[1])["role"] != "api", pair[0])):
                role = identity(value)["role"]
                if role not in GRACE or not value["State"]["Running"]:
                    continue
                current_set = validate_inventory(host.inventory(), config["project"], images, initial=None)
                same_inventory(before, current_set)
                check_network(host.database_network(), current_set, network)
                current = current_set[ident]
                if current["State"]["Running"]:
                    host.stop_writer(current)
                after = host.inspect(ident)
                b.require(identity(after) == identity(value), "container-replaced")
                stopped_cleanly(after)
            stopped = validate_inventory(host.inventory(), config["project"], images, initial=False)
            same_inventory(before, stopped)
            check_network(host.database_network(), stopped, network)
            host.assert_closed()
            check_selection()
            checkpoint = window.backup(storage_factory=storage_factory, encryptor=encryptor, min_free=min_free)
            final = validate_inventory(host.inventory(), config["project"], images, initial=False)
            same_inventory(stopped, final)
            final_network = host.database_network()
            check_network(final_network, final, network)
            host.assert_closed()
            proof = {"version": 1, "operation_id": checkpoint["operation_id"], "target_sha": target_sha,
                     "origin": origin, "ingress_directory": str(ingress_directory),
                     "target": selected,
                     "database_network": final_network, "containers": [evidence(final[i]) for i in sorted(final)],
                     "backup": checkpoint["backup"], "prepared_at": time.time(), "migration_authorized": False}
        window._check()  # Cleanup too must finish before any prepared receipt.
        check_selection()
        b.atomic_json(state / "release-prepared.json", proof)
        return copy.deepcopy(proof)
