import { createHash, createHmac } from "node:crypto";

/** Internal SigV4 signer for query-free, already canonical ASCII paths. */
export function signAwsV4(input: {
  method: "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  if (Object.values(input.headers).some((value) => /[\r\n]/.test(value))) {
    throw new Error("Invalid signing input");
  }
  const headers = Object.entries(input.headers)
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const amzDate = headers.find(([name]) => name === "x-amz-date")?.[1];
  if (
    !/^\/[A-Za-z0-9/_-]*$/.test(input.path) ||
    !amzDate ||
    !/^\d{8}T\d{6}Z$/.test(amzDate) ||
    !headers.some(([name]) => name === "host") ||
    new Set(headers.map(([name]) => name)).size !== headers.length ||
    headers.some(
      ([name, value]) => !/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(value),
    )
  ) {
    throw new Error("Invalid signing input");
  }
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalHeaders = headers
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const hash = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    canonicalHeaders,
    signedHeaders,
    hash(input.body),
  ].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hash(canonicalRequest),
  ].join("\n");
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value, "utf8").digest();
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region),
      input.service,
    ),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
