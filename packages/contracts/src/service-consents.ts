import { z } from "zod";
import { registrationCredentialsSchema } from "./platform.js";

const documentSchema = z.strictObject({
  label: z.string().min(1).max(500),
  text: z.string().min(1).max(30000),
  url: z.string().regex(/^\/legal\/[a-z-]+$/),
  required: z.boolean(),
});
export const serviceConsentPolicySchema = z.strictObject({
  version: z.string().min(1).max(80),
  personalData: documentSchema.extend({
    url: z.literal("/legal/personal-data-consent"),
    required: z.literal(true),
  }),
  marketing: documentSchema.extend({
    url: z.literal("/legal/marketing-consent"),
    required: z.literal(false),
  }),
});
export type ServiceConsentPolicy = z.infer<typeof serviceConsentPolicySchema>;

// Published versions are immutable. Change the version whenever any document
// or label changes; evidence stores this exact server-owned policy snapshot.
export const serviceConsentPolicy: ServiceConsentPolicy = Object.freeze({
  version: "2026-10-25-v1",
  personalData: Object.freeze({
    label: "Даю согласие на обработку персональных данных",
    text: [
      "Согласие на обработку персональных данных для регистрации и использования CityGo. Редакция от 25 октября 2026 года.",
      "Я свободно, своей волей и в своём интересе даю ИП Сурикову Дмитрию Андреевичу (ИНН 594900635347, ОГРНИП 325774600760885) согласие на обработку моих персональных данных в сервисе CityGo. Контакт оператора: citygo.rf@gmail.com.",
      "Цели обработки: регистрация и ведение аккаунта, предоставление функций CityGo и рекомендаций по переезду, сохранение моих материалов, учёт оплат и использования баланса, обеспечение безопасности, отправка кодов подтверждения и служебных уведомлений, ответы на мои обращения.",
      "Данные: электронная почта, логин и защищённые сведения для входа; идентификаторы аккаунта и сессий; сведения о моих согласиях и подтверждениях; сообщения, история диалогов, избранное, личный план и сведения о переезде, которые я сообщаю; сведения об операциях баланса и оплаты без реквизитов банковской карты; необходимые технические сведения о работе с сервисом. Номер телефона и сведения о его подтверждении обрабатываются, если я решу привязать его к аккаунту.",
      "Разрешённые действия: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, блокирование, удаление и уничтожение с использованием средств автоматизации и без них.",
      "Согласие действует до достижения перечисленных целей либо его отзыва. Отозвать согласие и направить запрос о данных можно на citygo.rf@gmail.com. После отзыва обработка на основании согласия прекращается; сведения, необходимые по самостоятельному законному основанию, могут сохраняться в предусмотренном законом объёме.",
      "Для регистрации и использования CityGo необходимо это согласие. Передача сообщений внешним ИИ-сервисам и передача номера для подтверждения по SMS требуют отдельных действий и согласий. Это согласие не заменяет их и не разрешает рекламные рассылки.",
    ].join("\n\n"),
    url: "/legal/personal-data-consent",
    required: true,
  }),
  marketing: Object.freeze({
    label: "Хочу получать новости и рекламу CityGo по email",
    text: [
      "Согласие на рекламную рассылку CityGo. Редакция от 25 октября 2026 года.",
      "Я добровольно соглашаюсь получать от ИП Сурикова Дмитрия Андреевича (ИНН 594900635347, ОГРНИП 325774600760885) новости, предложения и рекламу CityGo на электронную почту, указанную в моём аккаунте. Контакт оператора: citygo.rf@gmail.com.",
      "Для этой цели разрешаю обработку адреса электронной почты, идентификатора аккаунта и сведений о предоставлении и отзыве согласия: сбор, запись, систематизацию, хранение, уточнение, использование для рассылки, блокирование, удаление и уничтожение с использованием средств автоматизации и без них.",
      "Согласие действует до отзыва. Отказаться от рассылки можно в настройках согласий аккаунта или обращением на citygo.rf@gmail.com. После отзыва рекламные отправки на основании этого согласия прекращаются.",
      "Согласие добровольное. Отказ или отзыв не мешает регистрации и использованию CityGo. Оно не распространяется на рекламные SMS, звонки, мессенджеры и рекламу партнёров. Необходимые служебные сообщения, включая коды подтверждения, уведомления безопасности и документы по оплате, не являются этой рекламной рассылкой.",
    ].join("\n\n"),
    url: "/legal/marketing-consent",
    required: false,
  }),
});
export const serviceConsentChoiceSchema = z.strictObject({
  policyVersion: z.string().min(1).max(80),
  personalData: z.literal(true),
  marketing: z.boolean(),
});
export type ServiceConsentChoice = z.infer<typeof serviceConsentChoiceSchema>;
export const registrationWithConsentsSchema =
  registrationCredentialsSchema.extend({
    consents: serviceConsentChoiceSchema,
  });
export const serviceConsentStateSchema = z.strictObject({
  policy: serviceConsentPolicySchema,
  personalDataGranted: z.boolean(),
  marketingGranted: z.boolean(),
  serviceConsentRequired: z.boolean(),
});
export type ServiceConsentState = z.infer<typeof serviceConsentStateSchema>;
