"""Synthetic stores only: no network, credentials or production deletions."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import time
import sys
import unittest
from unittest.mock import patch

import backup as b
import routine as r
from test_backup import sample


def record(timestamp, index=0):
    backup_id = datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + f'{index:032x}'
    return dict(version=1, backup_id=backup_id, snapshot_started_at=timestamp,
                key='citygo/pilot/' + backup_id + '.dump.age', bytes=101,
                format='pg_dump-custom+age-x25519', sha256='a' * 64,
                recipient_sha256=hashlib.sha256(sample()['recipient'].encode()).hexdigest())


class MemoryStore:
    def __init__(self, records):
        self.objects = {}
        self.deleted = []
        self.versioned = set()
        for v in records:
            self.objects[v['key']] = b'x' * v['bytes']
            self.objects[v['key'].replace('.dump.age', '.complete.json')] = json.dumps(v).encode()

    def listing(self, _prefix):
        return {k: {'Key': k, 'Size': len(v)} for k, v in self.objects.items()}

    def get(self, key, path):
        path.write_bytes(self.objects[key])

    def put(self, key, path):
        self.objects[key] = path.read_bytes()

    def unversioned(self, key):
        b.require(key not in self.versioned, 'retention-versioned-object')

    def delete(self, key):
        self.deleted.append(key)
        del self.objects[key]


class Selection(unittest.TestCase):
    def test_24_plus_daily_weekly_and_newest_always_kept(self):
        now = 1791022000
        values = [record(now - i * 3600, i) for i in range(24 * 90)]
        keep = r.keep_ids(values)
        self.assertLessEqual(len(keep), 35)
        self.assertTrue(all(v['backup_id'] in keep for v in values[:24]))
        self.assertFalse(values[-1]['backup_id'] in keep)
        self.assertGreater(len(keep), 24)

    def test_sparse_history_and_iso_year_boundaries(self):
        base = datetime(2027, 1, 5, tzinfo=timezone.utc).timestamp()
        values = [record(base - i * 86400 * 8, i) for i in range(6)]
        self.assertEqual(len(r.keep_ids(values)), 6)

    def test_same_timestamp_and_input_order_are_deterministic(self):
        values = [record(1791022000, i) for i in range(30)]
        self.assertEqual(r.keep_ids(values), r.keep_ids(list(reversed(values))))
        self.assertEqual(len(r.keep_ids(values)), 2)

    def test_invalid_dates_and_traversal(self):
        for value in ('../other', '20269999T000000Z-' + 'a' * 32, '20261003T010000Z-' + 'A' * 32):
            with self.assertRaises(b.BackupError):
                r.snapshot_time(value)


class Pruning(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = sample()
        self.records = [record(int(time.time()) - 10 - i * 3600, i) for i in range(80)]
        self.store = MemoryStore(self.records)
        self.freshness = patch.object(b, 'check_freshness')
        self.freshness.start()
        self.addCleanup(self.freshness.stop)

    def prune(self, **kwargs):
        return r.prune(self.config, self.store, self.directory, self.records[0], **kwargs)

    def test_only_expired_pairs_deleted_unknown_enrollment_untouched(self):
        unknown = 'citygo/pilot/enrollment-private.age'
        self.store.objects[unknown] = b'keep'
        result = self.prune(delete=True)
        self.assertEqual(result['deleted'], result['candidates'])
        self.assertEqual(len(self.store.deleted), result['deleted'] * 2)
        self.assertIn(unknown, self.store.objects)
        self.assertIn(self.records[0]['key'], self.store.objects)
        self.assertEqual(result['unknown_objects'], 1)

    def test_default_is_dry_run(self):
        self.assertGreater(self.prune()['candidates'], 0)
        self.assertEqual(self.store.deleted, [])

    def test_versioned_candidate_stops_entire_delete_plan(self):
        self.store.versioned.add(self.records[-1]['key'])
        with self.assertRaisesRegex(b.BackupError, 'versioned'):
            self.prune(delete=True)
        self.assertEqual(self.store.deleted, [])

    def test_freshness_failure_never_deletes(self):
        with patch.object(b, 'check_freshness', side_effect=b.BackupError('stale')):
            with self.assertRaises(b.BackupError):
                self.prune(delete=True)
        self.assertEqual(self.store.deleted, [])

    def test_missing_new_copy_never_deletes(self):
        for k in list(self.store.objects):
            if self.records[0]['backup_id'] in k:
                del self.store.objects[k]
        with self.assertRaisesRegex(b.BackupError, 'fresh-copy-missing'):
            self.prune(delete=True)
        self.assertEqual(self.store.deleted, [])

    def test_partial_pair_or_wrong_size_never_deletes(self):
        del self.store.objects[self.records[-1]['key']]
        with self.assertRaisesRegex(b.BackupError, 'incomplete-pair'):
            self.prune(delete=True)
        self.assertEqual(self.store.deleted, [])

    def test_manifest_cannot_redirect_delete_outside_prefix(self):
        key = self.records[-1]['key'].replace('.dump.age', '.complete.json')
        self.store.objects[key] = json.dumps({**self.records[-1], 'key': 'other/object'}).encode()
        with self.assertRaisesRegex(b.BackupError, 'manifest'):
            self.prune(delete=True)
        self.assertEqual(self.store.deleted, [])


class Pagination(unittest.TestCase):
    def store(self, pages):
        store = object.__new__(r.Store)
        store.request = unittest.mock.Mock(side_effect=pages)
        return store

    def test_all_pages_are_read(self):
        store = self.store([{'IsTruncated': True, 'NextContinuationToken': 'next', 'Contents': [{'Key':'citygo/pilot/a','Size':2}]},
                            {'IsTruncated': False, 'Contents': [{'Key':'citygo/pilot/b','Size':3}]}])
        self.assertEqual(len(store.listing('citygo/pilot')), 2)
        self.assertIn('next', store.request.call_args.args)

    def test_repeated_token_and_cross_prefix_rejected(self):
        for pages in ([{'IsTruncated':True,'NextContinuationToken':'x'}] * 2,
                      [{'IsTruncated':False,'Contents':[{'Key':'other/a','Size':1}]}]):
            with self.assertRaises(b.BackupError):
                self.store(pages).listing('citygo/pilot')

    def test_delete_marker_result_is_not_claimed_as_freed_space(self):
        store = self.store([{}, {'DeleteMarker':True}])
        with self.assertRaisesRegex(b.BackupError, 'versioning-changed'):
            store.delete('citygo/pilot/exact-key')


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux permission/lock tests')
class Execution(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='citygo-routine-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = sample(self.root)
        for name in ('state', 'ops'):
            (self.root / name).mkdir(mode=0o700)
        for name in ('compose.yml', 'pilot.env'):
            (self.root / name).write_text('# synthetic\n')
            (self.root / name).chmod(0o600)
        config_path = self.root / 'backup.json'
        b.atomic_json(config_path, self.config)
        pins = {k:self.config[k] for k in r.PIN_FIELDS - {'recipient_sha256'}}
        pins['recipient_sha256'] = hashlib.sha256(self.config['recipient'].encode()).hexdigest()
        self.policy = dict(version=1, enabled=True, backup_config=str(config_path),
                           mail_config=str(self.root / 'mail.json'), state_dir=str(self.root / 'ops'), pins=pins)
        self.store = MemoryStore([])

    def run_backup(self):
        def runner(config, operation):
            return b._backup_in_operation(config, operation, storage_factory=lambda *_: self.store,
                encryptor=lambda _c,p,_e: p.write_bytes(b'encrypted-synthetic' * 100), min_free=0)
        return r.run(self.policy, delete=True, runner=runner, storage_factory=lambda *_: self.store)

    def test_complete_pipeline_and_freshness_check(self):
        result = self.run_backup()
        self.assertEqual(result['kept'], 1)
        self.assertEqual(len(self.store.objects), 2)
        r.check(self.policy)
        self.assertFalse((self.root / 'state' / 'operation-pending.json').exists())
        self.assertFalse(list((self.root / 'state').glob('.attempt-*')))
        self.assertFalse(list((self.root / 'ops').glob('.retention-*')))

    def test_deploy_lock_does_not_start_any_operation(self):
        with b.lock(self.root / 'state'):
            with self.assertRaisesRegex(b.BackupError, 'already-running'):
                self.run_backup()
        self.assertFalse(self.store.objects)

    def test_unsettled_backup_is_not_overridden(self):
        b.begin_operation(self.root / 'state', 'backup', 'a' * 64)
        with self.assertRaisesRegex(b.BackupError, 'unsettled'):
            self.run_backup()
        self.assertFalse(self.store.objects)

    def test_storage_cap_stops_upload_not_just_cleanup(self):
        values = [record(int(time.time()) - 10 - i * 3600, i) for i in range(40)]
        self.store = MemoryStore(values)
        previous = dict(self.store.objects)
        with self.assertRaisesRegex(b.BackupError, 'storage-cap'):
            self.run_backup()
        self.assertEqual(previous, self.store.objects)
        self.assertFalse((self.root / 'state' / 'operation-pending.json').exists())

    def test_new_release_allowed_but_changed_destination_rejected(self):
        self.config['source_sha'] = 'b' * 40
        b.atomic_json(self.root / 'backup.json', self.config)
        self.run_backup()
        self.config['prefix'] = 'citygo/other'
        b.atomic_json(self.root / 'backup.json', self.config)
        with self.assertRaisesRegex(b.BackupError, 'destination-changed'):
            self.run_backup()


if __name__ == '__main__':
    unittest.main()
