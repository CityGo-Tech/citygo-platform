import { z } from "zod";

const maximumSourcesBytes = 16 * 1024;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const privateNames = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "test",
  "invalid",
  "example",
  "onion",
  "home.arpa",
  "corp",
  "intranet",
  "private",
];

function hasControl(value: string) {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

// Pure JS so the shared schema does not require TextEncoder in native Hermes.
function utf8Bytes(value: string) {
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function publicIpv4(host: string) {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Text-only validation. It never resolves DNS or requests the destination. */
function publicWebUrl(value: string): string | null {
  if (
    !/^https:\/\//i.test(value) ||
    /[\s\\]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|c2%(?:8|9)[0-9a-f])/i.test(value) ||
    hasControl(value) ||
    invalidUnicode.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.href.length > 2048
    )
      return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[")) {
      // Only global unicast IPv6; loopback, mapped IPv4, link-local and multicast
      // are outside this range. Documentation/transition ranges are not sources.
      const address = host.slice(1, -1);
      const second = Number.parseInt(address.split(":")[1] || "0", 16);
      if (
        !/^[23][0-9a-f]{3}:/i.test(address) ||
        (/^2001:/i.test(address) && (second < 0x200 || second === 0xdb8)) ||
        /^2002:/i.test(address) ||
        /^3fff:/i.test(address)
      )
        return null;
    } else if (/^[0-9.]+$/.test(host)) {
      if (!publicIpv4(host)) return null;
    } else if (
      host.length > 253 ||
      !host.includes(".") ||
      privateNames.some((name) => host === name || host.endsWith("." + name)) ||
      host
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const webSourceSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (value) => publicWebUrl(value) !== null,
      "Source requires an absolute public HTTPS URL",
    )
    .transform((value) => publicWebUrl(value)!),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        Boolean(value.trim()) &&
        !hasControl(value) &&
        !invalidUnicode.test(value),
      "Source requires a plain text title",
    ),
});

export const webSourcesSchema = z
  .strictObject({
    version: z.literal("routerai_native_v1"),
    citations: z.array(webSourceSchema).min(1).max(10),
  })
  .refine(
    (value) => utf8Bytes(JSON.stringify(value)) <= maximumSourcesBytes,
    "Sources exceed the metadata byte limit",
  );
export type WebSources = z.infer<typeof webSourcesSchema>;

/** Bind server-owned tool metadata to an exact completed answer, never parse
 * source claims from model Markdown or a user-supplied message. */
export function validateWebSourcesForAnswer(
  sources: unknown,
  text: string,
): WebSources {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 128_000 ||
    text.includes("\0") ||
    invalidUnicode.test(text)
  )
    throw new Error("Sources require a nonempty completed answer");
  const value = webSourcesSchema.parse(sources);
  return {
    version: value.version,
    citations: value.citations.map((source) => ({ ...source })),
  };
}
