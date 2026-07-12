# syntax=docker/dockerfile:1.6

ARG NODE_IMAGE=node:26.5.0-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66

# ---- Dependencies Stage ----
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build Stage ----
FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build's `prebuild` hook runs `generate:types`, which reads the backend's
# canonical OpenAPI spec at ../backend/src/docs/openapi.json (gitignored output
# in apps/admin/src/lib). The Docker build context is ./apps/admin, so the
# backend dir is provided as a named build context (`backend=./apps/backend` in
# the workflow's docker/build-push-action `build-contexts`). Place the spec
# where generate:types expects it (WORKDIR is /app → ../backend = /backend).
COPY --from=backend src/docs/openapi.json /backend/src/docs/openapi.json

ENV NEXT_TELEMETRY_DISABLED=1

# Build args for NEXT_PUBLIC env vars (needed at build time)
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_ALLOWED_ORIGIN
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_RELEASE
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
ARG NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0
ARG NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE=0
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_UPLOAD_SOURCE_MAPS=false
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_ALLOWED_ORIGIN=$NEXT_PUBLIC_ALLOWED_ORIGIN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT
ENV NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE
ENV NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
ENV NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE
ENV NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ENV SENTRY_UPLOAD_SOURCE_MAPS=$SENTRY_UPLOAD_SOURCE_MAPS

RUN --mount=type=secret,id=sentry_auth_token,required=false \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" && \
    npm run build

# ---- Runner Stage ----
FROM ${NODE_IMAGE} AS runner

RUN apk upgrade --no-cache libcrypto3 libssl3 c-ares && \
    apk add --no-cache curl && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy full build output (no standalone dependency)
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/public ./public

USER nextjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001 || exit 1

CMD ["node_modules/.bin/next", "start", "-p", "3001"]
