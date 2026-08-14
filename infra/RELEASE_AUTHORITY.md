# Release authority interlock

`infra/release-authority.json` is the decision record and machine-enforced
contract for release authority. Its repository default is `HELD`: neither
GitHub nor Forgejo is selected, no release signer is authoritative, and no
Argo source is accepted as authoritative. A merge of this interlock does not
select a provider, publish an app or image, update a digest pin, sync Argo, or
deploy anything.

## Held behavior

Every governed GitHub and Forgejo image-publication, digest-pin, Patient,
Staff, and staging workflow starts with `scripts/check-release-authority.mjs`. In
`HELD`, that job succeeds with `authorized=false`, uploads only its JSON
verification evidence, and all mutation-capable jobs are skipped. Top-level
workflow permissions are read-only. Digest-pin and staging preparation lanes
produce verification evidence and reviewable patch artifacts; no workflow may
push directly to `main`.

All governed mutation workflows use new `release-authority-*.yml` identities
that do not exist in repository history before this interlock. Dispatch is
accepted only when the new workflow runs from `refs/heads/main`; tag-push
mutation triggers are forbidden by the contract. The former workflow paths are
deleted from the default branch so their manual dispatchers are no longer
registered there.

## Provider asymmetry: GitHub renamed in place, Forgejo made inert

The two providers are treated differently on purpose, and the directory layout
is the mechanism.

The GitHub set was renamed in place under `.github/workflows/`, so those
workflows stay registered and dispatchable — held shut by the checker rather
than by absence.

The Forgejo set was moved **out** of `.forgejo/workflows/` into
`.forgejo/release-authority-templates/`. Forgejo Actions only registers
workflows under `.forgejo/workflows/`, so this deregisters the entire Forgejo
release lane: no dispatchers, no triggers, no runs. This implements the owner
deferral recorded in `docs/FABLE_5_FULL_AUDIT_HANDOFF_2026_08_13.md` ("GitHub is
the only publication target for this continuation… Do not extend the Forgejo
release-authority work") and `DEFER-1` in
`docs/FULL_REPOSITORY_AUDIT_2026_08.md`. Registering seven new dispatchable
Forgejo release workflows would have been precisely the extension that decision
forbids.

Two consequences follow, both intended:

- `providers.forgejo.executionBoundary.mode` is `inert-template`, and the
  checker **refuses to let `ACTIVE` select any provider whose workflows are
  inert templates**. Forgejo cannot become the release authority by manifest
  edit alone; the files must first be moved back under `.forgejo/workflows/` in
  a reviewed change.
- The Forgejo container supply-chain lane does not run, so Forgejo produces no
  container image scan, signature, or SBOM today. There are no Forgejo-published
  images to scan while authority is `HELD`. The Forgejo Trivy *filesystem* scan
  in `.forgejo/workflows/security-sweep.yml` is unaffected and still blocking.

The templates are not dead code: `scripts/check-release-authority.mjs` holds
them to the same authority contract as the live GitHub set — read-only top-level
permissions, no tag-push mutation, no direct push to `main`, and cosign
key-pair proof against the tracked `infra/forgejo/signing/cosign.pub` — so
activation is a reviewed move rather than a rewrite.

That repository transition cannot revoke credentials from a workflow body in
an older tagged commit. HELD therefore also requires an external containment
ceremony before this change reaches either provider: disable every deleted
legacy workflow identity, protect all governed release-tag namespaces against
direct creation, remove legacy repository-scoped publication/deploy secrets,
and rotate the Forgejo cosign key. Do not enable any new authority workflow or
restore write credentials until those controls have been independently
verified. If that ceremony is incomplete, the operational release posture is
not safely held and this change must not be merged.

Missing configuration, malformed JSON, missing read credentials, provider API
errors, timeouts, authentication failures, missing tags, tag disagreement,
main-SHA disagreement, commit-containment uncertainty, Argo source disagreement,
or live Argo revision disagreement all block an `ACTIVE` run. Uncertainty is
never treated as parity.

## Owner activation decision

Activation is one reviewed repository change after the release, security, and
infrastructure owners make an explicit provider decision. That change must:

1. Set `state` to `ACTIVE`.
2. Set exactly one `providers.<name>.selected` to `true` and leave the other
   `false`.
3. Set `selectedProvider`, `releaseSignerProvider`, and `argoSourceProvider` to
   that same provider. The checker rejects split authority.
4. Align every governed Argo Application source URL with that provider and set
   the repository revision to the literal `main` branch. This must be
   coordinated with the Argo/operator-lifecycle owner; this interlock does not
   change those manifests.
5. Provision read-only observation credentials using the environment names in
   the manifest. The selected workflow may retain narrowly scoped write
   credentials only inside its already-gated mutation job. The mirror and Argo
   credentials remain read-only.
6. Record independent evidence that every legacy workflow identity is disabled,
   its publication/deploy credentials are revoked, and release tags on both
   providers can only be created through the protected default-branch release
   ceremony. Rotate the Forgejo signing key and commit its new public half
   before restoring the selected lane's private key.
7. Configure one-way mirroring so a
   tag resolves to the same commit on both providers. The checker independently
   observes both providers; it does not fetch, force, repair, or mutate either
   remote.
8. Keep the selected signing contract aligned: GitHub uses the
   `release-authority-images.yml` Sigstore keyless identity, while Forgejo uses the
   repository-pinned cosign public key at `infra/forgejo/signing/cosign.pub`.

Before authorizing a run, the checker proves that both providers report the
same `main` SHA, every supplied release tag resolves to the same commit on both
providers, each release/workflow commit is contained in that exact main SHA,
and every governed live Argo Application uses the selected repository at
`main` and reports the same SHA. A tag or manual dispatch is not authority by
itself.

## Verification

Run the local contract and adversarial suite with:

```powershell
node scripts/check-release-authority.mjs --contract
node --test scripts/check-release-authority.test.mjs
```

The security, contracts, and infrastructure CI stages run this contract. The
Forgejo immutable action-SHA, workflow-image-digest, and runner-image-digest
gate remains separate and mandatory.
