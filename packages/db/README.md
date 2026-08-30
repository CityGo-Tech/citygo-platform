# Database

PostgreSQL migrations for the CityGo product model.

Migrations are append-only after deployment. Application code should award XP
with `INSERT ... ON CONFLICT DO NOTHING` against `(user_id, event_key)` so a
replayed quest-completion command cannot award points twice.
