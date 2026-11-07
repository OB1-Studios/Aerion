# One Dockerfile, two images (Coolify builds both from docker-compose.yml):
#   --target web     Next.js standalone server (port 3000)
#   --target worker  the workflow runner, weekly schedule and demo clean-up; also runs migrations
# Build context is the repo root.

FROM node:24-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# Installed globally (not via corepack) so the non-root runtime user never downloads it.
RUN npm install -g pnpm@10.34.9 && mkdir -p /data/storage && chown node:node /data/storage
WORKDIR /repo

# Dependencies first, so source changes don't reinstall them.
# Node gives each address 250 ms to connect. From Singapore, Vultr's API and Serverless Inference take
# about 235 ms, so calls to them would fail at random. Set again in the web image, which starts from Node's.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/vultr/package.json packages/vultr/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# Next.js reads secrets at run time; this placeholder only lets the build load the auth module.
FROM source AS web-build
RUN BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-run-time pnpm --filter @ebo/web build

FROM node:24-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000
# Used only when Object Storage isn't configured (a volume shared with the worker).
RUN mkdir -p /data/storage && chown node:node /data/storage
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM source AS worker
ENV NODE_ENV=production WORKER_PORT=8081
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8081/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@ebo/worker", "start"]
