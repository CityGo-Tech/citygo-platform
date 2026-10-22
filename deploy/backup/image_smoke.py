"""Disposable loopback registry only; no GHCR access or production entry point."""
import json
import os
from pathlib import Path
import re
import sys

import backup as b
import image_gate as g
import target as t


def main():
    b.require(os.environ.get("CI") == "true" and len(sys.argv) == 3
              and sys.argv[1] == "--disposable", "disposable-required")
    path = Path(sys.argv[2]); fixture = t.strict_json(t.read_file(path, private=True))
    address = fixture["address"]
    b.require(t.matches(address, r"127\.0\.0\.1:[1-9][0-9]{0,4}")
              and t.matches(fixture["sha"], t.SHA), "disposable-required")
    class Loopback(g.Store):
        def inspect(self, ref):
            g.reference(ref)
            if ref.startswith("postgres@"):
                return super().inspect(ref)
            b.require(re.fullmatch(r"ghcr\.io/citygo-tech/citygo-platform-(api|web|jobs)@" + t.DIGEST, ref), "fixture-reference")
            mapped = ref.replace("ghcr.io/citygo-tech/", address + "/fixture/")
            # Only substitute the registry namespace; all actual image metadata
            # and the production CLI format/transport are checked unchanged.
            value = t.strict_json(self._read("docker", ["image", "inspect", "--format", g.INSPECT, mapped]))
            value["RepoDigests"] = [v.replace(address + "/fixture/", "ghcr.io/citygo-tech/") for v in value["RepoDigests"]]
            return value
    store = Loopback(path.parent)
    roles = sorted(t.ROLES)
    # Actual content-addressed metadata read back from the loopback registry.
    # This also exercises the protected, offline bridge from containerd CI IDs
    # to a classic Docker config ID; it cannot grant a release approval.
    cache = path.parent / "image-content"
    cache.mkdir(mode=0o700)
    for role in roles:
        b.require(type(fixture["content"][role]["blobs"]) is dict
                  and 2 <= len(fixture["content"][role]["blobs"]) <= 3, "fixture-content")
        for digest, text in fixture["content"][role]["blobs"].items():
            b.require(t.matches(digest, t.DIGEST) and type(text) is str, "fixture-content")
            raw = text.encode()
            g.content(raw, digest)
            destination = cache / (digest.split(":")[1] + ".json")
            if destination.exists():
                b.require(t.read_file(destination, private=True) == raw, "fixture-content")
            else:
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as output:
                    output.write(raw)
    for role in roles:
        ref, tested = fixture["images"][role], fixture["ids"][role]
        proof = g.verify_image(store, ref, tested, fixture["sha"])
        b.require(proof["local_id"] == tested, "fixture-image")
        for ident, sha in (("sha256:" + "0" * 64, fixture["sha"]), (tested, "0" * 40)):
            try:
                g.verify_image(store, ref, ident, sha)
            except b.BackupError:
                pass
            else:
                raise b.BackupError("fixture-wrong-image-accepted")
        missing = ref.split("@")[0] + "@sha256:" + "0" * 64
        try:
            g.verify_image(store, missing, tested, fixture["sha"])
        except b.BackupError as error:
            b.require(str(error) == "image-local-unavailable", "fixture-missing-image")
        else:
            raise b.BackupError("fixture-missing-image-accepted")

        # CI currently uses classic Docker. Exercise the containerd inspection
        # contract using REAL registry manifest/config bytes from the same image,
        # but simulated .Id/Descriptor and blob transport. Not a daemon upgrade.
        blobs = {key: value.encode() for key, value in fixture["content"][role]["blobs"].items()}
        root_id = ref.split("@")[1]
        raw_root = blobs[root_id]
        root = g.content(raw_root, root_id)
        manifest_id = g.platform_manifest(root)["digest"] if root["mediaType"] in g.INDEX_TYPES else root_id
        manifest = g.content(blobs[manifest_id], manifest_id)
        config_id = manifest["config"]["digest"]
        g.content(blobs[config_id], config_id)
        class ContentStore:
            corrupt = False
            local_id = root_id
            classic = False
            def inspect(self, expected_ref):
                value = store.inspect(expected_ref)
                value["Id"] = self.local_id
                value["Descriptor"] = None if self.classic else {"digest": root_id, "size": len(raw_root), "mediaType": root["mediaType"]}
                return value
            def blob(self, digest):
                value = blobs[digest]
                return value + b" " if self.corrupt else value
        projected = ContentStore()
        for local_id in (config_id, manifest_id, root_id):
            projected.local_id = local_id
            b.require(g.verify_image(projected, ref, tested, fixture["sha"])["config_id"] == config_id, "fixture-content")
        projected.classic, projected.local_id = True, config_id
        b.require(g.verify_image(projected, ref, tested, fixture["sha"])["config_id"] == config_id, "fixture-content")
        projected.classic = False
        projected.corrupt = True
        try:
            g.verify_image(projected, ref, tested, fixture["sha"])
        except b.BackupError as error:
            b.require(str(error) == "image-content-hash", "fixture-content-reason")
        else:
            raise b.BackupError("fixture-corrupt-content-accepted")
    # Inspect the real pinned PostgreSQL base too, not just labelled app images.
    # No container is started and no application/database operation is performed.
    postgres = fixture["postgres"]
    b.require(t.matches(postgres["reference"], r"postgres:17-alpine@" + t.DIGEST)
              and t.matches(postgres["id"], t.DIGEST), "fixture-postgres")
    selected = {"current": {"images": fixture["images"], "image_ids": fixture["ids"],
                           "source_sha": fixture["sha"], "postgres": postgres["reference"]},
                "images": fixture["images"], "image_ids": fixture["ids"], "target_sha": fixture["sha"]}
    images = {"api": fixture["ids"]["api"], "web": fixture["ids"]["web"],
              "worker": fixture["ids"]["jobs"], "migrator": fixture["ids"]["jobs"],
              "postgres": postgres["id"], "backup": postgres["id"]}
    proof = g.verify(store, selected, images)
    b.require(proof["postgres"]["local_id"] == postgres["id"], "fixture-postgres")
    print(json.dumps({"ok": True, "roles": roles, "missing_and_wrong_rejected": True,
                      "real_content_simulated_containerd": True, "real_postgres_binding": True,
                      "protected_metadata_bridge_verified": True,
                      "migration_authorized": False}))


if __name__ == "__main__": main()
