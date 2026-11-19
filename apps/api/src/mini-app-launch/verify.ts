import { createHmac, timingSafeEqual } from "node:crypto";
import { maxLaunchSubject } from "./max.js";
import { telegramLaunchSubject } from "./telegram.js";
import { parseLaunchFields } from "./wire.js";

const payloadValidators = {
  telegram: telegramLaunchSubject,
  max: maxLaunchSubject,
};
const maxLaunchAge = 300;
const maxClockSkew = 30;

export type MiniAppLaunchProvider = keyof typeof payloadValidators;
export type MiniAppLaunchPurpose = "guest" | "housing" | "coordinator";
type MiniAppLaunchProof = {
  provider: MiniAppLaunchProvider;
  subject: string;
  fingerprint: string;
  expiresAt: number;
  purpose: MiniAppLaunchPurpose;
};

export function createMiniAppLaunchVerifier(
  provider: MiniAppLaunchProvider,
  botToken: string,
): (initData: string, nowSeconds?: number) => MiniAppLaunchPurpose | undefined {
  const verify = createMiniAppLaunchProofVerifier(provider, botToken);
  return (initData, nowSeconds) => verify(initData, nowSeconds)?.purpose;
}

export function createMiniAppLaunchProofVerifier(
  provider: MiniAppLaunchProvider,
  botToken: string,
): (initData: string, nowSeconds?: number) => MiniAppLaunchProof | undefined {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();

  return (initData, nowSeconds = Math.floor(Date.now() / 1000)) => {
    const fields = parseLaunchFields(initData);
    const hash = fields?.get("hash");
    const authDate = fields?.get("auth_date");
    if (!fields || !hash || !/^[0-9a-f]{64}$/i.test(hash) || !authDate) return;
    if (!/^[1-9][0-9]{0,11}$/.test(authDate)) return;
    const age = nowSeconds - Number(authDate);
    if (
      !Number.isSafeInteger(nowSeconds) ||
      age > maxLaunchAge ||
      age < -maxClockSkew
    )
      return;

    // Both bot-token schemes exclude only hash. Telegram's separate
    // third-party Ed25519 scheme also excludes signature.
    const signed = [...fields.keys()]
      .filter((key) => key !== "hash")
      .sort()
      .map((key) => `${key}=${fields.get(key)}`)
      .join("\n");
    const expected = createHmac("sha256", secret).update(signed).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return;
    const subject = payloadValidators[provider](fields);
    if (!subject) return;

    const task = fields.get("start_param");
    if (task !== undefined && task !== "housing" && task !== "coordinator")
      return;
    return {
      provider,
      subject,
      fingerprint: expected.toString("hex"),
      expiresAt: Number(authDate) + maxLaunchAge,
      purpose: task ?? "guest",
    };
  };
}
