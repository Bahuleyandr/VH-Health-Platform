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
expression-driven Docker-container BuildKit images. It decodes direct inline,
literal, and folded `run` scalars, tokenizes their shell commands, and accepts
Buildx only as an unquoted literal `docker buildx <subcommand>` invocation.
Quoted or concatenated command words, continuations between those command
words, dynamic subcommands, command substitutions, repeated `--driver`
options, and indirect or unsupported `run` forms fail closed rather than
bypassing the pin check. Arguments unrelated to driver selection may remain
dynamic.

To update a pin:

1. Resolve the intended upstream release tag directly from its authoritative
   repository or registry.
2. Review the upstream delta and record the release tag beside the immutable
   commit or digest.
3. Update every occurrence in one change.
4. For a BuildKit image or config update, increment `builder_generation` and
   update the expected image digest, config SHA-256, and literal create options
   together. A reused current builder is checked without `--bootstrap` for its
   image digest, bounded log driver, and creation-time config marker before it
   may start; the live worker garbage-collection policy is checked after start.
   The immediately preceding generation is retained only when its expected
   image and config values are explicitly recorded and that pre-bootstrap proof
   passes. Otherwise it is retired. The current v3 rollout deliberately leaves
   the v2 expectations empty because v2 predates the marker, so v2 is not
   claimed as rollback state.
5. Cleanup enumerates and removes only the exact unsuffixed and obsolete
   generation names after the current builder is healthy. Absence is accepted,
   but enumeration failure, corrupt/unreachable state, or an exact builder or
   backing-container name that remains after removal fails the workflow. Never
   replace this allowlist with a broad Docker prune.
6. Run the pin unit tests, the security stage, and the affected Forgejo workflow
   syntax checks before publication.

The pins prove immutable fetch identity. They do not make third-party code
trusted; changes still require review, and production deployment remains an
operator-authorized action outside CI.
