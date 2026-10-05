# Data classification

| Class        | Examples                                    | Repository / logs           |
| ------------ | ------------------------------------------- | --------------------------- |
| Public       | published product copy, public policies     | allowed                     |
| Internal     | ADR, synthetic fixtures, non-secret config  | private repositories only   |
| Confidential | user profile, address, budget, conversation | never in Git; redacted logs |
| Secret       | tokens, credentials, signing keys           | secret store only           |

Collect the minimum fields required for a use case. Define consent, retention,
access, audit, export, and deletion behavior before storing real user data.

R1 inventory and proposed lifecycle are in
[CG-018A](r1-data-policy-proposal.md). The owner accepted 18+ and up to 90 days
of inactivity for profiles, answers, chats and results, with earlier lifecycle
on a deletion request or pilot end. The owner confirmed the individual entrepreneur
named on /legal and stated that no processing notification had been submitted.
Other deadlines/exceptions and notification requirements remain unresolved.
These boundaries are not implemented retention or
permission to process real participants' data.

[CG-018F](../implementation/cg-018-permission-current.md) only reads synthetic
owner-scoped snapshots and tests offline recovery. A historical command receipt
is not current permission or AI admission. Pending checkpoints have no implemented
storage policy, transport or Web/Expo integration; do not persist real user data
through this test harness.
