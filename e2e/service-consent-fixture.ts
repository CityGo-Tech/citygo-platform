import type { ServiceConsentPolicy } from "@citygo/contracts";
import { serviceConsentPolicy } from "../packages/contracts/src/service-consents";

export const syntheticConsentPolicy: ServiceConsentPolicy = {
  version: "synthetic-consents-v1",
  personalData: {
    label: serviceConsentPolicy.personalData.label,
    text: "Synthetic personal data consent for browser tests.",
    url: "/legal/personal-data-consent",
    required: true,
  },
  marketing: {
    label: serviceConsentPolicy.marketing.label,
    text: "Synthetic optional marketing consent for browser tests.",
    url: "/legal/marketing-consent",
    required: false,
  },
};
export const syntheticConsents = {
  policyVersion: syntheticConsentPolicy.version,
  personalData: true,
  marketing: false,
};
