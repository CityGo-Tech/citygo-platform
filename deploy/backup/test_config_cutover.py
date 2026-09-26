"""Synthetic config cutover only: no cloud, containers, activation or secrets."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import backup as b
import release as r
import worker as w
from test_backup import sample, MemoryStore
from test_worker import Transport


class Binding(unittest.TestCase):
    def bound(self):
        values = sample()
        raw = json.dumps(values).encode()
        return b._LoadedConfig(values, b._ConfigBinding(Path('/synthetic/backup.json'), raw, values)), raw

    def test_copy_deepcopy_and_json_keep_values_but_share_revocation(self):
        config, raw = self.bound()
        copies = [config, config.copy(), copy.copy(config), copy.deepcopy(config)]
        for value in copies:
            self.assertIs(b.validate(value), value)
            self.assertEqual(json.loads(json.dumps(value)), sample())
            self.assertIs(value._binding, config._binding)
        with patch.object(b, '_config_bytes', return_value=b'changed'):
            with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
                b.assert_current_config(copies[2])
        with patch.object(b, '_config_bytes', return_value=raw):
            for value in copies:
                with self.assertRaisesRegex(b.BackupError, 'configuration-invalidated'):
                    b.assert_current_config(value)

    def test_in_memory_edit_is_not_authorized_by_unchanged_source(self):
        config, raw = self.bound()
        config['source_sha'] = 'b' * 40
        with patch.object(b, '_config_bytes', return_value=raw):
            with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
                b.assert_current_config(config)

    def test_source_failure_poison_is_not_reset_by_restoring_file(self):
        config, raw = self.bound()
        with patch.object(b, '_config_bytes', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError): b.assert_current_config(config)
        with patch.object(b, '_config_bytes', return_value=raw):
            with self.assertRaisesRegex(b.BackupError, 'configuration-invalidated'):
                b.assert_current_config(config)

    def test_fingerprint_checks_source_even_with_preloaded_compose_inputs(self):
        config, raw = self.bound()
        inputs = {'compose_file': b'synthetic-compose', 'compose_env': b'synthetic-env'}
        with patch.object(b, '_config_bytes', return_value=raw):
            self.assertEqual(b.configuration_fingerprint(config, inputs=inputs),
                             b.configuration_fingerprint(sample(), inputs=inputs))
        with patch.object(b, '_config_bytes', return_value=b'changed'):
            with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
                b.configuration_fingerprint(config, inputs=inputs)


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux protected config and real locks')
class Cutover(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='citygo-config-test-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.state = self.directory / 'state'
        self.state.mkdir(mode=0o700)
        self.path = self.directory / 'backup.json'
        self.old = sample(self.directory)
        self.new = {**self.old, 'source_sha': 'b' * 40,
                    'compose_file': str(self.directory / 'next-compose.yml'),
                    'compose_env': str(self.directory / 'next.env')}
        for filename in ('compose.yml', 'pilot.env', 'next-compose.yml', 'next.env'):
            path = self.directory / filename
            path.write_text('# synthetic ' + filename)
            path.chmod(0o600)
        b.atomic_json(self.path, self.old)
        self.loaded = b.load_config(self.path)
        self.store, self.docker = MemoryStore(), Transport()
        self.pending = self.state / 'operation-pending.json'
        self.marker = self.state / w.ADMISSION
        self.dumps = []

    def encrypt(self, config, path, env):
        self.dumps.append(config['source_sha'])
        path.write_bytes(b'synthetic-encrypted-dump' * 30)

    def backup(self, config, **kwargs):
        return b.perform_backup(config, storage_factory=lambda *_: self.store, min_free=0,
                                encryptor=kwargs.get('encryptor', self.encrypt))

    def test_atomic_cutover_rejects_old_snapshot_but_fresh_load_uses_new_files(self):
        old_fingerprint = b.configuration_fingerprint(self.loaded)
        b.atomic_json(self.path, self.new)
        with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
            self.backup(self.loaded)
        self.assertEqual(self.dumps, []); self.assertEqual(self.store.calls, [])
        self.assertFalse(self.pending.exists())
        current = b.load_config(self.path)
        def encrypt(config, path, env):
            self.assertEqual(Path(config['compose_file']).read_text(), '# synthetic next-compose.yml')
            self.assertEqual(Path(config['compose_env']).read_text(), '# synthetic next.env')
            self.encrypt(config, path, env)
        result = self.backup(current, encryptor=encrypt)
        self.assertEqual(result['source_sha'], self.new['source_sha'])
        self.assertNotEqual(result['configuration_sha256'], old_fingerprint)
        b.check_freshness(current)
        self.assertFalse(self.pending.exists())

    def test_cutover_on_lock_entry_refuses_before_work_or_new_admission_revocation(self):
        real_lock = b.lock
        actions = [lambda config: self.backup(config),
                   lambda config: w.perform(config, transport_factory=lambda *_: self.docker),
                   w.pause, w.open_admission]
        for action in actions:
            b.atomic_json(self.path, self.old)
            loaded = b.load_config(self.path)
            switched = []
            @contextmanager
            def cutover(state, name='maintenance.lock'):
                with real_lock(state, name):
                    if not switched:
                        b.atomic_json(self.path, self.new)
                        b.atomic_json(self.marker, w.admission(b.load_config(self.path)))
                        switched.append(self.marker.read_bytes())
                    yield
            with patch.object(b, 'lock', cutover), self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
                action(loaded)
            self.assertEqual(self.marker.read_bytes(), switched[0])
            self.assertFalse(self.pending.exists())
            self.assertEqual(self.dumps, []); self.assertEqual(self.store.calls, [])
            self.assertEqual(self.docker.calls, [])

    def test_stale_release_copy_cannot_create_pending(self):
        loaded = copy.deepcopy(self.loaded)
        b.atomic_json(self.path, self.new)
        with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
            with r.release_window(loaded, 'c' * 40): self.fail('must not enter')
        self.assertFalse(self.pending.exists())

    def test_cutover_during_dump_prevents_upload_and_success(self):
        def encrypt(config, path, env):
            self.encrypt(config, path, env)
            b.atomic_json(self.path, self.new)
        with self.assertRaisesRegex(b.BackupError, 'backup-failed-upload'):
            self.backup(self.loaded, encryptor=encrypt)
        self.assertEqual(self.store.calls, [])
        self.assertTrue(self.pending.exists())
        self.assertFalse((self.state / 'last-success.json').exists())

    def test_cutover_during_worker_does_not_claim_success_or_clear_pending(self):
        w.open_admission(self.loaded)
        self.docker.on_wait = lambda: b.atomic_json(self.path, self.new)
        with self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
            w.perform(self.loaded, transport_factory=lambda *_: self.docker)
        self.assertTrue(self.pending.exists())
        self.assertFalse((self.state / 'worker-last-success.json').exists())
        self.assertEqual(self.docker.calls, ['start', 'inspect', 'wait', 'inspect'])

    def test_new_worker_uses_new_snapshot_and_old_receipts_are_not_fresh(self):
        self.backup(self.loaded)
        b.atomic_json(self.path, self.new)
        current = b.load_config(self.path)
        with self.assertRaisesRegex(b.BackupError, 'configuration-changed'):
            b.check_freshness(current)
        w.open_admission(current)
        def transport(config, directory):
            self.assertEqual(config['source_sha'], self.new['source_sha'])
            self.assertEqual((directory / 'admitted-compose.yml').read_text(), '# synthetic next-compose.yml')
            self.assertEqual((directory / 'admitted.env').read_text(), '# synthetic next.env')
            return self.docker
        w.perform(current, transport_factory=transport)
        self.assertFalse(self.pending.exists())

    def test_config_permissions_links_duplicates_and_size_fail_closed(self):
        raw = self.path.read_bytes()
        self.path.chmod(0o644)
        with self.assertRaisesRegex(b.BackupError, 'permissions'): b.load_config(self.path)
        self.path.chmod(0o600)
        link = self.directory / 'alias.json'
        link.symlink_to(self.path)
        with self.assertRaisesRegex(b.BackupError, 'permissions'): b.load_config(link)
        link.unlink()
        link.hardlink_to(self.path)
        with self.assertRaisesRegex(b.BackupError, 'configuration-file'): b.load_config(self.path)
        link.unlink()
        self.path.write_bytes(b'{"version":1,' + raw[1:])
        with self.assertRaisesRegex(b.BackupError, 'configuration-json'): b.load_config(self.path)
        self.path.write_bytes(b' ' * 65537)
        with self.assertRaisesRegex(b.BackupError, 'configuration-file'): b.load_config(self.path)

    def test_config_replaced_during_compose_read_is_rejected(self):
        original = b.protected
        def replace(path, *args, **kwargs):
            if str(path) == self.old['compose_env']:
                b.atomic_json(self.path, self.new)
            return original(path, *args, **kwargs)
        with patch.object(b, 'protected', replace), self.assertRaisesRegex(b.BackupError, 'configuration-superseded'):
            b.configuration_inputs(self.loaded)


if __name__ == '__main__': unittest.main()
