# ---- Builder Stage ----
ARG NODE_IMAGE=node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

# ---- Production Stage ----
FROM ${NODE_IMAGE} AS production

RUN apk upgrade --no-cache libcrypto3 libssl3 c-ares && \
    apk add --no-cache curl poppler-utils tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

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

RUN chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/health/live || exit 1

CMD ["node", "src/cluster.js"]
