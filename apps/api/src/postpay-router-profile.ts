import type { PostpayAttempt } from "@citygo/db";
import type { StreamingProvider } from "@citygo/llm";

export type PostpayRouterProfile = {
  adapter: StreamingProvider | undefined;
  upstream: string | undefined;
  protocol: PostpayAttempt["protocol"];
  executionKey: string | null;
  policyId: string | null;
};
type RouterChargeReader = StreamingProvider & {
  readCharge: NonNullable<StreamingProvider["readCharge"]>;
};
type AttemptIdentity = Pick<
  PostpayAttempt,
  "model" | "upstream" | "protocol" | "execution_key" | "policy_id"
>;

/** Select only the original server-owned execution/profile identity. This is
 * offline selection: it neither requests a receipt nor accepts a charge, and
 * it never substitutes a protocol from the customer-facing mode name. */
export function selectPostpayRouterAdapter(
  profiles: readonly PostpayRouterProfile[],
  attempt: AttemptIdentity,
): RouterChargeReader | undefined {
  const adapter = profiles.find(
    (profile) =>
      profile.adapter?.name === "routerai" &&
      profile.adapter.model === attempt.model &&
      profile.upstream === attempt.upstream &&
      profile.protocol === attempt.protocol &&
      profile.executionKey === attempt.execution_key &&
      profile.policyId === attempt.policy_id,
  )?.adapter;
  // Preserve the existing first exact-match/no-reader outcome; a duplicate
  // profile is not permission to fall through to another charging adapter.
  return adapter && typeof adapter.readCharge === "function"
    ? (adapter as RouterChargeReader)
    : undefined;
}
