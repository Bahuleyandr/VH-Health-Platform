# ---- Builder Stage ----
ARG NODE_IMAGE=node:26.5.0-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN NODE_OPTIONS=--max-old-space-size=4096 npx prisma generate

# ---- Production Stage ----
FROM ${NODE_IMAGE} AS production

# Bump SECURITY_PATCH_EPOCH to force the apk layer to re-execute. Both image
# workflows build with a GHA layer cache, and an unchanged RUN on an unchanged
# base digest is a cache HIT — the upgrade then replays its original result
# forever and never fetches packages published since, so a Trivy finding whose
# fix is already on the Alpine mirror can never clear (CVE-2026-14456 stuck
# exactly this way on 2026-08-26). The echo makes the epoch part of the layer.
#
# A STALE EPOCH is what wedges the blocking scan, and bumping it is the whole
# remedy. CVE-2026-26740 in giflib stuck this way on 2026-08-31: the cached
# layer kept replaying a resolve from before giflib 5.2.2-r2 was published.
#
# Be precise about what the upgrade can reach, because it is easy to get
# backwards. It runs BEFORE the apk add below, so it covers ONLY the pinned
# base image's own packages. Anything the apk add brings in -- including
# transitive dependencies such as giflib, pulled under tesseract-ocr via
# leptonica -- is not in the image yet when the upgrade runs, and is instead
# refreshed by apk add's own resolve against the live index. Both halves
# therefore depend on this layer actually re-executing, which is what the
# epoch controls.
#
# The upgrade is nonetheless deliberately UNSCOPED. It used to name
# libcrypto3/libssl3/c-ares -- exactly the packages from the previous fire, and
# c-ares is not even installed in the base image -- which left every other base
# package (musl, zlib, busybox, libstdc++, ca-certificates-bundle) permanently
# unpatchable behind a hand-maintained list. The pinned base carries HIGH
# findings only this upgrade can reach. Do not re-narrow it to a package list;
# check-infra-security-controls.mjs enforces that for all three images.
ARG SECURITY_PATCH_EPOCH=2026-09-01.1
RUN apk upgrade --no-cache && \
    apk add --no-cache curl poppler-utils tesseract-ocr tesseract-ocr-data-eng && \
    echo "security patch epoch: ${SECURITY_PATCH_EPOCH}"

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

# Resolve the boot-critical dependency checker in the production dependency
# tree during image build. This catches imports that only work because a
# development or transitive package happened to be present in the builder.
RUN node --input-type=module -e "await import('./src/utils/dependencyChecker.js')"

RUN chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/health/live || exit 1

CMD ["node", "src/cluster.js"]
