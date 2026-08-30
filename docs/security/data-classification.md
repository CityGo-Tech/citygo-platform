# Data classification

| Class | Examples | Repository / logs |
|---|---|---|
| Public | published product copy, public policies | allowed |
| Internal | ADR, synthetic fixtures, non-secret config | private repositories only |
| Confidential | user profile, address, budget, conversation | never in Git; redacted logs |
| Secret | tokens, credentials, signing keys | secret store only |

Collect the minimum fields required for a use case. Define consent, retention,
access, audit, export, and deletion behavior before storing real user data.
