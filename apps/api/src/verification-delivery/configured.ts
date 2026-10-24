import type { readConfig } from "@citygo/config";
import type { RegistrationEmailDelivery } from "../email-registration.js";
import type { PasswordRecoveryEmailDelivery } from "../password-recovery.js";
import { createPostboxDelivery } from "./postbox.js";
import { createSmsRuDelivery } from "./sms-ru.js";
import { createProstoSmsDelivery } from "./prosto-sms.js";

type Config = ReturnType<typeof readConfig>;
export function configuredPasswordRecoveryDelivery(
  config: Config,
): PasswordRecoveryEmailDelivery | undefined {
  if (config.EMAIL_DELIVERY_PROVIDER !== "yandex_postbox") return undefined;
  const deliver = createPostboxDelivery(
    {
      accessKeyId: config.POSTBOX_ACCESS_KEY_ID!,
      secretAccessKey: config.POSTBOX_SECRET_ACCESS_KEY!,
      fromEmail: config.POSTBOX_FROM_EMAIL!,
    },
    { purpose: "password_recovery" },
  );
  return async (input) => {
    const accepted = await deliver(input);
    if (accepted.accepted !== true)
      throw new Error("Email transport did not accept message");
  };
}
export function configuredEmailDelivery(
  config: Config,
): RegistrationEmailDelivery | undefined {
  if (config.EMAIL_DELIVERY_PROVIDER !== "yandex_postbox") return undefined;
  const deliver = createPostboxDelivery({
    accessKeyId: config.POSTBOX_ACCESS_KEY_ID!,
    secretAccessKey: config.POSTBOX_SECRET_ACCESS_KEY!,
    fromEmail: config.POSTBOX_FROM_EMAIL!,
  });
  return async (input) => {
    const accepted = await deliver(input);
    // Provider acceptance is not delivery and never creates a verified account.
    if (accepted.accepted !== true)
      throw new Error("Email transport did not accept message");
  };
}
export function configuredPhoneDelivery(config: Config) {
  if (
    config.PHONE_VERIFICATION_MODE === "prosto_sms" &&
    config.PROSTOSMS_MODE === "live"
  )
    return createProstoSmsDelivery({
      apiKey: config.PROSTOSMS_API_KEY!,
      from: config.PROSTOSMS_SENDER!,
    }).send;
  if (
    config.PHONE_VERIFICATION_MODE !== "sms_ru" ||
    config.SMS_RU_MODE !== "live"
  )
    return undefined;
  return createSmsRuDelivery({
    mode: "live",
    apiId: config.SMS_RU_API_ID!,
    from: config.SMS_RU_FROM!,
  }).send;
}
