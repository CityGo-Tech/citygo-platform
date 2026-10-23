import assert from "node:assert/strict";
import test from "node:test";
import { isAsciiSenderEmail } from "./sender-email.js";

test("bare sender email accepts conventional mailboxes and canonical ASCII IDNs", () => {
  for (const sender of [
    "no-reply@xn--c1ajazlh.xn--p1ai",
    "no-reply@XN--C1AJAZLH.XN--P1AI",
    "verification@citygo.example",
    "First.Last+tag_1@sub.example.com",
    "o'connor@example.com",
    "sender@xn--bcher-kva.de",
    `${"a".repeat(64)}@example.com`,
    `a@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`,
  ])
    assert.equal(isAsciiSenderEmail(sender), true, sender);
});

test("bare sender email rejects malformed IDNs, bounds violations and header injection", () => {
  for (const sender of [
    undefined,
    null,
    123,
    "",
    "no-reply@ситиго.рф",
    "почта@xn--c1ajazlh.xn--p1ai",
    "sender@xn--a.example",
    "sender@xn--abc.example",
    "sender@xn--0.example",
    "sender@xn--.example",
    "sender@xn--a-ecp.example",
    "sender@xn--c1ajazlh.xn--p1ai.",
    "sender@-example.com",
    "sender@example-.com",
    "sender@sub..example.com",
    "sender@exam_ple.com",
    "sender@localhost",
    "sender@example.c",
    "sender@example.123",
    "sender@[127.0.0.1]",
    "sender@127.0.0.1",
    "sender@%65xample.com",
    "sender@example.com:443",
    "sender@example.com/path",
    `sender@${"a".repeat(64)}.com`,
    `${"a".repeat(65)}@example.com`,
    `a@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
    ".sender@example.com",
    "sender.@example.com",
    "sen..der@example.com",
    "sender@@example.com",
    '"sender"@example.com',
    "CityGo <sender@example.com>",
    "sender@example.com,other@example.com",
    "sender@example.com;Bcc:other@example.com",
    "sender@example.com\r\nBcc: other@example.com",
    "sender@xn--c1ajazlh.xn--p1ai\r\nBcc: other@example.com",
    "sender@example.com\n",
    " sender@example.com",
    "sender@example.com ",
    "sender\t@example.com",
    "sender@example.com\0",
  ])
    assert.equal(isAsciiSenderEmail(sender), false, String(sender));
});
