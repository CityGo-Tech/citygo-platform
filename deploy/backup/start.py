"""Independently approved API/Web profile + read-only health, not full deploy.

Requires independent startup approval AND the live migration continuation.
start() retains pending. Only the internal live continuation can feed the separately
approved closed finish. No CLI, traffic/Worker opening or automatic rollback.
"""
import base64
import binascii
import copy
from contextlib import contextmanager
import http.client
import os
from pathlib import Path, PurePosixPath
import tempfile
import threading
import time
from urllib.parse import urlsplit

import backup as b
import migrate as c
import migration_job as m
import prepare as p
import target as t
import worker as w

PROFILE = "citygo-api-web-disabled-v1"
ROUTERAI_PROFILE = "citygo-api-web-routerai-credit-v1"
CITYGO_10X_PROFILE = "citygo-api-web-routerai-citygo-10x-v1"
CITYGO_10X_YOOKASSA_LIVE_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-v2"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-smsru-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-v1"
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE = "citygo-api-web-routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-v1"
POSTPAY_ACTUAL_PROFILE = "citygo-api-web-postpay-actual-v1"
POSTPAY_CONTEXT64_PROFILE = "citygo-api-web-postpay-context64-v1"
PROFILE_VERSIONS = {PROFILE: 1, ROUTERAI_PROFILE: 2, CITYGO_10X_PROFILE: 3,
                    CITYGO_10X_YOOKASSA_LIVE_PROFILE: 4, CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE: 5,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_PROFILE: 6,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_PROFILE: 7,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE: 8,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE: 9,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE: 10,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE: 11,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE: 12,
                    CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE: 13,
                    POSTPAY_ACTUAL_PROFILE: 14, POSTPAY_CONTEXT64_PROFILE: 15}
CLOSED_ONLY_PROFILES = frozenset((CITYGO_10X_YOOKASSA_LIVE_PROFILE, CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE,
                                CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE,
                                POSTPAY_ACTUAL_PROFILE, POSTPAY_CONTEXT64_PROFILE))
# Public configuration is pinned together with the private key by startup approval.
# No live budget, user bonus, consent or payment authorization is encoded here.
ROUTERAI_FIXED = {
    "AI_CREDIT_MODE": "routerai_at_cost",
    "ROUTERAI_MODEL": "deepseek/deepseek-v4-pro-0813",
    "ROUTERAI_UPSTREAM": "deepseek", "ROUTERAI_COUNTRY": "us",
    "ROUTERAI_REASONING_EFFORT": "high", "ROUTERAI_MAX_OUTPUT_TOKENS": "32768",
    "ROUTERAI_REQUEST_TIMEOUT_MS": "240000", "LLM_MAX_INPUT_BYTES": "64000",
}
# This historical profile keeps payments disabled. Adding a live transport must
# not reinterpret an already approved configuration or admit sandbox funds.
CITYGO_10X_FIXED = {**ROUTERAI_FIXED, "AI_CREDIT_MODE": "routerai_citygo_10x",
                   "YOOKASSA_MODE": "disabled"}
# Separate closed startup scope. The complete private document (including shop,
# keys and notice) is hash-bound by approval; no traffic or money allowance is
# supplied here, and the manual NPD workflow is not a claim of automatic receipts.
CITYGO_10X_YOOKASSA_LIVE_FIXED = {**CITYGO_10X_FIXED, "YOOKASSA_MODE": "live",
                                "YOOKASSA_RECEIPT_MODE": "npd_manual"}
# A new exact recipient/resource envelope, not a reinterpretation of v1-v4.
# This prepares transports only; budget, routing, user consent and ingress stay
# independently closed. No Flash or provider fallback is admitted here.
CITYGO_10X_YOOKASSA_LIVE_CN_FIXED = {**CITYGO_10X_YOOKASSA_LIVE_FIXED,
    "ROUTERAI_COUNTRY": "cn", "ROUTERAI_MAX_OUTPUT_TOKENS": "4096", "LLM_MAX_INPUT_BYTES": "8192"}
# Receipt-bearing requests have a new independently approved configuration.
# This exact transport choice is not legal certification or payment admission.
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_FIXED = {**CITYGO_10X_YOOKASSA_LIVE_CN_FIXED,
    "YOOKASSA_FISCAL_PROFILE": "citygo_service_full_payment_v1"}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_FIXED = {**CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_FIXED,
    "AI_CREDIT_RESERVATION_MODE": "fixed5_overdraft"}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_FIXED = {**CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_FIXED,
    "EMAIL_REGISTRATION_MODE": "required", "EMAIL_DELIVERY_PROVIDER": "yandex_postbox",
    "POSTBOX_FROM_EMAIL": "no-reply@xn--c1ajazlh.xn--p1ai",
    "PHONE_VERIFICATION_MODE": "disabled", "SMS_RU_MODE": "disabled"}
EMAIL_PRIVATE_KEYS = {"EMAIL_REGISTRATION_SECRET", "POSTBOX_ACCESS_KEY_ID", "POSTBOX_SECRET_ACCESS_KEY"}
EMAIL_LIMITS = {"EMAIL_SEND_DAILY_LIMIT": 100000, "EMAIL_SEND_TOTAL_LIMIT": 1000000}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_FIXED = {
    **CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_FIXED,
    "PHONE_VERIFICATION_MODE": "sms_ru", "SMS_RU_MODE": "live"}
PHONE_SMS_PRIVATE_KEYS = {"PHONE_VERIFICATION_SECRET", "SMS_RU_API_ID", "SMS_RU_FROM"}
PHONE_SMS_LIMITS = {"PHONE_SMS_GLOBAL_DAILY_LIMIT": 100000, "PHONE_SMS_GLOBAL_TOTAL_LIMIT": 1000000}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_FIXED = {
    **CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_FIXED,
    "PHONE_VERIFICATION_MODE": "prosto_sms", "PROSTOSMS_MODE": "live"}
PROSTOSMS_PRIVATE_KEYS = {"PHONE_VERIFICATION_SECRET", "PROSTOSMS_API_KEY", "PROSTOSMS_SENDER"}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_FIXED = {
    **CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_FIXED,
    "AI_ASSISTANT_MODES": "enabled", "AI_MAXIMUM_REASONING_EFFORT": "medium"}
CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_FIXED = {
    **CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_FIXED,
    "AI_MINIMUM_FIXED_FEE": "enabled", "GIGACHAT_MODEL": "GigaChat-3-Ultra",
    "GIGACHAT_SCOPE": "GIGACHAT_API_PERS", "GIGACHAT_CA_BUNDLE_FILE": "/app/certs/russian-trusted-root.crt",
    "LLM_REQUEST_TIMEOUT_MS": "60000"}
# v14 is independently hash-bound; v1-v13 never acquire this billing mode.
POSTPAY_ACTUAL_FIXED = {**CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_FIXED,
    "AI_CUSTOMER_BILLING_MODE": "postpay_actual_v1",
    "AI_REQUEST_COST_LIMIT_MODE": "operator_ceiling"}
# v15 changes only the input envelope. v14 remains byte-for-byte compatible.
POSTPAY_CONTEXT64_FIXED = {**POSTPAY_ACTUAL_FIXED, "LLM_MAX_INPUT_BYTES": "65536"}
ASSISTANT_MODES_KEYS = {"AI_MODES_DATA_NOTICE", "AI_MODES_PRODUCTION_POLICY_ID"}
ASSISTANT_MODES_PROFILES = frozenset((CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE,
                                     CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE,
                                POSTPAY_ACTUAL_PROFILE, POSTPAY_CONTEXT64_PROFILE))
PROSTOSMS_UNLIMITED_PROFILES = frozenset((CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE,
                                        *ASSISTANT_MODES_PROFILES))
PROSTOSMS_PROFILES = frozenset((CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE,
                               *PROSTOSMS_UNLIMITED_PROFILES))
YOOKASSA_LIVE_KEYS = {"YOOKASSA_SHOP_ID", "YOOKASSA_SECRET_KEY"}
ROUTERAI_LIMITS = {
    "LLM_USER_DAILY_REQUEST_LIMIT": 10000, "LLM_GLOBAL_DAILY_REQUEST_LIMIT": 1000000,
    "LLM_USER_DAILY_ATTEMPT_LIMIT": 10000, "LLM_GLOBAL_DAILY_ATTEMPT_LIMIT": 1000000,
}
MEMORY = 768 * 1024 * 1024
INSPECT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
           '"RestartCount":{{json .RestartCount}},"State":{{json .State}},'
           '"Config":{{json .Config}},"HostConfig":{{json .HostConfig}},'
           '"Mounts":{{json .Mounts}},"NetworkSettings":{{json .NetworkSettings}}}')


def _valid_gigachat_credentials(value):
    # Same canonical Basic account contract as the application's PERS lease.
    # Parse only in memory; never include the key or decoded account in errors.
    if type(value) is not str or len(value) > 4096 or not t.matches(value, r"[A-Za-z0-9+/]+={0,2}"):
        return False
    try:
        decoded = base64.b64decode(value + "=" * ((-len(value)) % 4), validate=True)
    except (ValueError, binascii.Error):
        return False
    canonical = base64.b64encode(decoded).decode("ascii")
    if canonical.rstrip("=") != value.rstrip("=") or ("=" in value and canonical != value):
        return False
    if not decoded or any(byte < 0x21 or byte > 0x7e for byte in decoded):
        return False
    account, separator, secret = decoded.decode("ascii").partition(":")
    return bool(separator and secret and t.matches(account, r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"))


def api_secret(path, profile=PROFILE):
    data = t.read_file(path)
    b.require(len(data) <= 16384, "start-secret")
    value = t.strict_json(data)
    b.require(type(profile) is str and profile in PROFILE_VERSIONS and type(value) is dict, "start-secret")
    if profile == PROFILE:
        b.require({"DATABASE_URL"} <= set(value) <= {"DATABASE_URL", "ADMIN_USER_IDS"}, "start-secret")
    else:
        fixed = (POSTPAY_CONTEXT64_FIXED if profile == POSTPAY_CONTEXT64_PROFILE else
                 POSTPAY_ACTUAL_FIXED if profile == POSTPAY_ACTUAL_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_FIXED if profile in PROSTOSMS_PROFILES else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_CN_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE else
                 CITYGO_10X_YOOKASSA_LIVE_FIXED if profile == CITYGO_10X_YOOKASSA_LIVE_PROFILE else
                 CITYGO_10X_FIXED if profile == CITYGO_10X_PROFILE else ROUTERAI_FIXED)
        payment_keys = YOOKASSA_LIVE_KEYS if profile in CLOSED_ONLY_PROFILES else set()
        email_keys = EMAIL_PRIVATE_KEYS | set(EMAIL_LIMITS) if profile in (CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE, CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE, *PROSTOSMS_PROFILES) else set()
        phone_keys = PHONE_SMS_PRIVATE_KEYS | set(PHONE_SMS_LIMITS) if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE else set()
        prosto_keys = PROSTOSMS_PRIVATE_KEYS | set(PHONE_SMS_LIMITS) if profile in PROSTOSMS_PROFILES else set()
        modes_keys = ASSISTANT_MODES_KEYS if profile in ASSISTANT_MODES_PROFILES else set()
        giga_keys = {"GIGACHAT_CREDENTIALS"} if profile in (CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE, POSTPAY_ACTUAL_PROFILE, POSTPAY_CONTEXT64_PROFILE) else set()
        t.keys(value, {"DATABASE_URL", "ADMIN_USER_IDS", "ROUTERAI_API_KEY", "ROUTERAI_DATA_NOTICE",
                       "ROUTERAI_PRODUCTION_POLICY_ID"} | set(fixed) | set(ROUTERAI_LIMITS) | payment_keys | email_keys | phone_keys | prosto_keys | modes_keys | giga_keys, "start-secret")
        b.require(all(type(v) is str and v.strip() == v and v and not any(ord(c) < 32 for c in v)
                      for v in value.values()), "start-secret")
        b.require(all(value[k] == v for k, v in fixed.items()), "start-secret")
        b.require(all(t.matches(value[k], r"0|[1-9][0-9]{0,6}") and int(value[k]) <= maximum
                      for k, maximum in ROUTERAI_LIMITS.items()), "start-secret")
        b.require(t.matches(value["ROUTERAI_PRODUCTION_POLICY_ID"], t.HASH)
                  and len(value["ROUTERAI_DATA_NOTICE"].encode("utf-16-le")) <= 8000
                  and len(value["ROUTERAI_API_KEY"]) <= 8192, "start-secret")
        if modes_keys:
            # Separate hash-bound rollout, never implied by a legacy key or profile.
            # Legacy profiles still admit no GigaChat credentials or billing flags.
            b.require(t.matches(value["AI_MODES_PRODUCTION_POLICY_ID"], t.HASH)
                      and len(value["AI_MODES_DATA_NOTICE"].encode("utf-16-le")) <= 8000, "start-secret")
        if giga_keys:
            b.require(_valid_gigachat_credentials(value["GIGACHAT_CREDENTIALS"]), "start-secret")
        if payment_keys:
            # Match the application's explicit live-mode credential policy.
            # Merchant ownership/mode is checked separately with GET /v3/me;
            # neither the key prefix nor startup approval proves acceptance.
            b.require(t.matches(value["YOOKASSA_SHOP_ID"], r"[1-9][0-9]{0,19}")
                      and t.matches(value["YOOKASSA_SECRET_KEY"], r"live_[A-Za-z0-9_=-]{8,8192}"), "start-secret")
        if email_keys:
            # Email sentinel is independent of the separate v11 SMS identity.
            # Zero and every legacy AI/SMS quota retain their old meaning.
            b.require(t.matches(value["EMAIL_REGISTRATION_SECRET"], t.HASH)
                      and t.matches(value["POSTBOX_ACCESS_KEY_ID"], r"[A-Za-z0-9_-]{8,128}")
                      and t.matches(value["POSTBOX_SECRET_ACCESS_KEY"], r"[!-~]{16,256}")
                      and all(value[key] == "unlimited" or
                              (t.matches(value[key], r"[1-9][0-9]{0,6}") and int(value[key]) <= maximum)
                              for key, maximum in EMAIL_LIMITS.items()), "start-secret")
        if phone_keys:
            b.require(t.matches(value["PHONE_VERIFICATION_SECRET"], t.HASH)
                      and value["PHONE_VERIFICATION_SECRET"] != value["EMAIL_REGISTRATION_SECRET"]
                      and t.matches(value["SMS_RU_API_ID"], r"[A-Za-z0-9_-]{16,128}")
                      and t.matches(value["SMS_RU_FROM"], r"[A-Za-z0-9][A-Za-z0-9._-]{0,10}")
                      and all(t.matches(value[key], r"[1-9][0-9]{0,6}") and int(value[key]) <= maximum
                              for key, maximum in PHONE_SMS_LIMITS.items()), "start-secret")
        if prosto_keys:
            b.require(t.matches(value["PHONE_VERIFICATION_SECRET"], t.HASH)
                      and value["PHONE_VERIFICATION_SECRET"] != value["EMAIL_REGISTRATION_SECRET"]
                      and t.matches(value["PROSTOSMS_API_KEY"], r"[!-~]{16,256}")
                      and t.matches(value["PROSTOSMS_SENDER"], r"[A-Za-z0-9][A-Za-z0-9._-]{0,10}")
                      and all((value[key] == "unlimited" if profile in PROSTOSMS_UNLIMITED_PROFILES
                               else t.matches(value[key], r"[1-9][0-9]{0,6}") and int(value[key]) <= maximum)
                              for key, maximum in PHONE_SMS_LIMITS.items()), "start-secret")
    url = value["DATABASE_URL"]
    b.require(type(url) is str and not any(ord(ch) <= 32 for ch in url), "start-secret")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in ("postgres", "postgresql") and parsed.username == "citygo_api"
                 and bool(parsed.password) and parsed.hostname == "postgres" and parsed.port == 5432
                 and parsed.path == "/citygo_pilot" and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    b.require(valid, "start-secret")
    if "ADMIN_USER_IDS" in value:
        # CityGo users.id is bigint, not UUID. Approval still pins the exact list.
        b.require(t.matches(value["ADMIN_USER_IDS"], r"[1-9][0-9]{0,17}(?:,[1-9][0-9]{0,17}){0,19}")
                  and len(set(value["ADMIN_USER_IDS"].split(","))) == len(value["ADMIN_USER_IDS"].split(",")), "start-secret")
    return data


def approval(data, now):
    value = t.strict_json(data)
    t.keys(value, {"version", "purpose", "profile", "migration_approval_sha256", "api_secret_sha256",
                   "web_network_id", "approved_at", "expires_at", "allow_start", "allow_traffic"}, "start-approval")
    b.require(type(value["version"]) is int
              and (value["version"], value["profile"]) in tuple((version, profile) for profile, version in PROFILE_VERSIONS.items())
              and value["purpose"] == "citygo-release-start"
              and value["allow_start"] is True and value["allow_traffic"] is False, "start-approval")
    for key in ("migration_approval_sha256", "api_secret_sha256", "web_network_id"):
        b.require(t.matches(value[key], t.HASH), "start-approval")
    b.require(type(value["approved_at"]) is int and type(value["expires_at"]) is int
              and 0 < value["approved_at"] <= now < value["expires_at"] <= value["approved_at"] + 86400, "start-expired")
    return value


class Approval:
    def __init__(self, path):
        self.path = Path(path)
        self._pin, self._failed = None, False

    def verify(self, selection, migration_authorization, config, target_sha, origin, images, secret_file):
        b.require(not self._failed, "start-approval-invalidated")
        try:
            b.require(type(selection) is t.Selection and type(migration_authorization) is c.Approval, "start-selection")
            b.require(self.path.is_absolute() and ".." not in self.path.parts
                      and self.path not in (selection.approval_file, migration_authorization.path)
                      and all(not self.path.is_relative_to(root) for root in
                              (selection.current_directory, selection.target_directory)), "start-self-approval")
            raw = t.read_file(self.path, private=True)
            approved = approval(raw, time.time())
            b.require(self._pin is None or self._pin == t.sha256(raw), "start-approval-changed")
            migration = migration_authorization.verify(selection, config, target_sha, origin, images)
            b.require(approved["migration_approval_sha256"] == migration["approval_sha256"]
                      and approved["api_secret_sha256"] == t.sha256(api_secret(secret_file, approved["profile"])), "start-binding")
            b.require(t.read_file(self.path, private=True) == raw, "start-approval-changed")
            approval(raw, time.time())
            self._pin = t.sha256(raw)
            return {"approval_sha256": self._pin, "migration": migration, "profile": approved["profile"],
                    "web_network_id": approved["web_network_id"], "api_secret_sha256": approved["api_secret_sha256"]}
        except Exception:
            self._failed = True
            raise


def profile_environment(profile):
    b.require(type(profile) is str and profile in PROFILE_VERSIONS, "start-profile")
    return ({"LLM_PROVIDER": "disabled"} if profile == PROFILE else
            {"LLM_PROVIDER": "routerai", "CITYGO_AI_PROFILE":
             "postpay-context64-v1" if profile == POSTPAY_CONTEXT64_PROFILE else
             "postpay-actual-v1" if profile == POSTPAY_ACTUAL_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_GIGACHAT_FLAT3_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_ASSISTANT_MODES_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_UNLIMITED_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROSTO_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-smsru-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_SMS_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_EMAIL_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_OVERDRAFT_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-fiscal-v2" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_FISCAL_PROFILE else
             "routerai-citygo-10x-yookassa-live-cn-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_CN_PROFILE else
             "routerai-citygo-10x-yookassa-live-v1" if profile == CITYGO_10X_YOOKASSA_LIVE_PROFILE else
             "routerai-citygo-10x-v1" if profile == CITYGO_10X_PROFILE else "routerai-credit-v1"})


def compose_spec(project, origin, images, secret_file, profile=PROFILE):
    # Fixed trusted profile, never execute candidate Compose, lifecycle hooks,
    # env_file, shell or inherited variables. Only two services, external nets.
    p.hostname(origin)
    secret_file = str(secret_file)
    b.require(PurePosixPath(secret_file).is_absolute() and ".." not in PurePosixPath(secret_file).parts
              and not any(ch in secret_file for ch in "$\r\n\0"), "start-secret-path")
    shared = {"init": True, "read_only": True, "user": "1000:1000", "restart": "no",
              "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "pids_limit": 128,
              "mem_limit": MEMORY, "memswap_limit": MEMORY, "tmpfs": ["/tmp:size=64m,mode=1777"],
              "entrypoint": ["node", "scripts/container-runtime.mjs"], "working_dir": "/app",
              "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}}
    api = {**copy.deepcopy(shared), "image": images["api"]["local_id"], "command": ["api"], "stop_grace_period": "330s",
           "environment": {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0", "API_PORT": "4000",
                           "WEB_ORIGIN": origin, "TRUSTED_PROXY_CIDRS": "172.30.92.10/32", **profile_environment(profile)},
           "secrets": [{"source": "api_config", "target": "api.json"}],
           "networks": {"web_api": {"ipv4_address": "172.30.92.11"}, "database": {}}}
    web = {**copy.deepcopy(shared), "image": images["web"]["local_id"], "command": ["web"], "stop_grace_period": "30s",
           "environment": {"PORT": "3000"}, "ports": ["127.0.0.1:3000:3000"],
           "tmpfs": ["/tmp:size=64m,mode=1777", "/app/apps/web/.next/cache:size=64m,uid=1000,gid=1000"],
           "networks": {"web_api": {"ipv4_address": "172.30.92.10"}},
           "depends_on": {"api": {"condition": "service_healthy"}}}
    for role, service in (("api", api), ("web", web)):
        service["healthcheck"] = {"test": ["CMD", "node", "scripts/container-health.mjs", role],
                                  "interval": "5s", "timeout": "5s", "start_period": "15s", "retries": 12}
    return {"name": project, "services": {"api": api, "web": web},
            "secrets": {"api_config": {"file": secret_file}},
            "networks": {name: {"external": True, "name": project + "_" + name} for name in ("web_api", "database")}}


def health(status, headers, body, *, ready):
    b.require(len(body) <= 4096 and headers.get("content-type", "").startswith("application/json"), "start-health")
    value = t.strict_json(body)
    if ready:
        b.require(status == 200 and value == {"status": "ok"}, "start-health")
    else:
        b.require(status == 401 and type(value) is dict and value.get("code") == "UNAUTHENTICATED"
                  and value.get("contractVersion") == "1" and value.get("retryable") is False
                  and type(value.get("error")) is str and bool(value["error"])
                  and headers.get("x-citygo-contract-version") == "1"
                  and type(value.get("requestId")) is str and bool(value["requestId"])
                  and headers.get("x-request-id") == value["requestId"], "start-contract")


class Host(p.Host):
    def web_network(self):
        value = t.strict_json(self.capture(["network", "inspect", "--format",
            '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
            self.project + "_web_api"]).encode())
        b.require(value.get("Name") == self.project + "_web_api"
                  and value.get("Labels", {}).get("com.docker.compose.project") == self.project
                  and value.get("Labels", {}).get("com.docker.compose.network") == "web_api", "start-network")
        return {"id": value.get("Id"), "peers": sorted(value.get("Containers", {}))}

    def detail(self, ident):
        # Never persist this raw result (contains environment/engine health log).
        return t.strict_json(self.capture(["inspect", "--format", INSPECT, ident]).encode())

    def replace(self, directory, spec):
        path = directory / "start.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream: stream.write(m.wire(spec))
        (directory / "empty.env").write_bytes(b"# no inherited environment\n")
        self.capture(["compose", "--project-directory", str(directory), "--env-file", str(directory / "empty.env"),
                      "-p", self.project, "-f", str(path), "up", "--no-deps", "--no-build", "--pull", "never",
                      "--force-recreate", "--wait", "--wait-timeout", "150", "--timeout", "30", "api", "web"], timeout=240)

    def probe(self):
        # Direct loopback only; no DNS, redirects, proxy, registration or AI call.
        for path, ready, version in (("/api/ready", True, None), ("/api/v1/dashboard", False, "1"), ("/api/v1/dashboard", False, None)):
            connection = http.client.HTTPConnection("127.0.0.1", 3000, timeout=10)
            try:
                headers = {"Host": self.host, "X-Forwarded-Proto": "https", "Connection": "close"}
                if version is not None: headers["X-CityGo-Contract-Version"] = version
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                health(response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(4097), ready=ready)
            finally: connection.close()


def runtime(value, role, image, project, origin, secret_file, networks, profile=PROFILE):
    cfg, host, state = value.get("Config", {}), value.get("HostConfig", {}), value.get("State", {})
    b.require(t.matches(value.get("Id"), t.HASH) and value.get("Image") in (image["local_id"], image["config_id"])
              and cfg.get("Image") == image["local_id"] and cfg.get("User") == "1000:1000"
              and cfg.get("Entrypoint") == ["node", "scripts/container-runtime.mjs"] and cfg.get("Cmd") == [role]
              and cfg.get("WorkingDir") == "/app", "start-runtime")
    labels = cfg.get("Labels", {})
    b.require(labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.service") == role
              and labels.get("com.docker.compose.oneoff") in ("False", "false"), "start-container")
    b.require(type(value.get("RestartCount")) is int and value["RestartCount"] == 0
              and state.get("Running") is True and state.get("Status") == "running"
              and all(state.get(k) is False for k in ("Paused", "Restarting", "OOMKilled", "Dead"))
              and state.get("Error") == "" and state.get("Health", {}).get("Status") == "healthy", "start-unhealthy")
    w.timestamp(state.get("StartedAt"))
    b.require(host.get("Init") is True and host.get("ReadonlyRootfs") is True and host.get("Privileged") is False
              and host.get("AutoRemove") is False and host.get("Memory") == MEMORY and host.get("MemorySwap") == MEMORY
              and host.get("PidsLimit") == 128 and host.get("CapDrop") == ["ALL"]
              and host.get("SecurityOpt") == ["no-new-privileges:true"] and host.get("RestartPolicy", {}).get("Name") == "no"
              and cfg.get("StopTimeout") == (330 if role == "api" else 30), "start-isolation")
    ports = host.get("PortBindings") or {}
    b.require(ports == ({} if role == "api" else {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}), "start-ports")
    mounts = value.get("Mounts", [])
    b.require(len(mounts) == (1 if role == "api" else 0), "start-mounts")
    if role == "api":
        mount = mounts[0]
        b.require(mount.get("Type") == "bind" and mount.get("Source") == str(secret_file)
                  and mount.get("Destination") == "/run/secrets/api.json" and mount.get("RW") is False, "start-mounts")
    env = cfg.get("Env", [])
    b.require(type(env) is list and all(type(e) is str and "=" in e for e in env), "start-environment")
    values = dict(e.split("=", 1) for e in env)
    allowed_env = {"PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "NEXT_TELEMETRY_DISABLED"}
    allowed_env |= ({"CITYGO_MOUNTED_CONFIG", "API_HOST", "API_PORT", "WEB_ORIGIN", "TRUSTED_PROXY_CIDRS", "LLM_PROVIDER"}
                    if role == "api" else {"PORT"})
    expected_ai = profile_environment(profile)
    if role == "api": allowed_env |= set(expected_ai)
    b.require(len(values) == len(env) and values.get("NODE_ENV") == "production"
              and set(values) <= allowed_env
              and not any(k in values for k in ("DATABASE_URL", "OPENAI_API_KEY", "ROUTERAI_API_KEY", "GIGACHAT_CREDENTIALS")), "start-environment")
    if role == "api":
        b.require(all(values.get(k) == v for k, v in {"CITYGO_MOUNTED_CONFIG": "1", "API_HOST": "0.0.0.0",
            "API_PORT": "4000", "WEB_ORIGIN": origin, **expected_ai, "TRUSTED_PROXY_CIDRS": "172.30.92.10/32"}.items()), "start-environment")
    attached = value.get("NetworkSettings", {}).get("Networks", {})
    expected = {project + "_web_api": networks["web_api"]}
    if role == "api": expected[project + "_database"] = networks["database"]
    b.require(set(attached) == set(expected) and all(attached[k].get("NetworkID") == v for k, v in expected.items())
              and attached[project + "_web_api"].get("IPAddress") == ("172.30.92.11" if role == "api" else "172.30.92.10"), "start-networks")
    return {"id": value["Id"], "image": value["Image"], "role": role, "started_at": state["StartedAt"]}


def start(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file, *,
          startup_authorization=None, allow_start=False, **options):
    b.require("authorization_check" not in options, "start-only")
    with _started_window(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file,
                         startup_authorization=startup_authorization, allow_start=allow_start, **options) as stage:
        result = copy.deepcopy(stage["result"])
    return result


@contextmanager
def _started_window(config, target_sha, origin, ingress_directory, images, secret_file, api_secret_file, *,
                    startup_authorization=None, allow_start=False, authorization_check=None, **options):
    b.require(allow_start is True and type(startup_authorization) is Approval, "explicit-start-permission-required")
    b.require("authorization_check" not in options, "start-only")
    config, images = copy.deepcopy(b.validate(config)), p.expected_images(images)
    api_secret_file = Path(api_secret_file)
    selected = options.get("selection"); migration_auth = options.get("authorization")
    approved = startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file)
    state = b.protected(config["state_dir"], directory=True)
    used = state / ("start-approval-" + approved["approval_sha256"] + ".used.json")
    reservation = None
    host_factory = options.setdefault("host_factory", Host)
    def check(*, initial=False):
        if authorization_check is not None: authorization_check()
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
        if reservation is None: b.require(not os.path.lexists(used), "start-approval-used")
        else: b.require(t.read_file(used, private=True) == reservation, "start-reservation-changed")
        # Read-only preflight, repeated at migration boundaries. A stale web
        # network approval must fail BEFORE pause/drain/backup/DDL, not after it.
        with tempfile.TemporaryDirectory(prefix=".start-preflight-", dir=state) as tmp:
            probe_host = host_factory(config, Path(tmp), ingress_directory, origin)
            values = probe_host.inventory()
            if initial:
                p.validate_inventory(values, config["project"], images, initial=True,
                                     retained_jobs=approved["migration"]["selected"]["retained_jobs"])
            apps = [v for v in values if v.get("Labels", {}).get("com.docker.compose.service") in ("api", "web")]
            b.require(len(apps) == 2 and {v["Labels"]["com.docker.compose.service"] for v in apps} == {"api", "web"}
                      and all(v["Labels"].get("com.docker.compose.project") == config["project"]
                              and t.matches(v.get("Id"), t.HASH) for v in apps), "start-container-set")
            allowed = {v["Id"] for v in apps}
            required = {v["Id"] for v in apps if v["State"]["Running"]}
            network = probe_host.web_network()
            b.require(network.get("id") == approved["web_network_id"], "start-network-changed")
            b.require(required <= set(network["peers"]) <= allowed, "start-network-peers")
        # The Docker read must not outlive a revoked/expired approval.
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
    check(initial=True)
    with c._migrated_window(config, target_sha, origin, ingress_directory, images, secret_file,
                            authorization_check=check, **options) as stage:
        window, host, migration = stage["window"], stage["host"], stage["result"]["migration"]
        stage["assert_migrated"]()
        before = host.inventory()
        baseline = {v["Id"]: v for v in before if v["Labels"]["com.docker.compose.service"] not in ("api", "web")}
        old_apps = {v["Labels"]["com.docker.compose.service"]: v["Id"] for v in before if v["Labels"]["com.docker.compose.service"] in ("api", "web")}
        network_ids = {"web_api": approved["web_network_id"], "database": stage["network"]["id"]}
        target_images = stage["proof"]["local_images"]["target"]
        spec = compose_spec(config["project"], origin, target_images, api_secret_file, approved["profile"])
        def guard(*, final=False, cutover=False):
            if final:
                # Read-only receipt gate after context cleanup, NOT a resumed
                # release window or permission to mutate services/the database.
                b.verify_operation(state, window._operation)
                b.require(not os.path.lexists(state / w.ADMISSION), "worker-not-paused")
                if not cutover:
                    b.require(b.configuration_fingerprint(config) == window._operation["configuration_sha256"], "configuration-changed")
            else:
                window._check()
            if not cutover: stage["check_selection"]()
            host.assert_closed()
            values = host.inventory()
            p.check_retained(values, config["project"], approved["migration"]["selected"]["retained_jobs"])
            retained = {v["Id"]: v for v in values if v.get("Id") in baseline}
            b.require(set(retained) == set(baseline), "start-retained-missing")
            p.same_inventory(baseline, retained)
            for ident, value in retained.items():
                b.require(p.evidence(value) == p.evidence(baseline[ident]), "start-retained-changed")
                if value["Labels"]["com.docker.compose.service"] == "postgres":
                    b.require(value["State"].get("Health", {}).get("Status") == "healthy", "start-postgres-unhealthy")
            apps = [v for v in values if v["Id"] not in baseline]
            b.require(len(apps) == 2 and {v["Labels"]["com.docker.compose.service"] for v in apps} == {"api", "web"}, "start-container-set")
            for name, network in (("database", host.database_network()), ("web_api", host.web_network())):
                allowed = {v["Id"] for v in values if (v["Labels"]["com.docker.compose.service"] != "web" if name == "database" else v in apps)}
                required = {v["Id"] for v in values if v["Id"] in allowed and v["State"]["Running"]}
                b.require(network["id"] == network_ids[name] and required <= set(network["peers"]) <= allowed, "start-network-changed")
            return apps
        guard()
        operation = window._operation["id"]
        reservation = m.wire({"version": 1, "operation_id": operation, "approval_sha256": approved["approval_sha256"],
                              "old_apps": old_apps, "spec_sha256": t.sha256(m.wire(spec)), "migration_container": migration["container_id"]})
        fd = os.open(used, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(reservation); stream.flush(); os.fsync(stream.fileno())
        b.sync_directory(state)
        guard()
        with tempfile.TemporaryDirectory(prefix=".start-", dir=state) as tmp:
            # Old API must STILL be drained immediately before Compose replaces
            # it. The post-start inventory guard intentionally allows new writers.
            stage["assert_migrated"]()
            host.replace(Path(tmp), spec)
            def verified_apps(*, final=False, cutover=False):
                result = {}
                for value in guard(final=final, cutover=cutover):
                    role = value["Labels"]["com.docker.compose.service"]
                    b.require(value["Id"] != old_apps[role], "start-not-replaced")
                    detail = host.detail(value["Id"])
                    b.require(detail.get("Id") == value["Id"], "start-container-replaced")
                    result[role] = runtime(detail, role, target_images[role], config["project"], origin, api_secret_file, network_ids, approved["profile"])
                return result
            started = verified_apps()
            host.probe()
            b.require(verified_apps() == started, "start-process-changed")
        guard()
        proof = {"version": 1, "operation_id": operation, "target_sha": target_sha, "approval_sha256": approved["approval_sha256"],
                 "apps": started, "health": {"ready": True, "v1_unauthorized": True, "legacy_unauthorized": True},
                 "traffic_authorized": False, "worker_authorized": False}
        result = {**stage["result"], "startup": proof}
    # The enclosing preparation context performs final authorization/file
    # checks on exit. Never leave success evidence if that finalization fails.
    with b.lock(state):
        with tempfile.TemporaryDirectory(prefix=".start-receipt-", dir=state) as tmp:
            host = host_factory(config, Path(tmp), ingress_directory, origin)
            b.require(verified_apps(final=True) == started, "start-process-changed")
            host.probe()
            b.require(verified_apps(final=True) == started, "start-process-changed")
        # Engine/HTTP reads and cleanup must not outlive an independently
        # revoked/expired approval. This last authorization read does no I/O
        # to Docker or the application.
        b.require(startup_authorization.verify(selected, migration_auth, config, target_sha, origin, images, api_secret_file) == approved, "start-approval-changed")
        if authorization_check is not None: authorization_check()
        b.atomic_json(state / ("start-" + operation + ".success.json"), proof)
        # Only this live owner may continue. A saved startup receipt is evidence,
        # never permission to finish/retry an interrupted release.
        active = True
        owner = (os.getpid(), threading.get_ident())
        def recheck(*, cutover=False):
            nonlocal host
            b.require(active and owner == (os.getpid(), threading.get_ident()), "start-window-inactive")
            with tempfile.TemporaryDirectory(prefix=".finish-health-", dir=state) as tmp:
                host = host_factory(config, Path(tmp), ingress_directory, origin)
                b.require(verified_apps(final=True, cutover=cutover) == started, "start-process-changed")
                host.probe()
                b.require(verified_apps(final=True, cutover=cutover) == started, "start-process-changed")
            if not cutover: check()
        try:
            yield {"result": copy.deepcopy(result), "operation": copy.deepcopy(window._operation), "recheck": recheck}
        finally:
            active = False
