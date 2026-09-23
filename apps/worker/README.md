# CityGo Worker

Built TypeScript maintenance job. After pnpm build, pnpm worker:once reads the root
.env and runs against server PostgreSQL only. It removes expired sessions,
marks expired chat leases as interrupted and retains analytics for 90 days.

On Linux, SIGTERM/SIGINT waits for the accepted transaction and DB close. A stop
during connection startup skips maintenance. Repeated signals do not restart the
job or shorten the 60-second shutdown deadline; the Compose worker grace is 90s.
Transaction/connection/close errors and shutdown timeouts exit nonzero, with no
automatic retry or success message. Raw database errors are not logged.

The job is idempotent, but a failed stop is not approval to migrate or retry.
Keep ingress closed and investigate the stored container exit evidence first.
This does not disable external schedulers or coordinate concurrent invocations:
the future deployment controller still needs a shared lock/admission barrier.
An opt-in Linux operator wrapper now coordinates managed Worker/backup runs;
see [worker-coordination](../../docs/runbooks/worker-coordination.md). Direct
developer/Compose launches bypass it; no server schedule has been migrated.
No schedule is installed or enabled. The job does not send notifications,
scrape sources, contact realtors or call AI providers.
