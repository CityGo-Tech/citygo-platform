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
           '"Source":{{with index .Config "Labels"}}{{json (index . "org.opencontainers.image.source")}}{{else}}null{{end}},'
           '"Revision":{{with index .Config "Labels"}}{{json (index . "org.opencontainers.image.revision")}}{{else}}null{{end}}}')
# Official PostgreSQL images may omit Config.Labels entirely. Docker templates
# reject .Config.Labels in that case; index treats the optional map key as absent.
# App labels remain mandatory in verify_image; PostgreSQL is bound by digest/ID.
MANIFEST_TYPES = {"application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json"}
CONFIG_TYPES = {"application/vnd.oci.image.config.v1+json",
                "application/vnd.docker.container.image.v1+json"}
INDEX_TYPES = {"application/vnd.oci.image.index.v1+json",
               "application/vnd.docker.distribution.manifest.list.v2+json"}


def reference(value):
    b.require(t.matches(value, r"(?:ghcr\.io/citygo-tech/citygo-platform-(?:api|web|jobs)|postgres)@" + t.DIGEST), "image-reference")
    return value


class Store:
    def __init__(self, directory):
        b.require(sys.platform.startswith("linux"), "linux-required")
        self.directory = Path(directory)
        b.require(self.directory.is_absolute(), "image-directory")
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
        # Optional operator-staged metadata, addressed ONLY by its expected hash.
        # It is not an approval and never supplies executable commands/URLs.
        path = self.directory / "image-content" / (digest.split(":")[1] + ".json")
        try:
            path.lstat()
        except FileNotFoundError:
            pass
        else:
            return t.read_file(path, private=True)
        # Fixed local socket/namespace. Never ctr images pull or registry access.
        return self._read("ctr", ["--address", "/run/containerd/containerd.sock", "--namespace", "moby", "content", "get", digest])


def content(data, digest):
    b.require(type(data) is bytes and len(data) <= t.LIMIT
              and "sha256:" + t.sha256(data) == digest, "image-content-hash")
    value = t.strict_json(data)
    b.require(type(value) is dict, "image-content-schema")
    return value


def content_link(store, link, types):
    b.require(type(link) is dict and link.get("mediaType") in types
              and t.matches(link.get("digest"), t.DIGEST)
              and type(link.get("size")) is int and 0 < link["size"] <= t.LIMIT
              and not {"urls", "data"} & set(link), "image-content-link")
    raw = store.blob(link["digest"])
    value = content(raw, link["digest"])
    b.require(len(raw) == link["size"], "image-content-size")
    return value


def platform_manifest(index):
    """One runnable amd64 image; auxiliary attestations can never be selected.

    This deliberately does not implement recursive indexes or first-match
    ambiguity resolution. Releases are built for one explicit platform.
    """
    b.require(type(index.get("schemaVersion")) is int and index["schemaVersion"] == 2
              and index.get("mediaType") in INDEX_TYPES
              and type(index.get("manifests")) is list
              and 1 <= len(index["manifests"]) <= 32, "image-index")
    runnable, auxiliary, seen = [], [], set()
    for link in index["manifests"]:
        b.require(type(link) is dict and link.get("mediaType") in MANIFEST_TYPES
                  and t.matches(link.get("digest"), t.DIGEST)
                  and link["digest"] not in seen and type(link.get("size")) is int
                  and 0 < link["size"] <= t.LIMIT and not {"urls", "data"} & set(link), "image-index-link")
        seen.add(link["digest"])
        annotations = link.get("annotations", {})
        b.require(type(annotations) is dict and len(annotations) <= 32
                  and all(type(k) is str and type(v) is str and len(k) <= 256 and len(v) <= 4096
                          for k, v in annotations.items()), "image-index-annotations")
        platform = link.get("platform")
        if platform == {"os": "linux", "architecture": "amd64"}:
            b.require("vnd.docker.reference.type" not in annotations
                      and "artifactType" not in link, "image-index-platform")
            runnable.append(link)
        else:
            b.require(platform == {"os": "unknown", "architecture": "unknown"}
                      and annotations.get("vnd.docker.reference.type") == "attestation-manifest",
                      "image-index-platform")
            auxiliary.append(link)
    b.require(len(runnable) == 1, "image-index-platform")
    selected = runnable[0]
    b.require(all(link["annotations"].get("vnd.docker.reference.digest") == selected["digest"]
                  for link in auxiliary), "image-index-attestation")
    return selected


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
    if descriptor is None and info["Id"] == tested_id:
        pass
    else:
        # A backend may expose config, platform manifest or index as its ID.
        # Never accept that difference by labels alone: hash the entire selected
        # metadata chain and bind it back to Docker's actual config/RootFS.
        root_id = ref.split("@")[1]
        raw = store.blob(root_id)
        manifest = content(raw, root_id)
        if descriptor is not None:
            b.require(type(descriptor) is dict and descriptor.get("digest") == root_id
                      and descriptor.get("mediaType") in MANIFEST_TYPES | INDEX_TYPES
                      and descriptor["mediaType"] == manifest.get("mediaType"), "image-descriptor")
            b.require(type(descriptor.get("size")) is int and descriptor["size"] == len(raw), "image-content-size")
        manifest_id, indexed = root_id, manifest.get("mediaType") in INDEX_TYPES
        if indexed:
            selected = platform_manifest(manifest)
            manifest_id = selected["digest"]
            manifest = content_link(store, selected, MANIFEST_TYPES)
            b.require(manifest.get("mediaType") == selected["mediaType"], "image-manifest")
        link = manifest.get("config")
        b.require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 2
                  and manifest.get("mediaType") in MANIFEST_TYPES and type(link) is dict
                  and link.get("mediaType") in CONFIG_TYPES and t.matches(link.get("digest"), t.DIGEST)
                  and "artifactType" not in manifest and "subject" not in manifest, "image-manifest")
        config_id = link["digest"]
        b.require(tested_id in (config_id, manifest_id, root_id), "image-tested-id")
        raw_config = store.blob(config_id)
        config = content(raw_config, config_id)
        # A classic backend without Descriptor must expose the verified config
        # ID. Other native IDs require a matching, fully verified descriptor.
        b.require(info["Id"] in ((config_id,) if descriptor is None else (config_id, manifest_id, root_id)), "image-local-id")
        b.require(type(link.get("size")) is int and link["size"] == len(raw_config), "image-content-size")
        b.require(config.get("os") == "linux" and config.get("architecture") == "amd64", "image-platform")
        b.require(type(config.get("rootfs")) is dict and config["rootfs"].get("type") == "layers"
                  and config["rootfs"].get("diff_ids") == rootfs["Layers"], "image-config-rootfs")
        b.require(type(config.get("config")) is dict, "image-config-source")
        labels = config["config"].get("Labels", {})
        b.require(type(labels) is dict and labels.get(LABELS[0]) == SOURCE
                  and labels.get(LABELS[1]) == sha, "image-config-source")
        mode = ("classic-index-content" if indexed else "classic-content") if descriptor is None else (
            "containerd-index-content" if indexed else "containerd-content")
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
