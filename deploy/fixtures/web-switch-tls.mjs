// Self-signed, one-day TLS certificate ONLY for the disposable local fixture.
// Native crypto keeps the rehearsal independent of OpenSSL CLI and downloads.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";

const der = (tag, bytes) => {
  bytes = Buffer.from(bytes);
  let length;
  if (bytes.length < 128) length = Buffer.from([bytes.length]);
  else {
    let hex = bytes.length.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const value = Buffer.from(hex, "hex");
    length = Buffer.concat([Buffer.from([0x80 + value.length]), value]);
  }
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
};
const sequence = (...items) => der(0x30, Buffer.concat(items));
const oid = (hex) => der(0x06, Buffer.from(hex, "hex"));
const pem = (label, bytes) =>
  `-----BEGIN ${label}-----\n${bytes
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END ${label}-----\n`;

export function fixtureCertificate(hostname) {
  assert.equal(hostname, "web-switch.example.test");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const algorithm = sequence(oid("2a864886f70d01010b"), der(0x05, []));
  const name = sequence(
    der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from(hostname)))),
  );
  const date = (value) =>
    der(
      0x17,
      Buffer.from(
        new Date(value)
          .toISOString()
          .replace(/[-:]/g, "")
          .slice(2, 15)
          .replace("T", "") + "Z",
      ),
    );
  const serial = randomBytes(16);
  const serialBytes =
    serial[0] & 0x80 ? Buffer.concat([Buffer.from([0]), serial]) : serial;
  const extensions = sequence(
    sequence(
      oid("551d11"),
      der(0x04, sequence(der(0x82, Buffer.from(hostname)))),
    ),
    sequence(
      oid("551d13"),
      der(0x01, [0xff]),
      der(0x04, sequence(der(0x01, [0xff]))),
    ),
  );
  const body = sequence(
    der(0xa0, der(0x02, [2])),
    der(0x02, serialBytes),
    algorithm,
    name,
    sequence(date(Date.now() - 60000), date(Date.now() + 86400000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, extensions),
  );
  const signed = sequence(
    body,
    algorithm,
    der(
      0x03,
      Buffer.concat([Buffer.from([0]), sign("sha256", body, privateKey)]),
    ),
  );
  const certificate = pem("CERTIFICATE", signed);
  const inspected = new X509Certificate(certificate);
  assert.equal(inspected.verify(publicKey), true);
  assert.equal(inspected.checkHost(hostname), hostname);
  assert.ok(Date.parse(inspected.validFrom) < Date.now());
  assert.ok(Date.parse(inspected.validTo) > Date.now());
  return {
    certificate,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
