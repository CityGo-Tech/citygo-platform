# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS context-audit
WORKDIR /workspace
COPY . .
RUN node scripts/check-container-context.mjs /workspace

FROM context-audit AS builder
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
RUN pnpm install --frozen-lockfile
# Next rewrites are baked at build time. This is a route, never a credential.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} CITYGO_WEB_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# pnpm 10.15's legacy deploy supports this non-injected workspace and lockfile.
RUN pnpm --filter @citygo/api deploy --legacy --prod /out/api \
 && pnpm --filter @citygo/worker deploy --legacy --prod /out/jobs

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --chown=node:node scripts/env.mjs scripts/process.mjs scripts/container-runtime.mjs scripts/container-health.mjs ./scripts/
USER node
ENTRYPOINT ["node", "scripts/container-runtime.mjs"]

FROM runtime AS api
COPY --from=builder --chown=node:node /out/api/ ./
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "scripts/container-health.mjs", "api"]
CMD ["api"]

FROM runtime AS jobs
COPY --from=builder --chown=node:node /out/jobs/ ./
# Migrations and maintenance are explicit one-shot operations, never API startup.
CMD ["migrate"]

FROM runtime AS web
COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone/ ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=builder --chown=node:node /workspace/apps/web/public/ ./apps/web/public/
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "scripts/container-health.mjs", "web"]
CMD ["web"]
