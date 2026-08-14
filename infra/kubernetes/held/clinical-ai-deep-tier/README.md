# HELD — clinical-AI deep tier (in-cluster Ollama)

Status: **held, not composed, not deployed.**

Nothing in the active production graph references this directory. It is absent
from `infra/kubernetes/apps/kustomization.yaml` and from every overlay, so a
repository merge plus a sync of the four active manual-sync Argo CD
Applications deploys none of it. This mirrors the other held components:
`infra/kubernetes/held/operator-lifecycle/`,
`infra/kubernetes/held/c6-2-warm-standby/`,
`infra/kubernetes/base/sso-keycloak/keycloak-app.held.yaml`.

## Why it is held

Phase 4 of `docs/archive/CLINICAL_AI_ROLLOUT_PLAN.md` requires a GPU node. The cluster
does not have one. Until 2026-08-13 this directory was listed in the app
barrel, which meant every sync of the `apps` Application:

- applied an Ollama `StatefulSet` whose `nodeSelector` is
  `nvidia.com/gpu.present=true`, so the pod stayed `Pending` forever; and
- applied `deep-tier-preflight` as an ordinary sync-wave-3 `Job`, which then
  exhausted `backoffLimit: 3` against a Service with no backend pod, leaving
  the Application `Degraded`.

That is a pending capability composed into a live graph: neither cleanly held
nor safely deployable. The audit of 2026-08-13 (P1) required it to become an
explicitly held, separately governed path with fail-closed activation.

## What changed

- The directory moved from `infra/kubernetes/apps/ollama/` to
  `infra/kubernetes/held/clinical-ai-deep-tier/` and was removed from the app
  barrel's `resources:`.
- `deep-tier-preflight` became an Argo CD **`PreSync` hook**
  (`hook-delete-policy: BeforeHookCreation`) instead of a wave-3 Job. A failing
  preflight now **refuses the activation sync** rather than reporting failure
  after the workload is already applied. This matches the backend migration
  Job's hook shape in `infra/kubernetes/apps/backend/migration-job.yaml`.
- Every object rendered from here carries `vhhealth.app/deploy-state: "held"`.

No manifest was deleted and nothing was activated. The images stay
digest-pinned, so the manifests remain reviewable and re-composable as-is.

## Activation (explicit, operator-owned, fail-closed)

Do not re-add this directory to an active barrel. Activation is a deliberate,
separately reviewed sequence:

1. **Hardware.** Provision the GPU node, label it
   `nvidia.com/gpu.present=true`, and install a healthy
   `nvidia-device-plugin` DaemonSet. See `docs/HARDWARE_REQUIREMENTS.md`.
2. **Review the render.**
   ```bash
   kustomize build infra/kubernetes/held/clinical-ai-deep-tier
   ```
   Confirm the pinned digests still resolve
   (`node scripts/check-prod-digests-pinned.mjs` covers only the active roots;
   held images are verified at activation).
3. **Apply and load a model.** Apply the reviewed render, wait for
   `ollama-0` to be `Running`, then
   `kubectl exec -n vhhealth ollama-0 -- ollama pull <model>`.
4. **Let the preflight gate the rest.** Re-run the sync; the `PreSync` hook
   probes `/` and `/api/tags` and fails the sync unless at least one model —
   and, when `CLINICAL_AI_DEEP_MODEL` is set, that exact model — is loaded.
5. **Only then** set the backend deep-tier bindings:
   `CLINICAL_AI_DEEP_PROVIDER=ollama`,
   `CLINICAL_AI_DEEP_BASE_URL=http://ollama-internal.vhhealth.svc.cluster.local:11434`,
   `CLINICAL_AI_DEEP_MODEL=<model-name>`. With `CLINICAL_AI_DEEP_PROVIDER`
   unset the backend deep tier stays off, so step 5 is the real activation
   boundary for patient-facing behaviour.
6. **Ward pilot.** Enable one ward first per
   `docs/PER_TENANT_ROLLOUT_PLAYBOOK.md` before any fleet-wide rollout.

## Validation

Held paths are deliberately outside the rendered-manifest validator targets in
`scripts/validate-kubernetes-manifests.mjs`, exactly like
`held/operator-lifecycle/` and `held/c6-2-warm-standby/`. The C1.1 contract
(`scripts/check-c1-1-manifest-contract.mjs`) asserts the inverse: that the
Ollama image and workload are **absent** from both active production renders
and **present** in this held directory.
