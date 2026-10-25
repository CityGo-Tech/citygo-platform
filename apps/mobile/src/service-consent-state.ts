import type {
  ServiceConsentChoice,
  ServiceConsentPolicy,
} from "@citygo/contracts";

export type ServiceConsentScope = {
  context: string;
  signal: AbortSignal;
};
export type ServiceConsentForm = ServiceConsentScope & {
  policy: ServiceConsentPolicy;
  personalData: boolean;
  marketing: boolean;
};

export function createServiceConsentForm(
  policy: ServiceConsentPolicy,
  scope: ServiceConsentScope,
): ServiceConsentForm {
  return { ...scope, policy, personalData: false, marketing: false };
}

export function currentServiceConsentForm(
  form: ServiceConsentForm | null,
  scope: ServiceConsentScope | null,
): ServiceConsentForm | null {
  return form &&
    scope &&
    !scope.signal.aborted &&
    form.signal === scope.signal &&
    form.context === scope.context
    ? form
    : null;
}

export function changeServiceConsent(
  form: ServiceConsentForm,
  purpose: "personalData" | "marketing",
  granted: boolean,
): ServiceConsentForm {
  return { ...form, [purpose]: granted };
}

export function serviceConsentChoice(
  form: ServiceConsentForm | null,
  scope: ServiceConsentScope | null,
): ServiceConsentChoice | null {
  const current = currentServiceConsentForm(form, scope);
  return current?.personalData
    ? {
        policyVersion: current.policy.version,
        personalData: true,
        marketing: current.marketing,
      }
    : null;
}

/** Registration must submit the exact version the person read and selected. */
export function registrationConsentMatchesPolicy(
  choice: ServiceConsentChoice | undefined,
  policy: ServiceConsentPolicy,
): boolean {
  return (
    choice?.personalData === true && choice.policyVersion === policy.version
  );
}
