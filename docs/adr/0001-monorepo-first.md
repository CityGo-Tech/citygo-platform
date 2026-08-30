# ADR 0001: Monorepo-first product development

- Status: accepted
- Date: 2026-08-30

## Context

Web, mobile, API, agents, domain rules, and design tokens share contracts and
must evolve together during MVP discovery. Separate repositories would add
coordination and release overhead before independent teams exist.

## Decision

Keep product code in `citygo-platform` with pnpm workspaces and Turborepo.
Create a separate repository only for an independent lifecycle, access boundary,
or platform constraint documented in a new ADR.

## Consequences

Cross-surface changes can be verified atomically. Package boundaries remain
explicit, and CI cost must be managed with task caching and affected builds.
