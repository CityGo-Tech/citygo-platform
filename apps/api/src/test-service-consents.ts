// Explicit synthetic choices for isolated API fixtures; never used by runtime.
import { serviceConsentPolicy } from "@citygo/contracts";
import { Repository, ServiceConsents, type Database } from "@citygo/db";
export const syntheticServiceConsents = {
  policyVersion: serviceConsentPolicy.version,
  personalData: true as const,
  marketing: false,
};
export async function registerSyntheticConsentingUser(
  db: Database,
  email: string,
  passwordHash: string,
) {
  const id = await new Repository(db).register(email, passwordHash);
  await new ServiceConsents(db).choose(id, syntheticServiceConsents);
  return id;
}
