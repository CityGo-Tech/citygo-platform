"""Opt-in, TLS-only operational email. No database, storage or message-log access."""
import hashlib
import json
from pathlib import PurePosixPath
import re
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

import backup as b

FIELDS = {"version", "enabled", "host", "port", "username", "from_address",
          "to_address", "password_file", "state_dir"}
COOLDOWN = 900
REMINDER = 86400
EVENTS = {
    "backup_failed": "Последняя попытка резервного копирования завершилась ошибкой.",
    "stale": "Нет подтверждённой свежей резервной копии за последние два часа.",
    "configuration": "Не удалось проверить состояние резервного копирования. Нужна проверка конфигурации/журнала оператором.",
    "paused": "Периодическое резервирование выключено. Автоматические копии не создаются.",
    "approval_expired": "Согласованный период резервирования закончился. Новые автоматические копии остановлены.",
    "attempt_limit": "Достигнут согласованный предел попыток. Новые автоматические копии остановлены.",
    "healthy": "Проверка свежести копий снова проходит. Это не новая проверка восстановления и не гарантия доступности хранилища.",
    "test": "Тест канала уведомлений CityGo. Подтвердите получение этого письма оператору. Расписание этим тестом не включается.",
}


def private_path(value):
    return (type(value) is str and value.startswith("/") and ".." not in PurePosixPath(value).parts
            and not re.search(r"[\x00-\x20]", value))


def address(value):
    return (type(value) is str and len(value) <= 254
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+%-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+", value))


def validate(config):
    b.require(type(config) is dict and set(config) == FIELDS, "mail-configuration")
    b.require(type(config["version"]) is int and config["version"] == 1, "mail-configuration")
    b.require(type(config["enabled"]) is bool, "mail-configuration")
    # Reviewed first transport. No implicit MX lookup or alternate relay fallback.
    b.require(config["host"] in ("smtp.gmail.com", "smtp.yandex.ru") and type(config["port"]) is int
              and config["port"] == 465, "mail-transport")
    b.require(all(address(config[key]) for key in ("username", "from_address", "to_address")), "mail-address")
    b.require(config["username"] == config["from_address"], "mail-sender")
    b.require(all(private_path(config[key]) for key in ("password_file", "state_dir")), "mail-path")
    return config


def load(path):
    return validate(b.read_json(b.protected(path)))


def message(config, event, now):
    b.require(type(event) is str and event in EVENTS, "mail-event")
    msg = EmailMessage()
    msg["From"], msg["To"] = config["from_address"], config["to_address"]
    tag = "Тест" if event == "test" else "Восстановлено" if event == "healthy" else "Требуется внимание"
    msg["Subject"] = "CityGo — резервные копии: " + tag
    msg["Date"] = formatdate(now, usegmt=True)
    msg["Message-ID"] = make_msgid(domain=config["from_address"].split("@")[1])
    msg["Auto-Submitted"] = "auto-generated"
    msg.set_content(EVENTS[event] + "\n\nПроверьте служебный статус на сервере. "
                    "Это письмо не содержит ключей, дампов, логов или данных пользователей.\n")
    return msg


def send(config, event, now):
    validate(config)
    b.require(config["enabled"], "mail-disabled")
    msg = message(config, event, now)
    credential = b.read_json(b.protected(config["password_file"]))
    b.require(type(credential) is dict and set(credential) == {"password"}, "mail-credential")
    password = credential["password"]
    b.require(type(password) is str and re.fullmatch(r"[\x21-\x7e]{8,256}", password), "mail-credential")
    # Explicit Ubuntu CA bundle: inherited SSL_CERT_FILE/DIR cannot redirect trust.
    context = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    client = None
    try:
        client = smtplib.SMTP_SSL(config["host"], config["port"], timeout=20,
                                 context=context, local_hostname="citygo.invalid")
        client.login(config["username"], password)
        refused = client.send_message(msg, from_addr=config["from_address"], to_addrs=[config["to_address"]])
        b.require(not refused, "mail-recipient-refused")
        # Acceptance by SMTP is NOT proof that the message reached the inbox.
    finally:
        password = credential = None
        if client is not None:
            try:
                client.close()
            except OSError:
                pass


def fingerprint(config):
    # Never hash/password-read for dedupe. Changed recipient/relay => new channel.
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def validate_state(state):
    b.require(type(state) is dict and set(state) == {"channel", "last_attempt", "accepted_at", "accepted_event"}, "mail-state")
    b.require(type(state["channel"]) is str and re.fullmatch(r"[a-f0-9]{64}", state["channel"]), "mail-state")
    b.require(all(type(state[x]) in (int, float) and 0 <= state[x] < float("inf")
                  for x in ("last_attempt", "accepted_at")), "mail-state")
    b.require(state["accepted_event"] is None or
              (type(state["accepted_event"]) is str and state["accepted_event"] in EVENTS), "mail-state")
    b.require(state["accepted_at"] <= state["last_attempt"], "mail-state")
    return state


def due(state, event, now):
    b.require(type(event) is str and event in EVENTS and type(now) in (int, float) and 0 < now < float("inf"), "mail-event")
    if state is not None:
        validate_state(state)
        b.require(now >= state["last_attempt"], "mail-clock")
        if now - state["last_attempt"] < COOLDOWN:
            return False
    # No healthy-startup spam and no 'recovery' from a test message.
    if event == "healthy":
        return bool(state and state["accepted_event"] not in (None, "healthy", "test"))
    return (not state or event == "test" or state["accepted_event"] != event
            or now - state["accepted_at"] >= REMINDER)


def notify(config, event, *, now=None, sender=send):
    validate(config)
    b.require(config["enabled"], "mail-disabled")
    now = time.time() if now is None else now
    directory = b.protected(config["state_dir"], directory=True)
    with b.lock(directory):
        path = directory / "notification.json"
        previous = b.read_json(b.protected(path)) if path.exists() else None
        if previous is not None:
            validate_state(previous)
            b.require(previous["channel"] == fingerprint(config), "mail-channel-changed")
        if not due(previous, event, now):
            return "suppressed"
        state = previous or {"channel": fingerprint(config), "last_attempt": 0, "accepted_at": 0, "accepted_event": None}
        # Reserve the attempt BEFORE network I/O. Uncertain DATA results won't loop.
        state = {**state, "last_attempt": now}
        b.atomic_json(path, state)
        try:
            sender(config, event, now)
        except Exception:
            raise b.BackupError("mail-delivery-unconfirmed") from None
        b.atomic_json(path, {**state, "accepted_at": now, "accepted_event": event})
        return "smtp-accepted"
