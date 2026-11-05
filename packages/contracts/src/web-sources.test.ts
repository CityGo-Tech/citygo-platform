import assert from "node:assert/strict";
import test from "node:test";
import {
  validateWebSourcesForAnswer,
  webSourcesSchema,
} from "./web-sources.js";

const sources = () => ({
  version: "routerai_native_v1" as const,
  citations: [
    {
      url: "https://example.com/housing?q=1",
      title: "Жильё: актуальные сведения 🏠",
    },
  ],
});

test("bounded native tool sources are canonicalized, deeply copied and tied to nonempty exact answer text", () => {
  const input = sources();
  input.citations[0]!.url = "https://EXAMPLE.com/жильё?q=1";
  const value = validateWebSourcesForAnswer(input, "Ответ с точным текстом 🏠");
  assert.equal(
    value.citations[0]!.url,
    "https://example.com/%D0%B6%D0%B8%D0%BB%D1%8C%D1%91?q=1",
  );
  assert.deepEqual(value, webSourcesSchema.parse(input));
  input.citations[0]!.title = "Подменённый заголовок";
  assert.notEqual(value.citations[0]!.title, input.citations[0]!.title);
  value.citations[0]!.title = "Локальная правка";
  assert.notEqual(value.citations[0]!.title, input.citations[0]!.title);
  assert.doesNotThrow(() =>
    validateWebSourcesForAnswer(sources(), "я".repeat(128_000)),
  );
  for (const answer of ["", " \n\t ", "я".repeat(128_001), "x\0y", "x\ud800"])
    assert.throws(() => validateWebSourcesForAnswer(sources(), answer));
});

test("native source metadata rejects an unrelated format, range guesses and oversized payloads", () => {
  for (const value of [
    { ...sources(), version: "model_markdown" },
    { ...sources(), extra: true },
    { ...sources(), citations: [] },
    {
      ...sources(),
      citations: Array.from({ length: 11 }, () => sources().citations[0]),
    },
    {
      ...sources(),
      citations: [{ ...sources().citations[0], startIndex: 0, endIndex: 5 }],
    },
    { ...sources(), citations: [{ ...sources().citations[0], title: " " }] },
    {
      ...sources(),
      citations: [{ ...sources().citations[0], title: "x".repeat(201) }],
    },
    { ...sources(), citations: [{ ...sources().citations[0], title: "a\nb" }] },
    {
      ...sources(),
      citations: [{ ...sources().citations[0], title: "a\u0085b" }],
    },
    {
      ...sources(),
      citations: [{ ...sources().citations[0], title: "a\ud800b" }],
    },
    {
      ...sources(),
      citations: [
        {
          ...sources().citations[0],
          url: "https://example.com/" + "x".repeat(2048),
        },
      ],
    },
    {
      ...sources(),
      citations: Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/${i}/` + "x".repeat(1800),
        title: "Заголовок",
      })),
    },
  ])
    assert.equal(webSourcesSchema.safeParse(value).success, false);
  const plain = sources();
  plain.citations[0]!.title = '<img src=x onerror="alert(1)">';
  assert.equal(webSourcesSchema.safeParse(plain).success, true);
});

test("only explicit public HTTPS destinations are eligible without any DNS or HTTP lookup", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.com",
    "//example.com",
    "/api/v1/logout",
    "https://user:password@example.com",
    "https://example.com/a b",
    "https://example.com/\\@evil.com",
    "https://example.com/\nfoo",
    "https://example.com/%0d%0afoo",
    "https://example.com/%00foo",
    "https://example.com/\ud800",
    "https://localhost",
    "https://foo.localhost",
    "https://machine.local",
    "https://service.internal",
    "https://service.corp",
    "https://service.intranet",
    "https://secret.test",
    "https://router.home.arpa",
    "https://singlelabel",
    "https://0.0.0.0",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.0.1",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://198.18.0.1",
    "https://192.0.2.1",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.1",
    "https://[::]",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[fe80::1]",
    "https://[fc00::1]",
    "https://[2001:db8::1]",
    "https://[2001:2::1]",
    "https://[2001:20::1]",
    "https://[3fff::1]",
    "https://[2002:7f00:1::]",
  ])
    assert.equal(
      webSourcesSchema.safeParse({
        ...sources(),
        citations: [{ url, title: "Источник" }],
      }).success,
      false,
      url,
    );
  for (const url of [
    "https://example.com",
    "https://пример.рф/путь",
    "https://8.8.8.8",
    "https://[2001:4860:4860::8888]/",
  ])
    assert.equal(
      webSourcesSchema.safeParse({
        ...sources(),
        citations: [{ url, title: "Источник" }],
      }).success,
      true,
      url,
    );
});

test("UTF-8 metadata bounds work without a native TextEncoder global", () => {
  const original = globalThis.TextEncoder;
  try {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const ascii = {
      version: "routerai_native_v1",
      citations: Array.from({ length: 10 }, (_, index) => ({
        url: `https://example.com/${index}/` + "x".repeat(1200),
        title: "x".repeat(200),
      })),
    };
    assert.equal(webSourcesSchema.safeParse(ascii).success, true);
    const cyrillic = {
      ...ascii,
      citations: ascii.citations.map((source) => ({
        ...source,
        title: "я".repeat(200),
      })),
    };
    assert.equal(webSourcesSchema.safeParse(cyrillic).success, false);
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
});
