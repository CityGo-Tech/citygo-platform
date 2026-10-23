import assert from "node:assert/strict";
import test from "node:test";
import { signAwsV4 } from "./signing.js";

// Published AWS SigV4 test vectors, not results computed by our implementation:
// https://github.com/boto/botocore/blob/develop/tests/unit/auth/test_sigv4.py
// https://github.com/boto/botocore/tree/develop/tests/unit/auth/aws4_testsuite/get-vanilla
// https://github.com/boto/botocore/tree/develop/tests/unit/auth/aws4_testsuite/post-x-www-form-urlencoded
// The credentials below are AWS's public, synthetic EXAMPLE credentials.
const base = {
  path: "/",
  headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
  body: "",
  region: "us-east-1",
  service: "service",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

test("SigV4 matches the published AWS GET empty-payload vector", () => {
  assert.equal(
    signAwsV4({ ...base, method: "GET" }),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("SigV4 matches the published AWS POST nonempty-payload vector", () => {
  assert.equal(
    signAwsV4({
      ...base,
      method: "POST",
      headers: {
        ...base.headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "Param1=value1",
    }),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
  );
});

test("SigV4 signs payload bytes and normalizes header order, case and spaces", () => {
  const signature = signAwsV4({ ...base, method: "POST" });
  assert.equal(
    signAwsV4({
      ...base,
      method: "POST",
      headers: {
        "x-amz-date": " 20150830T123600Z ",
        host: "example.amazonaws.com",
      },
    }),
    signature,
  );
  assert.notEqual(
    signAwsV4({ ...base, method: "POST", body: "Код: 012345" }),
    signature,
  );
  assert.notEqual(
    signAwsV4({
      ...base,
      method: "POST",
      region: "ru-central1",
      service: "ses",
    }),
    signature,
  );
});

test("SigV4 refuses noncanonical paths, duplicate headers and header injection", () => {
  for (const input of [
    { ...base, path: "/path?query=1" },
    { ...base, path: "/../path" },
    { ...base, headers: { ...base.headers, host: "example.amazonaws.com" } },
    {
      ...base,
      headers: {
        ...base.headers,
        Host: "example.amazonaws.com\r\nx-extra: injected",
      },
    },
    { ...base, headers: { ...base.headers, "X-Amz-Date": "not-a-date" } },
  ]) {
    assert.throws(() => signAwsV4({ ...input, method: "POST" }), {
      message: "Invalid signing input",
    });
  }
});
