"""Email tests never connect to a provider or use account credentials."""
import json
from pathlib import Path
import smtplib
import ssl
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import backup as b
import notify as n


def sample():
    return dict(version=1, enabled=True, host="smtp.gmail.com", port=465,
                username="citygo@example.invalid", from_address="citygo@example.invalid",
                to_address="owner@example.invalid", password_file="/etc/citygo/mail-password.json",
                state_dir="/var/lib/citygo-mail-fixture")


class MailValidation(unittest.TestCase):
    def test_exact_schema_and_reviewed_relays(self):
        self.assertEqual(n.validate(sample()), sample())
        n.validate({**sample(), "host":"smtp.yandex.ru"})
        for change in ({"password":"secret"}, {"enabled":1}, {"version":True}, {"port":587},
                       {"port":True}, {"host":"smtp.gmail.com.evil.test"}, {"host":"127.0.0.1"},
                       {"password_file":"relative"}, {"password_file":"/etc/../secret"},
                       {"password_file":"/etc/key\n"}, {"state_dir":"/tmp/with space"}):
            with self.subTest(change=change), self.assertRaises(b.BackupError):
                n.validate({**sample(), **change})

    def test_no_header_injection_multiple_recipients_or_impersonation(self):
        for address in ("a@b.test\r\nBcc:other@b.test", "a@b.test,other@b.test", "Name <a@b.test>",
                        "a@localhost", "", "я@b.test", "x"*65+"@b.test"):
            with self.subTest(address=address), self.assertRaises(b.BackupError):
                n.validate({**sample(), "to_address":address})
        with self.assertRaises(b.BackupError):
            n.validate({**sample(), "from_address":"another@example.invalid"})

    def test_static_message_has_no_configuration_or_logs(self):
        for event in n.EVENTS:
            msg = n.message(sample(), event, 10000)
            self.assertEqual(msg["To"], sample()["to_address"])
            self.assertEqual(len(list(msg.iter_attachments())), 0)
            for forbidden in ("password_file", "/etc/citygo", "smtp.gmail.com", "AGE-SECRET-KEY"):
                self.assertNotIn(forbidden, msg.get_content())
        with self.assertRaises(b.BackupError): n.message(sample(), "raw-error-secret", 10000)

    def test_disabled_does_not_read_password_or_connect(self):
        with patch.object(b,"protected") as read, patch.object(n.smtplib,"SMTP_SSL") as connect:
            with self.assertRaisesRegex(b.BackupError,"mail-disabled"):
                n.send({**sample(),"enabled":False},"test",10000)
            read.assert_not_called()
            connect.assert_not_called()

    def test_tls_login_single_recipient_and_no_debug(self):
        # Real SSL context properties, mocked CA loading and mocked SMTP transport.
        context = ssl.create_default_context()
        smtp = Mock()
        smtp.send_message.return_value = {}
        with patch.object(b,"protected",return_value=Path("fixture")), \
             patch.object(b,"read_json",return_value={"password":"synthetic-app-password"}), \
             patch.object(n.ssl,"create_default_context",return_value=context) as trust, \
             patch.object(n.smtplib,"SMTP_SSL",return_value=smtp) as connect:
            n.send(sample(),"test",10000)
        trust.assert_called_once_with(cafile="/etc/ssl/certs/ca-certificates.crt")
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED)
        self.assertEqual(context.minimum_version,ssl.TLSVersion.TLSv1_2)
        self.assertEqual(connect.call_args.args, ("smtp.gmail.com",465))
        self.assertEqual(connect.call_args.kwargs["timeout"],20)
        smtp.login.assert_called_once_with(sample()["username"],"synthetic-app-password")
        self.assertEqual(smtp.send_message.call_args.kwargs["to_addrs"],[sample()["to_address"]])
        smtp.set_debuglevel.assert_not_called()
        smtp.close.assert_called_once()

    def test_invalid_password_does_not_connect(self):
        for value in ({"password":""}, {"password":"with space"}, {"password":"bad\nsecret"},
                      {"password":"synthetic-password", "extra":True}):
            with patch.object(b,"protected",return_value=Path("fixture")), \
                 patch.object(b,"read_json",return_value=value), patch.object(n.smtplib,"SMTP_SSL") as connect:
                with self.assertRaises(b.BackupError): n.send(sample(),"test",10000)
                connect.assert_not_called()

    def test_refusal_or_transport_failure_closes_connection(self):
        context = ssl.create_default_context()
        for failure in ("refused", "transport"):
            smtp = Mock()
            smtp.send_message.return_value = {sample()["to_address"]: (550, b"refused")}
            if failure == "transport":
                smtp.send_message.side_effect = smtplib.SMTPServerDisconnected("uncertain DATA result")
            with patch.object(b,"protected",return_value=Path("fixture")), \
                 patch.object(b,"read_json",return_value={"password":"synthetic-app-password"}), \
                 patch.object(n.ssl,"create_default_context",return_value=context), \
                 patch.object(n.smtplib,"SMTP_SSL",return_value=smtp):
                with self.assertRaises((b.BackupError, smtplib.SMTPServerDisconnected)):
                    n.send(sample(),"test",10000)
            smtp.close.assert_called_once()

    def test_dedupe_recovery_reminder_and_clock(self):
        self.assertFalse(n.due(None,"healthy",10000))
        self.assertTrue(n.due(None,"backup_failed",10000))
        state = {"channel":"a"*64,"last_attempt":10000,"accepted_at":10000,"accepted_event":"backup_failed"}
        self.assertFalse(n.due(state,"stale",10001))
        self.assertFalse(n.due(state,"healthy",10899))
        self.assertTrue(n.due(state,"healthy",10900))
        self.assertFalse(n.due(state,"backup_failed",11000))
        self.assertTrue(n.due(state,"backup_failed",10000+n.REMINDER))
        self.assertFalse(n.due({**state,"accepted_event":"test"},"healthy",11000))
        with self.assertRaises(b.BackupError): n.due(state,"stale",9999)
        for value in (float("nan"), float("inf"), True, -1):
            with self.assertRaises(b.BackupError): n.validate_state({**state,"last_attempt":value})
        for value in ({}, [], True):
            with self.assertRaises(b.BackupError): n.validate_state({**state,"accepted_event":value})
        with self.assertRaises(b.BackupError): n.due({},"test",10000)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux protected files and locks")
class MailState(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="citygo-mail-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.directory.chmod(0o700)
        self.config = {**sample(),"state_dir":str(self.directory)}
        self.sender = Mock()

    def test_accepted_and_suppressed_status_is_durable(self):
        self.assertEqual(n.notify(self.config,"backup_failed",now=10000,sender=self.sender),"smtp-accepted")
        self.assertEqual(n.notify(self.config,"backup_failed",now=12000,sender=self.sender),"suppressed")
        self.assertEqual(n.notify(self.config,"healthy",now=13000,sender=self.sender),"smtp-accepted")
        self.assertEqual(self.sender.call_count,2)
        path = self.directory / "notification.json"
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertEqual(json.loads(path.read_text())["accepted_event"],"healthy")

    def test_failed_send_reserves_attempt_but_never_claims_acceptance(self):
        self.sender.side_effect = smtplib.SMTPAuthenticationError(535,b"SECRET-SHOULD-NOT-APPEAR")
        with self.assertRaisesRegex(b.BackupError,"^mail-delivery-unconfirmed$"):
            n.notify(self.config,"stale",now=10000,sender=self.sender)
        receipt = json.loads((self.directory/"notification.json").read_text())
        self.assertIsNone(receipt["accepted_event"])
        self.assertEqual(receipt["accepted_at"],0)
        self.assertNotIn("SECRET",json.dumps(receipt))
        self.assertEqual(n.notify(self.config,"stale",now=10001,sender=self.sender),"suppressed")
        self.sender.side_effect = None
        self.assertEqual(n.notify(self.config,"stale",now=10900,sender=self.sender),"smtp-accepted")

    def test_lock_corrupt_state_permissions_and_channel_change(self):
        with b.lock(self.directory), self.assertRaises(b.BackupError):
            n.notify(self.config,"test",now=10000,sender=self.sender)
        n.notify(self.config,"test",now=10000,sender=self.sender)
        with self.assertRaisesRegex(b.BackupError,"mail-channel-changed"):
            n.notify({**self.config,"to_address":"other@example.invalid"},"stale",now=12000,sender=self.sender)
        path = self.directory/"notification.json"
        path.write_text('{"secret":"DO-NOT-PRINT"}')
        with self.assertRaises(b.BackupError): n.notify(self.config,"stale",now=12000,sender=self.sender)
        path.write_text('{}')
        with self.assertRaises(b.BackupError): n.notify(self.config,"stale",now=12000,sender=self.sender)
        path.chmod(0o644)
        with self.assertRaises(b.BackupError): n.notify(self.config,"stale",now=12000,sender=self.sender)


if __name__ == "__main__": unittest.main()
