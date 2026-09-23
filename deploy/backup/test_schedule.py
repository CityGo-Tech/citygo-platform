"""No timers, remote writes, real database or real emails in this suite."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import backup as b
import schedule as s
from test_backup import sample as backup_sample


def sample():
    return dict(version=1,schedule_enabled=True,monitor_enabled=True,
                backup_config="/etc/citygo/backup.json",mail_config="/etc/citygo/mail.json",
                state_dir="/var/lib/citygo-schedule",approved_until=20000,max_attempts=2)


class ScheduleValidation(unittest.TestCase):
    def test_schema_gates_and_expiry(self):
        self.assertEqual(s.validate(sample()), sample())
        s.approval(sample(),10000)
        for change in ({"version":True},{"schedule_enabled":1},{"approved_until":float("inf")},
                       {"approved_until":True},{"max_attempts":0},{"max_attempts":169},
                       {"max_attempts":True},{"backup_config":"/etc/../secret"},{"command":"delete"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): s.validate({**sample(),**change})
        for change in ({"schedule_enabled":False},{"approved_until":0},{"approved_until":10000},
                       {"approved_until":10000+7*86400+1}):
            with self.subTest(change=change), self.assertRaises(b.BackupError): s.approval({**sample(),**change},10000)

    def test_disabled_and_expired_never_read_or_run_backup(self):
        for config in ({**sample(),"schedule_enabled":False},{**sample(),"approved_until":0}):
            with patch.object(b,"load_config") as load:
                runner=Mock()
                with self.assertRaises(b.BackupError): s.perform(config,now=10000,runner=runner)
                load.assert_not_called(); runner.assert_not_called()

    def test_assessment_safe_codes_no_upstream_text(self):
        self.assertEqual(s.assessment({**sample(),"schedule_enabled":False},10000),"paused")
        self.assertEqual(s.assessment({**sample(),"approved_until":0},10000),"approval_expired")
        for error, expected in ((b.BackupError("stale-backup"),"stale"),
                                (b.BackupError("last-attempt-failed"),"backup_failed"),
                                (ValueError("SECRET"),"configuration")):
            with patch.object(b,"load_config",side_effect=error):
                self.assertEqual(s.assessment(sample(),10000),expected)

    def test_cli_imports_work_with_service_environment_flags(self):
        result=subprocess.run([sys.executable,"-E","-s","-B",str(Path(s.__file__)),"--help"],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_templates_disabled_config_no_remote_delete_and_bounded_runtime(self):
        root=Path(s.__file__).parent
        config=json.loads((root/"schedule.example.json").read_text())
        self.assertFalse(config["schedule_enabled"]); self.assertFalse(config["monitor_enabled"])
        self.assertEqual(config["approved_until"],0)
        self.assertFalse(json.loads((root/"mail.example.json").read_text())["enabled"])
        service=(root/"systemd/citygo-backup.service.template").read_text()
        self.assertIn("APPROVED_SHA",service); self.assertIn("--allow-upload",service)
        self.assertIn("LimitCORE=0",service); self.assertIn("TimeoutStartSec=60min",service)
        self.assertNotIn("Restart=always",service)
        for file in (root/"systemd").iterdir():
            text=file.read_text()
            for banned in ("delete-object","put-bucket-lifecycle","systemctl enable","PASSWORD="):
                self.assertNotIn(banned,text)

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("systemd-analyze"), "Linux systemd unit validator")
    def test_systemd_templates_parse_without_installing_or_starting(self):
        with tempfile.TemporaryDirectory(prefix="citygo-unit-test-") as temp:
            units = []
            for template in (Path(s.__file__).parent/"systemd").glob("*.template"):
                target = Path(temp)/template.name.removesuffix(".template")
                target.write_text(template.read_text().replace("APPROVED_SHA", "a"*40))
                units.append(str(target))
            result = subprocess.run(["systemd-analyze", "verify", "--man=no", *units], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            for calendar in ("*-*-* *:05:00 UTC", "*-*-* *:00/15:00 UTC"):
                result = subprocess.run(["systemd-analyze", "calendar", calendar], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipUnless(sys.platform.startswith("linux"),"Linux protected files and locks")
class ScheduleOperations(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="citygo-schedule-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)
        self.config={**sample(),"state_dir":str(self.directory/"ops"),"backup_config":str(self.directory/"backup.json")}
        self.backup=backup_sample(self.directory)
        (self.directory/"ops").mkdir(mode=0o700)
        (self.directory/"state").mkdir(mode=0o700)
        for name,text in (("compose.yml","# fixture"),("pilot.env","# fixture"),("backup.json",json.dumps(self.backup))):
            path=self.directory/name; path.write_text(text); path.chmod(0o600)

    def ledger(self): return json.loads((self.directory/"ops/attempts.json").read_text())

    def run_fake(self,now=10000):
        runner=Mock()
        with patch.object(b,"check_freshness"):
            s.perform(self.config,now=now,runner=runner)
        return runner

    def test_init_exclusive_and_required_for_run(self):
        with self.assertRaises(FileNotFoundError): self.run_fake()
        s.initialize(self.config,now=10000)
        with self.assertRaises(FileExistsError): s.initialize(self.config,now=10000)
        self.assertEqual(self.ledger()["attempts"],0)

    def test_attempts_cadence_and_cap(self):
        s.initialize(self.config,now=10000)
        self.run_fake().assert_called_once_with(self.backup)
        with self.assertRaisesRegex(b.BackupError,"schedule-too-soon"): self.run_fake(10001)
        self.run_fake(13600)
        with self.assertRaisesRegex(b.BackupError,"schedule-attempt-limit"): self.run_fake(17200)
        self.assertEqual(self.ledger()["attempts"],2)

    def test_failed_or_uncertain_run_still_spends_attempt(self):
        s.initialize(self.config,now=10000)
        def fail(_config): raise RuntimeError("upstream SECRET")
        with self.assertRaises(RuntimeError): s.perform(self.config,now=10000,runner=fail)
        self.assertEqual(self.ledger()["attempts"],1)
        with self.assertRaisesRegex(b.BackupError,"schedule-too-soon"): self.run_fake(10001)

    def test_changed_approval_or_db_refused(self):
        s.initialize(self.config,now=10000)
        with self.assertRaisesRegex(b.BackupError,"schedule-approval-changed"):
            s.perform({**self.config,"max_attempts":3},now=10000,runner=Mock())
        (self.directory/"pilot.env").write_text("CHANGED=1")
        with self.assertRaisesRegex(b.BackupError,"schedule-approval-changed"): self.run_fake()

    def test_concurrency_and_clock_refused(self):
        s.initialize(self.config,now=10000)
        with b.lock(self.directory/"ops"), self.assertRaises(b.BackupError): self.run_fake()
        self.run_fake()
        with self.assertRaisesRegex(b.BackupError,"schedule-too-soon"): self.run_fake(9999)
        self.assertEqual(s.assessment(self.config,9999),"configuration")

    def test_assessment_healthy_and_limit(self):
        s.initialize(self.config,now=10000)
        with patch.object(b,"check_freshness"):
            self.assertEqual(s.assessment(self.config,10000),"healthy")
            self.run_fake(); self.run_fake(13600)
            self.assertEqual(s.assessment(self.config,14000),"attempt_limit")

    def test_explicit_cli_gates_do_not_connect_or_dump(self):
        path=self.directory/"schedule.json"
        path.write_text(json.dumps(self.config)); path.chmod(0o600)
        for operation in ("initialize","backup","check","test-email"):
            result=subprocess.run([sys.executable,"-E","-s","-B",str(Path(s.__file__)),operation,"--config",str(path)],capture_output=True,text=True)
            self.assertEqual(result.returncode,1)
            self.assertNotIn("example.invalid",result.stderr)
            self.assertFalse((self.directory/"ops/attempts.json").exists())


if __name__ == "__main__": unittest.main()
