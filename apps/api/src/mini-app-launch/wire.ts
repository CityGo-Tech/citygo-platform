export const miniAppLaunchMaxBytes = 8 * 1024;
const launchMaxFields = 32;

function decodeFormPart(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function parseLaunchFields(
  initData: string,
): Map<string, string> | undefined {
  if (!initData || Buffer.byteLength(initData, "utf8") > miniAppLaunchMaxBytes)
    return;
  const pairs = initData.split("&");
  if (pairs.length > launchMaxFields) return;

  const fields = new Map<string, string>();
  try {
    for (const pair of pairs) {
      const separator = pair.indexOf("=");
      if (separator < 1) return;
      const key = decodeFormPart(pair.slice(0, separator));
      const value = decodeFormPart(pair.slice(separator + 1));
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
        fields.has(key) ||
        hasControlCharacter(value)
      )
        return;
      fields.set(key, value);
    }
  } catch {
    // Decoding errors can contain input. Always return the same rejection.
    return;
  }
  return fields;
}

export function launchUserId(
  raw: string | undefined,
  maxId: bigint,
): string | undefined {
  if (raw === undefined) return;
  try {
    const user: unknown = JSON.parse(
      raw,
      (key: string, value: unknown, context?: { source?: string }) => {
        // Node 24 exposes the exact number lexeme before binary rounding.
        if (
          key === "id" &&
          typeof value === "number" &&
          context?.source &&
          /^[1-9][0-9]{0,18}$/.test(context.source)
        )
          return BigInt(context.source);
        return value;
      },
    );
    if (
      !user ||
      typeof user !== "object" ||
      Array.isArray(user) ||
      !Object.hasOwn(user, "id") ||
      !("id" in user) ||
      typeof user.id !== "bigint" ||
      user.id > maxId ||
      Object.values(user).some((value) => value && typeof value === "object")
    )
      return;

    // The documented user objects are flat. After the JSON grammar check,
    // a complete JSON string token followed by a colon is a property name.
    const keys = new Set<string>();
    for (const match of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      if (!/^\s*:/.test(raw.slice(match.index + match[0].length))) continue;
      const key: string = JSON.parse(match[0]);
      if (keys.has(key)) return;
      keys.add(key);
    }
    return user.id.toString();
  } catch {
    return;
  }
}

export function validLaunchQueryId(id: string): boolean {
  return id.length <= 256 && id.trim().length > 0;
}
