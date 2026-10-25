// Explicit synthetic choices for isolated API fixtures; never used by runtime.
import {
  serviceConsentPolicy,
  registrationPolicyResponseSchema,
  CONTRACT_VERSION_HEADER,
} from "@citygo/contracts";
import type { FastifyInstance } from "fastify";
import { Repository, ServiceConsents, type Database } from "@citygo/db";
export const syntheticServiceConsents = {
  policyVersion: serviceConsentPolicy.version,
  personalData: true as const,
  marketing: false,
};
/** Test fixtures must explicitly accept the exact policy exposed by this app. */
async function syntheticRegistrationPolicy(app: FastifyInstance) {
  const response = await app.inject({
    url: "/v1/auth/registration-policy",
    headers: { [CONTRACT_VERSION_HEADER]: "1" },
  });
  if (response.statusCode !== 200)
    throw new Error(
      "Synthetic registration policy is unavailable: " + response.statusCode,
    );
  return registrationPolicyResponseSchema.parse(response.json()).consentPolicy;
}
export async function syntheticConsentsFor(app: FastifyInstance) {
  const policy = await syntheticRegistrationPolicy(app);
  return {
    policyVersion: policy.version,
    personalData: true as const,
    marketing: false,
  };
}
/** Explicit synthetic reacceptance after a test changes the recipient/routing. */
export async function acceptSyntheticServiceConsents(
  app: FastifyInstance,
  token: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/account/consents",
    headers: {
      [CONTRACT_VERSION_HEADER]: "1",
      "x-citygo-client": "native",
      authorization: "Bearer " + token,
    },
    payload: await syntheticConsentsFor(app),
  });
  if (response.statusCode !== 200)
    throw new Error(
      "Synthetic service consent was not accepted: " +
        response.statusCode +
        " " +
        response.body,
    );
}
/** Direct DB fixtures bind the exact public snapshot without provider calls. */
export async function chooseSyntheticServiceConsents(
  db: Database,
  id: string,
  app?: FastifyInstance,
) {
  const policy = app
    ? await syntheticRegistrationPolicy(app)
    : serviceConsentPolicy;
  const ai = policy.aiProcessing;
  const store = new ServiceConsents(
    db,
    app
      ? (routing) =>
          ai && routing.provider === ai.provider && routing.policyId === ai.id
            ? ai
            : null
      : undefined,
  );
  await store.choose(id, {
    policyVersion: policy.version,
    personalData: true,
    marketing: false,
  });
}
export async function registerSyntheticConsentingUser(
  db: Database,
  email: string,
  passwordHash: string,
  app?: FastifyInstance,
) {
  const id = await new Repository(db).register(email, passwordHash);
  await chooseSyntheticServiceConsents(db, id, app);
  return id;
}
