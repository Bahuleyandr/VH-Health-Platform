# Workflow supply-chain pins

GitHub is the repository's hosted CI/CD provider. Remote workflow `uses:`
references must use full 40-character commit SHAs; release tags beside them
are human-readable comments only. Workflow service images use explicit
`sha256` digests. Dynamic image inputs are accepted only at the guarded reusable
Postgres and built-image scanner seams; the PG18 canary validates its image
before passing that output into the backend workflow.

`node scripts/check-workflow-supply-chain-pins.mjs` runs in the unconditional
canonical security stage. It rejects movable action refs, unsupported dynamic
images, movable tool-version channels and `npx` package execution at `latest`.
The guard's mutation tests cover YAML aliases and escaped keys, quoted and
folded commands, command wrappers, and indirect BuildKit lifecycle commands.

BuildKit lifecycle management belongs to the immutable
`docker/setup-buildx-action` reference, with `driver: docker-container` and a
literal digest-pinned BuildKit image in `driver-opts`. Workflow shell must not
create, select, bootstrap, remove or broadly prune builders. Approved Docker
shell commands are limited to the checked-in command shapes for login, build,
image inspection, archive export, tagging and pushing. The action's own
post-job cleanup replaces the retired provider-specific lifecycle helper.

## Updating a pin

1. Resolve the intended upstream release from its authoritative source and
   review the delta. Do not infer a digest or replace it with a mutable tag.
2. Update all affected references in one reviewed change and retain the release
   version comment. BuildKit changes must update every setup action input.
3. Run `node --test scripts/check-workflow-supply-chain-pins.test.mjs`, the
   checker and the applicable workflow/CI contract tests. Then run affected
   full local validation and exact-head hosted CI through normal authorization.
4. Treat image publication, signing, credential changes and deployment as
   separate authority boundaries; passing a pin checker does not grant them.

Pins prove fetch identity, not safety of third-party code. This is a
checked-in-change guard, not a shell sandbox against an author who can edit the
workflow and checker together. It does not verify downloaded installer bytes,
hosted runner configuration or a completed build; those remain separate
review and execution evidence.
