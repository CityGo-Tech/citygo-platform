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
    path = Path(sys.argv[2]); fixture = b.read_json(path)
    address = fixture["address"]
    b.require(t.matches(address, r"127\.0\.0\.1:[1-9][0-9]{0,4}")
              and t.matches(fixture["sha"], t.SHA), "disposable-required")
    class Loopback(g.Store):
        def inspect(self, ref):
            g.reference(ref)
            b.require(re.fullmatch(r"ghcr\.io/citygo-tech/citygo-platform-(api|web|jobs)@" + t.DIGEST, ref), "fixture-reference")
            mapped = ref.replace("ghcr.io/citygo-tech/", address + "/fixture/")
            # Only substitute the registry namespace; all actual image metadata
            # and the production CLI format/transport are checked unchanged.
            value = t.strict_json(self._read("docker", ["image", "inspect", "--format", g.INSPECT, mapped]))
            value["RepoDigests"] = [v.replace(address + "/fixture/", "ghcr.io/citygo-tech/") for v in value["RepoDigests"]]
            return value
    store = Loopback(path.parent)
    roles = sorted(t.ROLES)
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
        blobs = fixture["content"][role]
        manifest_id = ref.split("@")[1]
        raw_manifest = blobs["manifest"].encode()
        manifest = g.content(raw_manifest, manifest_id)
        raw_config = blobs["config"].encode()
        config_id = manifest["config"]["digest"]
        g.content(raw_config, config_id)
        class ContentStore:
            corrupt = False
            local_id = manifest_id
            def inspect(self, expected_ref):
                value = store.inspect(expected_ref)
                value["Id"] = self.local_id
                value["Descriptor"] = {"digest": manifest_id, "size": len(raw_manifest), "mediaType": manifest["mediaType"]}
                return value
            def blob(self, digest):
                value = {manifest_id: raw_manifest, config_id: raw_config}[digest]
                return value + b" " if self.corrupt else value
        projected = ContentStore()
        for local_id in (config_id, manifest_id):
            projected.local_id = local_id
            b.require(g.verify_image(projected, ref, tested, fixture["sha"])["config_id"] == config_id, "fixture-content")
        projected.corrupt = True
        try:
            g.verify_image(projected, ref, tested, fixture["sha"])
        except b.BackupError as error:
            b.require(str(error) == "image-content-hash", "fixture-content-reason")
        else:
            raise b.BackupError("fixture-corrupt-content-accepted")
    print(json.dumps({"ok": True, "roles": roles, "missing_and_wrong_rejected": True,
                      "real_content_simulated_containerd": True, "migration_authorized": False}))


if __name__ == "__main__": main()
