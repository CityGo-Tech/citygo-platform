import { domainToASCII, domainToUnicode } from "node:url";

// Preserve the existing ASCII local-part policy; do not accept quoted mailboxes,
// display names, recipient lists, whitespace, or header syntax.
const LOCAL_PART = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One bare ASCII sender mailbox, including canonical IDN A-label domains. */
export function isAsciiSenderEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    !LOCAL_PART.test(local) ||
    !domain ||
    domain.length > 253
  )
    return false;
  const normalized = domain.toLowerCase();
  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label)))
    return false;
  const topLevel = labels.at(-1)!;
  if (!/^[a-z]{2,}$/.test(topLevel) && !topLevel.startsWith("xn--"))
    return false;
  // Node's IDNA conversion rejects malformed A-labels. Requiring a round trip
  // also rejects inputs that are silently repaired, normalized, or not Punycode.
  if (domainToASCII(normalized) !== normalized) return false;
  for (const label of labels) {
    if (!label.startsWith("xn--")) continue;
    const unicode = domainToUnicode(label);
    if (!unicode || unicode === label || domainToASCII(unicode) !== label)
      return false;
  }
  return domainToASCII(domainToUnicode(normalized)) === normalized;
}
