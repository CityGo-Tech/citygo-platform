# Architecture

CityGo starts as a modular monolith split across independently deployable web
and API applications. Shared contracts live in a small package so both runtime
surfaces agree on validation rules and product terminology.

## Boundaries

```text
apps/web  --->  apps/api  --->  future infrastructure adapters
    \             /
     packages/contracts
```

- The web app owns presentation and browser-side orchestration.
- The API owns use cases, authorization, validation, and integrations.
- Shared packages must not import from applications.
- External providers should be introduced behind API adapters.

## Data safety

Relocation profiles may contain personal and financial information. Production
work must add explicit retention rules, audit trails, encryption, role-based
access, and redaction before real customer data is stored.
