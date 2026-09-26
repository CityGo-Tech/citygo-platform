"""Disposable CI-only second release; no real approvals, cloud or old-job deletion."""
import copy
import json
from pathlib import Path
import shutil
import tempfile

import backup as b
import finish as f
import prepare as p
import target as t
import worker as w
from test_backup import MemoryStore
from test_target import synthetic_selection, encoded
from test_image_gate import selection_store
from test_migrate import synthetic_authorization
from test_start import synthetic_start_approval
from test_finish import synthetic_finish_approval
from restart_smoke import rehearse


def repeat(directory, fixture, config_path, first_selection, first_complete, host_factory, secret_directory):
    config = b.load_config(config_path)
    project = config["project"]
    b.require(t.matches(project, r"citygo-pilot-test-[0-9a-f]{12}") and fixture["origin"] == "https://pilot.example.test"
              and config["source_sha"] == "b" * 40 and config_path.is_relative_to(directory), "disposable-required")
    with tempfile.TemporaryDirectory(prefix="repeat-client-", dir=directory) as tmp:
        host = host_factory(config, Path(tmp), fixture["ingress_directory"], fixture["origin"])
        host.assert_closed()
        original = host.inspect(fixture["worker_id"])
        p.stopped_cleanly(original)
        b.require(original["Labels"].get("com.docker.compose.project") == project
                  and original["Labels"].get("com.docker.compose.service") == "worker"
                  and original["Image"] == fixture["images"]["worker"], "fixture-prior-worker")
        # Make a local-only DIFFERENT image ID with the same tested jobs files.
        # Source is this fixture's exact exited synthetic latch container, never
        # a production container. No commit/push/tag occurs in runtime code.
        historical_image = host.capture(["commit", "--change", "LABEL citygo.disposable.project=" + project,
                                         original["Id"]], timeout=60)
        b.require(t.matches(historical_image, t.DIGEST) and historical_image != original["Image"], "fixture-history-image")
        name = project + "-historical-worker"
        host.capture(["run", "--pull", "never", "--name", name, "--network", "none", "--init", "--read-only",
            "--stop-timeout", "90", "--restart", "no", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--pids-limit", "64", "--memory", "128m", "--user", "1000:1000",
            "--label", "com.docker.compose.project=" + project,
            "--label", "com.docker.compose.service=worker", "--label", "com.docker.compose.oneoff=True",
            "--entrypoint", "node", historical_image, "-e", "process.exit(0)"], timeout=60)
        historical = host.inspect(name)
        p.stopped_cleanly(historical)
        before = host.inventory()
        entries = [p.evidence(v) for v in before if v["Labels"]["com.docker.compose.service"] in ("worker", "migrator", "backup")]
        old_pg = p.evidence(next(v for v in before if v["Labels"]["com.docker.compose.service"] == "postgres"))
        try: p.validate_inventory(before, project, fixture["images"], initial=True)
        except b.BackupError as error: b.require(str(error) == "container-image", "fixture-history-negative-control")
        else: raise b.BackupError("fixture-history-not-reproduced")
        p.validate_inventory(before, project, fixture["images"], initial=True, retained_jobs=entries)
        network = host.database_network()["id"]
        web_network = host.web_network()["id"]
    next_directory = directory / "second-release"; next_directory.mkdir(mode=0o700)
    selection = synthetic_selection(next_directory, config, fixture["images"])
    # Preserve the first target EXACTLY as the next current bundle. New source
    # identity/approval are synthetic; Docker/health/transactions are real. The
    # fixture repeats the tested binary, NOT an arbitrary SQL compatibility claim.
    shutil.copytree(first_selection.target_directory, selection.current_directory, dirs_exist_ok=True)
    previous = t.strict_json((selection.current_directory / "release.json").read_bytes())
    candidate = copy.deepcopy(previous)
    candidate.update(sourceSha="c" * 40, releaseId="c" * 40 + "-123-1",
                     images={role: "ghcr.io/citygo-tech/citygo-platform-" + role + "@sha256:" + "f" * 64 for role in t.ROLES})
    shutil.copytree(first_selection.target_directory, selection.target_directory, dirs_exist_ok=True)
    (selection.target_directory / "release.json").write_bytes(encoded(candidate))
    value = t.strict_json(selection.approval_file.read_bytes())
    value.update(version=2, retained_jobs=entries, target_sha=candidate["sourceSha"], target_release_id=candidate["releaseId"],
                 current_manifest_sha256=t.sha256((selection.current_directory / "release.json").read_bytes()),
                 target_manifest_sha256=t.sha256(encoded(candidate)))
    selection.approval_file.write_bytes(encoded(value))
    authorization = synthetic_authorization(next_directory, selection, config, network)
    startup = synthetic_start_approval(next_directory, authorization, secret_directory / "api.json", web_network)
    image_store = selection_store(selection, fixture["images"])
    selected = selection.verify(config, "c" * 40, fixture["origin"], fixture["images"])
    plan = f.generation(config, "c" * 40, fixture["origin"], f.g.verify(image_store, selected, fixture["images"]),
                        secret_directory / "api.json", secret_directory / "worker.json", secret_directory / "db_backup_password")
    finish = synthetic_finish_approval(next_directory, config, startup, plan)
    store = MemoryStore()
    complete = f.finish(config, "c" * 40, fixture["origin"], fixture["ingress_directory"], fixture["images"],
        secret_directory / "migrate.json", secret_directory / "api.json", secret_directory / "worker.json", secret_directory / "db_backup_password",
        allow_stop=True, allow_upload=True, allow_migration=True, allow_start=True, allow_finish=True,
        selection=selection, authorization=authorization, startup_authorization=startup, finish_authorization=finish,
        image_store_factory=lambda _: image_store, host_factory=host_factory, storage_factory=lambda *_: store)
    fresh = b.load_config(config_path)
    b.require(f.active_release(fresh) == complete["finish"] and len(store.objects) == 2, "fixture-second-commit")
    b.require(complete["migration"]["result"]["applied"] == []
              and complete["migration"]["container_id"] != first_complete["migration"]["container_id"], "fixture-second-migration")
    b.require(all(complete["startup"]["apps"][role]["id"] != first_complete["startup"]["apps"][role]["id"] for role in ("api", "web")), "fixture-second-apps")
    with tempfile.TemporaryDirectory(prefix="repeat-check-", dir=directory) as tmp:
        host = host_factory(fresh, Path(tmp), fixture["ingress_directory"], fixture["origin"])
        host.assert_closed(); host.probe()
        after = {v["Id"]: v for v in host.inventory()}
        b.require(p.evidence(after[old_pg["id"]]) == old_pg
                  and all(p.evidence(after[entry["id"]]) == entry for entry in entries), "fixture-history-changed")
    state = Path(fresh["state_dir"])
    b.require(not (state / "operation-pending.json").exists() and not (state / w.ADMISSION).exists(), "fixture-second-admission")
    b.require(len(list(state.glob("migration-*.success.json"))) == 2
              and len(list(state.glob("finish-approval-*.used.json"))) == 2, "fixture-second-evidence")
    backup = b.perform_backup(fresh, storage_factory=lambda *_: MemoryStore())
    b.require(backup["source_sha"] == "c" * 40, "fixture-second-backup")
    restarted = rehearse(directory, fixture, fresh, plan, f.g.verify(image_store, selected, fixture["images"]),
                         host_factory, secret_directory / "api.json")
    return {**restarted, "second_release_verified": True, "retained_jobs_verified": len(entries),
            "second_migration_container": complete["migration"]["container_id"],
            "historical_worker_container": historical["Id"], "historical_image": historical_image}
