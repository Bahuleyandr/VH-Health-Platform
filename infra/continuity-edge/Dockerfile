ARG RCLONE_IMAGE=docker.io/rclone/rclone:1.70.3@sha256:34c729127386abec1c610b2aa024e39b4498dc2b4a72a0798ae21fbdc1b0493b
ARG NODE_IMAGE=docker.io/library/node:22.17.1-alpine3.22@sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59

FROM ${RCLONE_IMAGE} AS rclone
FROM ${NODE_IMAGE} AS verifier-build

WORKDIR /src
COPY apps/backend/src/services/downtime/continuityEdgeMirrorVerifier.js apps/backend/src/services/downtime/continuityEdgeMirrorVerifier.js
COPY apps/backend/src/services/downtime/continuityPackCanonical.js apps/backend/src/services/downtime/continuityPackCanonical.js
COPY apps/backend/src/services/downtime/continuityPackPublicationService.js apps/backend/src/services/downtime/continuityPackPublicationService.js
COPY infra/continuity-edge infra/continuity-edge
RUN node infra/continuity-edge/tools/build-runtime-verifier.mjs \
      --repo-root /src \
      --out /opt/vhhealth-continuity-edge/runtime

FROM ${NODE_IMAGE}

RUN apk add --no-cache openssh-client rsync \
    && addgroup -S -g 10001 vhedge \
    && adduser -S -D -H -u 10001 -G vhedge vhedge

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=verifier-build /opt/vhhealth-continuity-edge/runtime /opt/vhhealth-continuity-edge/runtime
COPY --chown=10001:10001 infra/continuity-edge/package.json infra/continuity-edge/README.md infra/continuity-edge/Caddyfile /opt/vhhealth-continuity-edge/
COPY --chown=10001:10001 infra/continuity-edge/bin /opt/vhhealth-continuity-edge/bin
COPY --chown=10001:10001 infra/continuity-edge/lib /opt/vhhealth-continuity-edge/lib
COPY --chown=10001:10001 infra/continuity-edge/config /opt/vhhealth-continuity-edge/config
COPY --chown=10001:10001 infra/continuity-edge/ssh /opt/vhhealth-continuity-edge/ssh
COPY --chown=10001:10001 infra/continuity-edge/systemd /opt/vhhealth-continuity-edge/systemd

WORKDIR /opt/vhhealth-continuity-edge
USER 10001:10001

ENV NODE_ENV=production
ENV VHEDGE_RUNTIME_ROOT=/opt/vhhealth-continuity-edge/runtime

ENTRYPOINT ["node"]
CMD ["/opt/vhhealth-continuity-edge/bin/gateway.mjs"]
