import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createMiniAppLaunchVerifier } from "./verify.js";

const now = 1_777_777_777;
const botTokens = {
  telegram: "synthetic-telegram-test-token",
  max: "synthetic-max-test-token",
};
const queryId = "63b0ec7a-6afc-44f3-a2c5-52ebfd83c53a";
const commonFields = {
  user: '{"id":42}',
  query_id: queryId,
  auth_date: String(now),
};

type Provider = keyof typeof botTokens;

function signedInitData(provider: Provider, fields: Record<string, string>) {
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData")
    .update(botTokens[provider])
    .digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return Object.entries({ ...fields, hash })
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
}

// Independent known answers produced with Python hmac using synthetic secrets.
const telegramVector = [
  "user=%7B%22first_name%22%3A%22Fixture%20%2B%20A%22%2C%22id%22%3A4503599627370495%7D",
  "start_param=housing",
  "auth_date=1777777777",
  "signature=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "query_id=synthetic-query",
  "hash=7c9d03689226a1edc92bbec4d1e505d31c570ca0d6d934464799c479cb119010",
].join("&");
const maxVector = [
  "user=%7B%22id%22%3A9223372036854775807%2C%22first_name%22%3A%22Synthetic%22%2C%22photo_url%22%3Anull%7D",
  "chat=%7B%22id%22%3A42%2C%22type%22%3A%22DIALOG%22%7D",
  `query_id=${queryId}`,
  "start_param=coordinator",
  "auth_date=1777777777",
  "hash=42c63b6395c1752f86f94849a453106b880db934af4a0392596d6ab161b0489c",
].join("&");

const verifyTelegram = createMiniAppLaunchVerifier(
  "telegram",
  botTokens.telegram,
);
const verifyMax = createMiniAppLaunchVerifier("max", botTokens.max);

test("Telegram HMAC authenticates the signature field and original decoded strings", () => {
  assert.equal(verifyTelegram(telegramVector, now), "housing");
  assert.equal(
    verifyTelegram(telegramVector.split("&").reverse().join("&"), now),
    "housing",
  );
  assert.equal(
    verifyTelegram(telegramVector.replaceAll("%20", "+"), now),
    "housing",
  );
  assert.equal(
    verifyTelegram(telegramVector.replace(/&signature=[^&]+/, ""), now),
    undefined,
  );
  assert.equal(
    verifyTelegram(
      telegramVector.replace("start_param=housing", "start_param=coordinator"),
      now,
    ),
    undefined,
  );
});

test("MAX authenticates original JSON with a full positive int64 identity", () => {
  assert.equal(verifyMax(maxVector, now), "coordinator");
  assert.equal(
    verifyMax(
      signedInitData("max", {
        ...commonFields,
        user: '{"id":9223372036854775808}',
      }),
      now,
    ),
    undefined,
  );
});

test("Telegram permits a launch without query_id and MAX requires a nonblank query_id", () => {
  const withoutQueryId = { auth_date: String(now), user: '{"id":42}' };
  assert.equal(
    verifyTelegram(signedInitData("telegram", withoutQueryId), now),
    "guest",
  );
  assert.equal(
    verifyMax(signedInitData("max", withoutQueryId), now),
    undefined,
  );
  assert.equal(
    verifyMax(signedInitData("max", { ...commonFields, query_id: " " }), now),
    undefined,
  );
});

test("Telegram and MAX verify only data signed with the configured provider token", () => {
  const telegram = signedInitData("telegram", commonFields);
  const max = signedInitData("max", commonFields);
  assert.equal(verifyTelegram(telegram, now), "guest");
  assert.equal(verifyMax(max, now), "guest");
  assert.equal(verifyMax(telegram, now), undefined);
  assert.equal(verifyTelegram(max, now), undefined);
});

for (const provider of ["telegram", "max"] as const) {
  const verifier = createMiniAppLaunchVerifier(provider, botTokens[provider]);

  test(`${provider}: read-only verification is repeatable within the freshness window`, () => {
    const proof = signedInitData(provider, commonFields);
    assert.equal(verifier(proof, now), "guest");
    assert.equal(verifier(proof, now + 1), "guest");
    assert.equal(verifier(proof, now + 300), "guest");
    assert.equal(verifier(proof, now + 301), undefined);
    assert.equal(verifier(proof, now - 30), "guest");
    assert.equal(verifier(proof, now - 31), undefined);
  });

  test(`${provider}: rejects malformed times and unrecognized signed tasks`, () => {
    for (const authDate of [`0${now}`, `${now}.0`, `${now}000`, "1e9"]) {
      assert.equal(
        verifier(
          signedInitData(provider, { ...commonFields, auth_date: authDate }),
          now,
        ),
        undefined,
      );
    }
    for (const startParam of ["", "register"]) {
      assert.equal(
        verifier(
          signedInitData(provider, {
            ...commonFields,
            start_param: startParam,
          }),
          now,
        ),
        undefined,
      );
    }
  });

  test(`${provider}: rejects duplicates and malformed percent encoding before interpretation`, () => {
    const proof = signedInitData(provider, {
      ...commonFields,
      user: '{"id":42,"first_name":"Sample %"}',
      start_param: "housing",
    });
    assert.equal(verifier(proof, now), "housing");
    const hash = new URLSearchParams(proof).get("hash");
    for (const malformed of [
      `${proof}&hash=${hash}`,
      `${proof}&auth%5fdate=${now}`,
      `${proof}&start_param=housing`,
      proof.replace("%25", "%"),
      proof.replace("%25", "%C0%AF"),
      `?${proof}`,
      `${proof}&`,
      signedInitData(provider, {
        ...commonFields,
        future_field: "line\nbreak",
      }),
    ]) {
      assert.equal(verifier(malformed, now), undefined);
    }
  });

  test(`${provider}: rejects wire and field-count overflow even with a valid HMAC`, () => {
    const minimalProof = signedInitData(provider, {
      ...commonFields,
      user: '{"id":42,"first_name":""}',
    });
    const filler = "x".repeat(8192 - Buffer.byteLength(minimalProof));
    const padded = (firstName: string) =>
      signedInitData(provider, {
        ...commonFields,
        user: JSON.stringify({ id: 42, first_name: firstName }),
      });
    const atLimit = padded(filler);
    assert.equal(Buffer.byteLength(atLimit), 8192);
    assert.equal(verifier(atLimit, now), "guest");
    assert.equal(verifier(padded(filler + "x"), now), undefined);
    const extras = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`extra_${index}`, "x"]),
      );
    // Three required fixture fields and the hash use four of the slots.
    const maxFields = signedInitData(provider, {
      ...commonFields,
      ...extras(28),
    });
    assert.equal(verifier(maxFields, now), "guest");
    assert.equal(
      verifier(maxFields.replace("extra_27=x", "extra_27=y"), now),
      undefined,
    );
    assert.equal(
      verifier(
        signedInitData(provider, { ...commonFields, ...extras(29) }),
        now,
      ),
      undefined,
    );
  });

  test(`${provider}: rejects a signed user object with an ambiguous or invalid ID`, () => {
    for (const user of [
      '{"id":42,"id":42}',
      '{"id":42,"\\u0069d":42}',
      '{"id":42,"first_name":"Fixture","first_name":"Fixture"}',
      '{"id":"42"}',
      '{"id":42.0}',
      '{"id":4.2e1}',
      '{"id":0}',
      '{"id":-42}',
      '{"first_name":"Fixture"}',
      '{"id":42',
      "[42]",
    ]) {
      assert.equal(
        verifier(signedInitData(provider, { ...commonFields, user }), now),
        undefined,
      );
    }
  });
}

test("Telegram rejects user IDs above its documented 52-bit ceiling", () => {
  assert.equal(
    verifyTelegram(
      signedInitData("telegram", {
        ...commonFields,
        user: '{"id":4503599627370496}',
      }),
      now,
    ),
    undefined,
  );
});
