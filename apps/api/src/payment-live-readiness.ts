import { parsePaymentFiscalProfile } from "@citygo/contracts";

// Operator-only preparation report. This is not a runtime approval, an API
// endpoint, a provider authentication check, or a tax/legal compliance check.
// Keep real launch capabilities bound to implemented code, never to booleans
// submitted by a client or to the presence of a secret key.
const implementationGaps = [
  {
    code: "LIVE_CHECKOUT_NOT_IMPLEMENTED",
    message: "В runtime поддерживаются только disabled и test, не live.",
  },
  {
    code: "PAID_SOURCE_ALLOCATION_NOT_IMPLEMENTED",
    message: "Нужны оплаченные лоты и распределение AI-резервов по источникам.",
  },
  {
    code: "REFUND_LEDGER_NOT_IMPLEMENTED",
    message:
      "Нужны резерв возврата, проводки и обработка неизвестного результата.",
  },
  {
    code: "FISCAL_TRACKING_NOT_IMPLEMENTED",
    message:
      "Нужны отдельный журнал статусов чеков и утверждённый порядок их выдачи.",
  },
  {
    code: "BACKGROUND_RECONCILIATION_NOT_IMPLEMENTED",
    message:
      "Нужны долговечные уведомления и сверка платежей/возвратов после начисления.",
  },
  {
    code: "LIVE_RELEASE_PROFILE_NOT_IMPLEMENTED",
    message: "Нужен проверенный production-профиль оплаты и тарифа CityGo ×10.",
  },
] as const;

export const paymentSourcePolicies = [
  "gift_first_paid_fifo",
  "paid_fifo_first_gift_after",
] as const;

export const operatorTaxRegimes = ["npd", "non_npd", "unknown"] as const;
export type OperatorTaxRegime = (typeof operatorTaxRegimes)[number];

export function inspectLivePaymentPreparation(
  input: {
    fiscalProfile?: unknown;
    sourcePolicy?: unknown;
    merchantReceiptsReportedEnabled?: boolean;
    operatorTaxRegime?: unknown;
  } = {},
) {
  const checks: { code: string; message: string }[] = [];
  const operatorTaxRegime: OperatorTaxRegime =
    input.operatorTaxRegime === "npd" || input.operatorTaxRegime === "non_npd"
      ? input.operatorTaxRegime
      : "unknown";
  let fiscalProfileTechnicallyValid = false;
  if (operatorTaxRegime === "npd") {
    checks.push({
      code: "NPD_FISCAL_FLOW_NOT_IMPLEMENTED",
      message:
        "Для НПД нужен отдельный согласованный сценарий чеков. Профиль 54-ФЗ и его налоговые коды не заменяют чек НПД.",
    });
  } else if (operatorTaxRegime === "unknown") {
    checks.push({
      code: "OPERATOR_TAX_REGIME_REQUIRED",
      message:
        "Сначала нужно подтвердить налоговый режим оператора. Он не выводится из кода налога, ключа или настроек магазина.",
    });
  } else {
    try {
      const profile = parsePaymentFiscalProfile(input.fiscalProfile);
      // The current product is a balance for future, variably priced requests.
      // Changing that product to a defined-service bundle needs a separate decision.
      if (profile.businessModel !== "wallet_advance") {
        checks.push({
          code: "PRODUCT_FISCAL_MODEL_MISMATCH",
          message:
            "Фискальный профиль должен соответствовать текущему балансу CityGo, не другой модели продажи.",
        });
      } else fiscalProfileTechnicallyValid = true;
    } catch {
      checks.push({
        code: "FISCAL_PROFILE_REQUIRED",
        message:
          "Нужен явно согласованный фискальный профиль; налоговые значения не выбираются автоматически.",
      });
    }
  }
  if (!paymentSourcePolicies.some((policy) => policy === input.sourcePolicy)) {
    checks.push({
      code: "SOURCE_POLICY_REQUIRED",
      message:
        "Владелец должен утвердить порядок расходования подарочных и оплаченных средств.",
    });
  }
  if (input.merchantReceiptsReportedEnabled !== true) {
    checks.push({
      code: "MERCHANT_RECEIPTS_NOT_CONFIRMED",
      message:
        "Нужно подтвердить способ выдачи чеков; настройка магазина не подтверждает формирование конкретного чека.",
    });
  }
  return {
    kind: "citygo-live-payment-preparation" as const,
    schemaVersion: 1 as const,
    operatorTaxRegime,
    activationSupported: false as const,
    readyForLive: false as const,
    fiscalProfileTechnicallyValid,
    taxComplianceConfirmed: false as const,
    credentialsChecked: false as const,
    blockers: [...checks, ...implementationGaps.map((gap) => ({ ...gap }))],
  };
}
