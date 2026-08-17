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
`version` channels are rejected. BuildKit creation, bootstrap, selection, and
cleanup are not authored in workflow shell. As a checked-in change guard, the
checker accepts only reviewed literal Docker command shapes: `docker login`,
`docker build`, `docker image inspect`, `docker save`, `docker tag`, `docker
push`, and `docker buildx build` without an alternate `--builder`. A literal
`docker` command with a dynamic or unreviewed immediate subcommand fails, as
does a dynamic command position paired with lifecycle-shaping arguments. The
exact reviewed prepare/cleanup calls to
`scripts/ci/forgejo-buildkit-builder.mjs` remain the only lifecycle path. The
helper invokes Docker without a shell and supplies the driver, config, and
digest-pinned BuildKit image as fixed arguments. Its exact output selects the
one-shot builder through the job-local `BUILDX_BUILDER` environment variable;
the helper never changes Buildx's shared default selection.

To update a pin:

1. Resolve the intended upstream release tag directly from its authoritative
   repository or registry.
2. Review the upstream delta and record the release tag beside the immutable
   commit or digest.
3. Update every occurrence in one change.
4. For a BuildKit image update, change the single `BUILDKIT_IMAGE` literal in
   the helper and update its exact-argv test. For a config update, change the
   checked-in config and the live worker-policy assertion together.
5. Builders are one-shot job resources, never rollback generations. Before
   creation, the helper enumerates and retires exact legacy names, every numeric
   legacy generation (including higher generations), and stale one-shot names
   for the same workflow/matrix key. It also removes matching orphan containers
   when no Buildx record exists. Release matrix keys are isolated so concurrent
   entries cannot remove one another, while the workflow-level concurrency
   group serializes separate release runs that reuse those keys.
6. The workflow arms an `EXIT` cleanup before preparation. Cleanup removes only
   that job's exact builder and backing-container names and fails if either
   remains. Enumeration errors also fail closed. Never replace these allowlists
   with a broad Docker prune.
7. Run the pin unit tests, the security stage, and the affected Forgejo workflow
   syntax checks before publication.

The pins prove immutable fetch identity. They do not make third-party code
trusted; changes still require review, and production deployment remains an
operator-authorized action outside CI. The checker helps reviewers catch
unsupported checked-in command shapes; it is not a shell sandbox or a security
boundary against an author who can modify the workflow, helper, and guard in
the same change.
