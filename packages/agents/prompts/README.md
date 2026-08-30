# Versioned agent prompts

Each agent receives its own directory and immutable prompt version. A new prompt
is added as `v2.md`; deployed versions are not silently overwritten.

Every prompt must define role, accepted context, allowed tools, structured output,
handoff rules, safety boundaries, and synthetic eval conversations.
