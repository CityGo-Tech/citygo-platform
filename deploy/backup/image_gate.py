"""Local-only release image verification. No pull, login, run, tag or removal.

Requires a separately verified Selection projection. Neither OCI labels nor this
receipt authorize a release. The local privileged Docker/content stores are trusted.
"""
import copy
from pathlib import Path
import subprocess
import sys

import backup as b
import target as t

SOURCE = "https://github.com/" + t.REPOSITORY
LABELS = ("org.opencontainers.image.source", "org.opencontainers.image.revision")
INSPECT = ('{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},'
           '"Os":{{json .Os}},"Architecture":{{json .Architecture}},'
           '"Descriptor":{{json (index . "Descriptor")}},"RootFS":{{json .RootFS}},'
           '"Source":{{if .Config.Labels}}{{json (index .Config.Labels "org.opencontainers.image.source")}}{{else}}null{{end}},'
           '"Revision":{{if .Config.Labels}}{{json (index .Config.Labels "org.opencontainers.image.revision")}}{{else}}null{{end}}}')
MANIFEST_TYPES = {"application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json"}
CONFIG_TYPES = {"application/vnd.oci.image.config.v1+json",
                "application/vnd.docker.container.image.v1+json"}


def reference(value):
    b.require(t.matches(value, r"(?:ghcr\.io/citygo-tech/citygo-platform-(?:api|web|jobs)|postgres)@" + t.DIGEST), "image-reference")
    return value


class Store:
    def __init__(self, directory):
        b.require(sys.platform.startswith("linux"), "linux-required")
        self.env = b.clean_env(Path(directory))

    def _read(self, program, args):
        try:
            result = subprocess.run([b.executable(program), *args], env=self.env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
                start_new_session=True, preexec_fn=b.limits)
            b.require(result.returncode == 0 and len(result.stdout) <= t.LIMIT, "image-local-unavailable")
            return result.stdout
        except (OSError, subprocess.SubprocessError):
            raise b.BackupError("image-local-unavailable") from None

    def inspect(self, ref):
        return t.strict_json(self._read("docker", ["image", "inspect", "--format", INSPECT, reference(ref)]))

    def blob(self, digest):
        b.require(t.matches(digest, t.DIGEST), "image-content-digest")
        # Fixed local socket/namespace. Never ctr images pull or registry access.
        return self._read("ctr", ["--address", "/run/containerd/containerd.sock", "--namespace", "moby", "content", "get", digest])


def content(data, digest):
    b.require(type(data) is bytes and len(data) <= t.LIMIT
              and "sha256:" + t.sha256(data) == digest, "image-content-hash")
    value = t.strict_json(data)
    b.require(type(value) is dict, "image-content-schema")
    return value


def verify_image(store, ref, tested_id, sha):
    reference(ref)
    b.require(t.matches(tested_id, t.DIGEST) and t.matches(sha, t.SHA), "image-expectation")
    info = store.inspect(ref)
    b.require(type(info) is dict and t.matches(info.get("Id"), t.DIGEST), "image-inspection")
    b.require(info.get("Os") == "linux" and info.get("Architecture") == "amd64", "image-platform")
    peers = info.get("RepoDigests")
    b.require(type(peers) is list and all(type(v) is str for v in peers) and ref in peers, "image-repository-digest")
    b.require(info.get("Source") == SOURCE and info.get("Revision") == sha, "image-source")
    rootfs = info.get("RootFS")
    b.require(type(rootfs) is dict and rootfs.get("Type") == "layers"
              and type(rootfs.get("Layers")) is list and 0 < len(rootfs["Layers"]) <= 256
              and all(t.matches(v, t.DIGEST) for v in rootfs["Layers"]), "image-rootfs")
    descriptor = info.get("Descriptor")
    config_id = tested_id
    mode = "classic-config"
    if descriptor is None:
        b.require(info["Id"] == tested_id, "image-tested-id")
    else:
        # Docker's containerd backend may return manifest digest in .Id, NOT
        # the config digest recorded by a classic-store CI. Hash both local
        # blobs and verify manifest -> config -> RootFS/OCI source/revision.
        manifest_id = ref.split("@")[1]
        b.require(type(descriptor) is dict and descriptor.get("digest") == manifest_id
                  and descriptor.get("mediaType") in MANIFEST_TYPES, "image-descriptor")
        raw = store.blob(manifest_id)
        manifest = content(raw, manifest_id)
        b.require(type(descriptor.get("size")) is int and descriptor["size"] == len(raw), "image-content-size")
        link = manifest.get("config")
        b.require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 2
                  and manifest.get("mediaType") in MANIFEST_TYPES and type(link) is dict
                  and link.get("mediaType") in CONFIG_TYPES and t.matches(link.get("digest"), t.DIGEST), "image-manifest")
        config_id = link["digest"]
        b.require(tested_id in (config_id, manifest_id), "image-tested-id")
        raw_config = store.blob(config_id)
        config = content(raw_config, config_id)
        # Backend/API versions can expose either config or manifest in .Id.
        # Neither is accepted until BOTH blobs have been hashed and linked.
        b.require(info["Id"] in (config_id, manifest_id), "image-local-id")
        b.require(type(link.get("size")) is int and link["size"] == len(raw_config), "image-content-size")
        b.require(config.get("os") == "linux" and config.get("architecture") == "amd64", "image-platform")
        b.require(type(config.get("rootfs")) is dict and config["rootfs"].get("type") == "layers"
                  and config["rootfs"].get("diff_ids") == rootfs["Layers"], "image-config-rootfs")
        b.require(type(config.get("config")) is dict, "image-config-source")
        labels = config["config"].get("Labels", {})
        b.require(type(labels) is dict and labels.get(LABELS[0]) == SOURCE
                  and labels.get(LABELS[1]) == sha, "image-config-source")
        mode = "containerd-content"
    return {"reference": ref, "local_id": info["Id"], "tested_id": tested_id,
            "config_id": config_id, "source_sha": sha, "mode": mode}


def verify(store, selected, current_images):
    """Called only after Selection.verify(), and re-run at each prepare boundary.

    This projection is NOT a capability: never trust a saved receipt for execution.
    """
    current = selected["current"]
    result = {"current": {}, "target": {}}
    for name, refs, ids, sha in (("current", current["images"], current["image_ids"], current["source_sha"]),
                                ("target", selected["images"], selected["image_ids"], selected["target_sha"])):
        t.keys(refs, t.ROLES, "image-expectation"); t.keys(ids, t.ROLES, "image-expectation")
        for role in sorted(t.ROLES):
            b.require(t.matches(refs[role], "ghcr\\.io/citygo-tech/citygo-platform-" + role + "@" + t.DIGEST), "image-reference")
            result[name][role] = verify_image(store, refs[role], ids[role], sha)
    mapping = {"api": "api", "web": "web", "worker": "jobs", "migrator": "jobs"}
    b.require(all(current_images[role] == result["current"][image]["local_id"] for role, image in mapping.items()), "image-current-binding")
    # PostgreSQL/backup remain the exact independently approved local ID and
    # immutable base reference. No DB version/architecture upgrade in this path.
    pg = current["postgres"]
    b.require(t.matches(pg, r"postgres:17-alpine@" + t.DIGEST), "image-reference")
    ref = "postgres@" + pg.split("@")[1]
    info = store.inspect(ref)
    b.require(type(info) is dict and info.get("Id") == current_images["postgres"] == current_images["backup"]
              and info.get("Os") == "linux" and info.get("Architecture") == "amd64"
              and type(info.get("RepoDigests")) is list and ref in info["RepoDigests"], "image-postgres-binding")
    result["postgres"] = {"reference": ref, "local_id": info["Id"]}
    result["migration_authorized"] = False
    return copy.deepcopy(result)
