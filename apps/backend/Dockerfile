# ---- Builder Stage ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

# ---- Production Stage ----
FROM node:22-alpine AS production

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

COPY src ./src
COPY prisma ./prisma
# scripts referenced by src/utils/scheduler.js (backup-db, cleanup-backups,
# purge-archives) — without these the container crashes at boot with
# ERR_MODULE_NOT_FOUND on the first scheduler import.
COPY admin ./admin
# Operational scripts run via `kubectl exec deploy/... -- node scripts/...`
# (seed-test-staff-accounts, check-schema-drift, etc.) — without them the
# image is functional but you can't bootstrap or repair a fresh cluster.
COPY scripts ./scripts

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/health/live || exit 1

CMD ["node", "src/cluster.js"]
