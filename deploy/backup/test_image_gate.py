"""Synthetic image stores. No Docker daemon, registry, credentials or image execution."""
import copy
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import backup as b
import image_gate as g
import target as t
from test_target import encoded, manifest_fixture


def inspection(ref, ident, sha):
    return {"Id": ident, "RepoDigests": [ref], "Os": "linux", "Architecture": "amd64", "Descriptor": None,
            "Source": g.SOURCE, "Revision": sha, "RootFS": {"Type": "layers", "Layers": ["sha256:" + "f" * 64]}}


class FakeStore:
    def __init__(self):
        self.values, self.blobs, self.calls = {}, {}, []
        self.on_inspect = lambda: None

    def inspect(self, ref):
        self.calls.append(("inspect", ref)); self.on_inspect()
        b.require(ref in self.values, "image-local-unavailable")
        return copy.deepcopy(self.values[ref])

    def blob(self, digest):
        self.calls.append(("blob", digest))
        b.require(digest in self.blobs, "image-local-unavailable")
        return self.blobs[digest]


def selected_fixture():
    current, target = manifest_fixture("a" * 40, current=True), manifest_fixture()
    return {"current": {"source_sha": current["sourceSha"], "images": current["images"],
                        "image_ids": current["imageIds"], "postgres": current["bases"]["postgres"]},
            "images": target["images"], "image_ids": target["imageIds"], "target_sha": target["sourceSha"]}


def store_fixture(selected, current_images):
    store = FakeStore()
    for refs, ids, sha in ((selected["current"]["images"], selected["current"]["image_ids"], selected["current"]["source_sha"]),
                          (selected["images"], selected["image_ids"], selected["target_sha"])):
        for role, ref in refs.items(): store.values[ref] = inspection(ref, ids[role], sha)
    pg = "postgres@" + selected["current"]["postgres"].split("@")[1]
    store.values[pg] = inspection(pg, current_images["postgres"], "")
    return store


def selection_store(selection, current_images):
    # Only test writers, never approval creation or a runtime bypass.
    current = json.loads((selection.current_directory / "release.json").read_bytes())
    target = json.loads((selection.target_directory / "release.json").read_bytes())
    selected = {"current": {"source_sha": current["sourceSha"], "images": current["images"],
                            "image_ids": current["imageIds"], "postgres": current["bases"]["postgres"]},
                "images": target["images"], "image_ids": target["imageIds"], "target_sha": target["sourceSha"]}
    return store_fixture(selected, current_images)


def containerd_fixture(config_change=None, manifest_change=None):
    config = {"os": "linux", "architecture": "amd64", "config": {"Labels": {g.LABELS[0]: g.SOURCE, g.LABELS[1]: "b" * 40}},
              "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "f" * 64]}}
    if config_change: config_change(config)
    raw = encoded(config); config_id = "sha256:" + t.sha256(raw)
    manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_id, "size": len(raw)}, "layers": []}
    if manifest_change: manifest_change(manifest)
    raw_manifest = encoded(manifest); manifest_id = "sha256:" + t.sha256(raw_manifest)
    ref = "ghcr.io/citygo-tech/citygo-platform-api@" + manifest_id
    store = FakeStore(); store.blobs = {config_id: raw, manifest_id: raw_manifest}
    store.values[ref] = inspection(ref, manifest_id, "b" * 40)
    store.values[ref]["Descriptor"] = {"digest": manifest_id, "size": len(raw_manifest), "mediaType": manifest["mediaType"]}
    return store, ref, config_id


class Images(unittest.TestCase):
    def test_classic_verifies_reference_config_id_platform_and_source_without_blob_reads(self):
        ref = "ghcr.io/citygo-tech/citygo-platform-api@sha256:" + "d" * 64
        store = FakeStore(); store.values[ref] = inspection(ref, "sha256:" + "c" * 64, "b" * 40)
        proof = g.verify_image(store, ref, "sha256:" + "c" * 64, "b" * 40)
        self.assertEqual(proof["mode"], "classic-config")
        self.assertEqual(store.calls, [("inspect", ref)])
        self.assertEqual(set(proof), {"reference", "local_id", "tested_id", "config_id", "source_sha", "mode"})

    def test_wrong_or_missing_classic_image_never_passes_by_labels_alone(self):
        ref = "ghcr.io/citygo-tech/citygo-platform-api@sha256:" + "d" * 64
        for change in ({"Id": "sha256:" + "d" * 64}, {"Architecture": "arm64"}, {"Os": "windows"},
                       {"Source": "https://example.invalid"}, {"Revision": "a" * 40}, {"RepoDigests": []},
                       {"RepoDigests": "not a list"}, {"RootFS": {}}, {"Descriptor": {}}, {"Id": None}):
            store = FakeStore(); store.values[ref] = {**inspection(ref, "sha256:" + "c" * 64, "b" * 40), **change}
            with self.subTest(change=change), self.assertRaises(b.BackupError):
                g.verify_image(store, ref, "sha256:" + "c" * 64, "b" * 40)
        with self.assertRaisesRegex(b.BackupError, "image-local-unavailable"):
            g.verify_image(FakeStore(), ref, "sha256:" + "c" * 64, "b" * 40)

    def test_containerd_requires_hashed_manifest_config_chain_even_when_tested_id_is_manifest(self):
        store, ref, config_id = containerd_fixture()
        for tested_id in (config_id, ref.split("@")[1]):
            proof = g.verify_image(store, ref, tested_id, "b" * 40)
            self.assertEqual(proof["config_id"], config_id)
            self.assertEqual(proof["mode"], "containerd-content")
        self.assertEqual([kind for kind, _ in store.calls], ["inspect", "blob", "blob"] * 2)

    def test_containerd_rejects_modified_missing_or_unlinked_content(self):
        for fault in ("manifest", "config", "missing", "rootfs", "source", "descriptor", "size", "index", "tested"):
            store, ref, config_id = containerd_fixture()
            if fault == "manifest": store.blobs[ref.split("@")[1]] += b" "
            elif fault == "config": store.blobs[config_id] += b" "
            elif fault == "missing": del store.blobs[config_id]
            elif fault == "rootfs": store.values[ref]["RootFS"]["Layers"] = ["sha256:" + "a" * 64]
            elif fault == "source": store.values[ref]["Revision"] = "a" * 40
            elif fault == "descriptor": store.values[ref]["Descriptor"]["digest"] = "sha256:" + "a" * 64
            elif fault == "size": store.values[ref]["Descriptor"]["size"] += 1
            elif fault == "index": store.values[ref]["Descriptor"]["mediaType"] = "application/vnd.oci.image.index.v1+json"
            elif fault == "tested": config_id = "sha256:" + "a" * 64
            with self.subTest(fault=fault), self.assertRaises(b.BackupError): g.verify_image(store, ref, config_id, "b" * 40)

    def test_projection_covers_both_releases_and_binds_current_service_roles(self):
        selected = selected_fixture(); images = {role: "sha256:" + "c" * 64 for role in t.SERVICES}
        store = store_fixture(selected, images)
        proof = g.verify(store, selected, images)
        self.assertFalse(proof["migration_authorized"])
        self.assertEqual(set(proof["current"]), t.ROLES)
        self.assertEqual(set(proof["target"]), t.ROLES)
        self.assertEqual(len(store.calls), 7)
        for role in sorted(t.SERVICES):
            with self.subTest(role=role), self.assertRaises(b.BackupError):
                g.verify(store, selected, {**images, role: "sha256:" + "a" * 64})

    def test_valid_hashes_do_not_hide_wrong_config_or_manifest_contract(self):
        for change in (lambda v: v.update(architecture="arm64"), lambda v: v.update(config=None),
                       lambda v: v["config"]["Labels"].update({g.LABELS[0]: "https://example.invalid"}),
                       lambda v: v["rootfs"].update(diff_ids=["sha256:" + "a" * 64])):
            store, ref, ident = containerd_fixture(config_change=change)
            with self.assertRaises(b.BackupError): g.verify_image(store, ref, ident, "b" * 40)
        for change in (lambda v: v.update(schemaVersion=True), lambda v: v["config"].update(size=1),
                       lambda v: v["config"].update(mediaType="unknown")):
            store, ref, ident = containerd_fixture(manifest_change=change)
            with self.assertRaises(b.BackupError): g.verify_image(store, ref, ident, "b" * 40)

    def test_no_floating_foreign_or_command_references(self):
        store = FakeStore()
        for ref in ("latest", "--help", "ghcr.io/other/api@sha256:" + "a" * 64,
                    "ghcr.io/citygo-tech/citygo-platform-api:latest", "/tmp/image", "$(secret)"):
            with self.subTest(ref=ref), self.assertRaises(b.BackupError): g.verify_image(store, ref, "sha256:" + "c" * 64, "b" * 40)
        self.assertEqual(store.calls, [])

    def test_transport_is_read_only_local_bounded_and_credential_free(self):
        with patch.object(g.sys, "platform", "linux"):
            store = g.Store(Path("/tmp/synthetic-images"))
        ref = "ghcr.io/citygo-tech/citygo-platform-api@sha256:" + "d" * 64
        value = inspection(ref, "sha256:" + "c" * 64, "b" * 40)
        with patch.object(b, "executable", side_effect=lambda v: "/usr/bin/" + v), patch.object(g.subprocess, "run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout=encoded(value))
            self.assertEqual(store.inspect(ref), value)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/docker", "image", "inspect", "--format", g.INSPECT, ref])
            self.assertEqual(run.call_args.kwargs["env"], b.clean_env(Path("/tmp/synthetic-images")))
            self.assertEqual(run.call_args.kwargs["timeout"], 30)
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
            store.blob("sha256:" + "a" * 64)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/ctr", "--address", "/run/containerd/containerd.sock",
                "--namespace", "moby", "content", "get", "sha256:" + "a" * 64])
            run.return_value = SimpleNamespace(returncode=1, stdout=b"secret-canary")
            with self.assertRaisesRegex(b.BackupError, "^image-local-unavailable$"): store.inspect(ref)
            run.return_value = SimpleNamespace(returncode=0, stdout=b"x" * (t.LIMIT + 1))
            with self.assertRaisesRegex(b.BackupError, "^image-local-unavailable$"): store.inspect(ref)
            run.side_effect = subprocess.TimeoutExpired("sensitive-canary", 30)
            with self.assertRaisesRegex(b.BackupError, "^image-local-unavailable$"): store.inspect(ref)


if __name__ == "__main__": unittest.main()
