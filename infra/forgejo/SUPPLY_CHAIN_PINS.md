# Forgejo supply-chain pins

Forgejo workflows execute third-party actions with repository, package, release,
and deployment credentials. Every remote `uses:` reference is therefore pinned
to a full 40-character commit SHA. Human-readable release tags remain as inline
comments only. Workflow service images and the custom Forgejo runner base image
are pinned by `sha256` manifest-list digest. Docker-container BuildKit builders
must likewise pass a literal, digest-pinned image through
`--driver-opt image=<repository>@sha256:<multi-arch-index>`; omitting that option
silently selects Buildx's movable default image.

`node scripts/check-forgejo-supply-chain-pins.mjs` fails closed on a movable
action tag, branch, workflow service image, or runner base image. The canonical
security stage runs this check on every provider. Credential-bearing workflow
tools must also use exact versions; `@latest` package execution and movable
`version` channels are rejected. The checker also rejects implicit, movable, or
expression-driven Docker-container BuildKit images.

To update a pin:

1. Resolve the intended upstream release tag directly from its authoritative
   repository or registry.
2. Review the upstream delta and record the release tag beside the immutable
   commit or digest.
3. Update every occurrence in one change.
4. For a BuildKit image update, bump the persistent builder name so existing
   builder metadata cannot retain the prior image.
5. Run the pin unit tests, the security stage, and the affected Forgejo workflow
   syntax checks before publication.

The pins prove immutable fetch identity. They do not make third-party code
trusted; changes still require review, and production deployment remains an
operator-authorized action outside CI.
