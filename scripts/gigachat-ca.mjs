import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";

// Public CA from the official GigaChat certificate instructions. It is bundled
// only in the API image and used only by the existing scoped HTTPS transport.
export const gigaChatCaSourcePath =
  "deploy/certificates/russian-trusted-root.crt";
export const gigaChatCaImagePath = "/app/certs/russian-trusted-root.crt";
export const gigaChatCaSha256 =
  "aa800ef345422d6158c6fafe1c06c429dbda21c3df4bb1ccb45a920ec1111399";
export const gigaChatCaFingerprint =
  "D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31";

export function assertGigaChatCa(bytes, now = Date.now()) {
  try {
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.length, 2057);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      gigaChatCaSha256,
    );
    const certificate = new X509Certificate(bytes);
    assert.equal(certificate.ca, true);
    assert.equal(certificate.verify(certificate.publicKey), true);
    assert.equal(certificate.fingerprint256, gigaChatCaFingerprint);
    assert.ok(Number.isFinite(now));
    assert.ok(Date.parse(certificate.validFrom) <= now);
    assert.ok(now < Date.parse(certificate.validTo));
  } catch {
    throw new Error("Invalid bundled GigaChat public CA (contents hidden)");
  }
}
