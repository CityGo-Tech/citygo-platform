# Database

@citygo/db exports connectDatabase, migrate, Repository and DomainError.
PostgreSQL server uses a bounded pg Pool with query/idle-transaction timeouts.
PGlite is the single-process local/test adapter.

Migration 0001 is preserved. 0002 adds credentials, hashed sessions, stream leases,
deduplication and analytics. Applied files are immutable and checksum-checked.
Use pnpm db:migrate from the root.

Repository scopes customer operations to the authenticated user. Quest completion
locks the owned quest, returns zero for a replay, writes a deterministic ledger
key and unlocks the next quest within one transaction. A partial unique index
prevents duplicate completion rewards. AI calls run outside SQL transactions.

CI uses a PostgreSQL service and isolated test schemas. Local tests use PGlite.
Do not point TEST_DATABASE_URL at production.
