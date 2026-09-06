# CityGo Worker

Built TypeScript maintenance job. After pnpm build, pnpm worker:once reads the root
.env and runs against server PostgreSQL only. It removes expired sessions,
marks expired chat leases as interrupted and retains analytics for 90 days.

The job is idempotent and can be retried. Schedule it using the deployment
platform after choosing the hosting environment. It does not send notifications,
scrape sources or contact realtors.
