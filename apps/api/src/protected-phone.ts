import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { creditUserIdSchema, russianMobilePhoneSchema } from "@citygo/contracts";

export type ProtectedPhoneBinding = {
  proofUserId: string;
  phoneKey: string;
  sourceChallengeId: string;
};
const envelope =
  /^pc1\.([a-f0-9]{64})\.([a-f0-9]{24})\.((?:[a-f0-9]{2}){9,16})\.([a-f0-9]{32})$/;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// All failures have the same non-sensitive message. Never include a phone,
// envelope, key, OTP, cryptographic cause or decoded value in an error/log.
export class ProtectedPhoneError extends Error {
  readonly code = "PHONE_CONTACT_DATA_ERROR";
  constructor() {
    super("Не удалось прочитать сохранённый контакт");
    this.name = "ProtectedPhoneError";
  }
}

function aad(binding: ProtectedPhoneBinding): Buffer {
  if (
    !creditUserIdSchema.safeParse(binding.proofUserId).success ||
    (binding.phoneKey.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(binding.phoneKey)) ||
    (binding.sourceChallengeId.length !== 36 ||
      !uuid.test(binding.sourceChallengeId))
  )
    throw new ProtectedPhoneError();
  return Buffer.from(
    JSON.stringify([
      "pc1",
      binding.proofUserId,
      binding.phoneKey,
      binding.sourceChallengeId,
    ]),
  );
}

function canonicalPhone(phone: string): string {
  const result = russianMobilePhoneSchema.safeParse(phone);
  if (!result.success || result.data !== phone) throw new ProtectedPhoneError();
  return result.data;
}

// The existing, identity-bound master stays unchanged. HKDF produces an
// independent AES key: neither the HMAC identity key nor any OTP key is used
// directly for encryption. Retain this master in protected configuration and
// its backup; old HMAC-only bindings deliberately cannot be reconstructed.
export function protectedPhoneCodec(identitySecret: string) {
  if (identitySecret.length !== 64 || !/^[a-f0-9]{64}$/.test(identitySecret))
    throw new ProtectedPhoneError();
  const master = Buffer.from(identitySecret, "hex");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      master,
      "citygo-phone-contact-storage-v1",
      "citygo-phone-contact-aes256gcm-v1",
      32,
    ),
  );
  const keyId = createHash("sha256").update(key).digest("hex");
  const matchesIdentity = (phone: string, binding: ProtectedPhoneBinding) => {
    const phoneKey = createHmac("sha256", master)
      .update(JSON.stringify(["phone-identity", phone]))
      .digest("hex");
    if (phoneKey !== binding.phoneKey) throw new ProtectedPhoneError();
  };
  return {
    protect(phone: string, binding: ProtectedPhoneBinding): string {
      try {
        canonicalPhone(phone);
        matchesIdentity(phone, binding);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(aad(binding));
        const ciphertext = Buffer.concat([
          cipher.update(phone, "utf8"),
          cipher.final(),
        ]);
        return [
          "pc1",
          keyId,
          iv.toString("hex"),
          ciphertext.toString("hex"),
          cipher.getAuthTag().toString("hex"),
        ].join(".");
      } catch {
        throw new ProtectedPhoneError();
      }
    },
    reveal(value: string, binding: ProtectedPhoneBinding): string {
      try {
        const match = envelope.exec(value);
        if (!match || match[0] !== value || match[1] !== keyId)
          throw new ProtectedPhoneError();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(match[2]!, "hex"),
        );
        decipher.setAAD(aad(binding));
        decipher.setAuthTag(Buffer.from(match[4]!, "hex"));
        const phone = Buffer.concat([
          decipher.update(Buffer.from(match[3]!, "hex")),
          decipher.final(),
        ]).toString("utf8");
        canonicalPhone(phone);
        matchesIdentity(phone, binding);
        return phone;
      } catch {
        throw new ProtectedPhoneError();
      }
    },
  };
}
