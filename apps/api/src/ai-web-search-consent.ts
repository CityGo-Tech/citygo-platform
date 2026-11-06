/**
 * Reviewed v2 changes only source-selection instructions and the trusted request
 * date. Recipients, search disclosure and data scope stay exactly the same.
 * Preserve their existing v1 consent identity; execution still hashes the actual
 * v2 profile and must receive a separate operator budget approval.
 *
 * This is an explicit compatibility pair, not a rule for future instructions.
 * Other profile fields and unknown instruction versions remain in the consent
 * hash unchanged so that new processing still needs a new explicit choice.
 */
export function webSearchConsentProfile<
  T extends { instructionsProfile: string },
>(
  profile: T,
): Omit<T, "instructionsProfile"> & { instructionsProfile: string } {
  if (
    profile.instructionsProfile !== "routerai-native-web-search-instructions-v2"
  )
    return profile;
  return {
    ...profile,
    instructionsProfile: "routerai-native-web-search-instructions-v1",
  };
}
