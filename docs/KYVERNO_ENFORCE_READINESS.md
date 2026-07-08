# Kyverno Enforce Readiness Runbook

This runbook turns the image-signature policy from "wired in Audit mode" into a
safe operator ceremony. It does not flip the checked-in manifest to Enforce.
The repo stays in Audit until the operator records clean live evidence and
performs the Enforce flip in a controlled window.

## Gate Command

The static part runs in CI:

```bash
node scripts/check-kyverno-enforce-readiness.mjs
```

Before any Enforce flip, run the live gate from an operator shell with the
production kube context:

```bash
node scripts/check-kyverno-enforce-readiness.mjs \
  --live \
  --context <prod-context> \
  --since-hours 24 \
  --min-pass-results 3
```

The live gate proves all of these at once:

- the checked-in ClusterPolicy still renders in Audit mode with fail-closed
  admission semantics;
- `kyverno/vhhealth-cosign-public-key` exists and contains `cosign.pub`;
- the live `ClusterPolicy/verify-vhhealth-image-signatures` is still in the
  expected `Audit` state before the flip;
- PolicyReport or ClusterPolicyReport has fresh pass results for the policy;
- PolicyReport or ClusterPolicyReport has zero `fail`, `warn`, or `error`
  results for the policy.

Use `--since-hours=0` only when the operator separately records the clean-cycle
timestamp and attaches that evidence to the change record.

## Preconditions

1. Kyverno 1.12 or newer is installed and healthy.
2. ArgoCD has completed at least one full sync with
   `verify-vhhealth-image-signatures` in Audit mode.
3. The Forgejo cosign public key has been sealed or created as
   `kyverno/vhhealth-cosign-public-key` with key `cosign.pub`.
4. The currently deployed backend, admin, and staff-web images are signed by
   either the GitHub keyless workflow identity or the Forgejo key pair named in
   the policy.
5. No application rollout, migration, or node maintenance is in progress.

## Enforce Ceremony

1. Freeze routine deploys for the admission-control window.
2. Run the live gate above and save the output in the operator evidence record.
3. Capture the raw policy reports:

   ```bash
   kubectl --context <prod-context> get policyreport -A -o json
   kubectl --context <prod-context> get clusterpolicyreport -o json
   ```

4. Flip only the live ClusterPolicy:

   ```bash
   kubectl --context <prod-context> patch clusterpolicy verify-vhhealth-image-signatures \
     --type merge \
     -p '{"spec":{"validationFailureAction":"Enforce"}}'
   ```

5. Server-side dry-run a pod using a currently deployed signed image:

   ```bash
   IMAGE=$(kubectl --context <prod-context> -n vhhealth-platform \
     get deploy vhhealth-backend -o jsonpath='{.spec.template.spec.containers[0].image}')
   kubectl --context <prod-context> -n vhhealth-platform run kyverno-enforce-smoke \
     --restart=Never \
     --image="$IMAGE" \
     --dry-run=server \
     -o yaml
   ```

6. Watch the workloads that may create replacement pods:

   ```bash
   kubectl --context <prod-context> -n vhhealth-platform get pods
   kubectl --context <prod-context> -n vhhealth-platform get events --sort-by=.lastTimestamp
   ```

7. Re-query the live gate in Enforce state:

   ```bash
   node scripts/check-kyverno-enforce-readiness.mjs \
     --live \
     --context <prod-context> \
     --expected-action Enforce \
     --since-hours 24 \
     --min-pass-results 3
   ```

## Rollback

Rollback is a live operator action; do not push a repo change during an
admission outage.

1. Return the live policy to Audit:

   ```bash
   kubectl --context <prod-context> patch clusterpolicy verify-vhhealth-image-signatures \
     --type merge \
     -p '{"spec":{"validationFailureAction":"Audit"}}'
   ```

2. If pods are still blocked because the policy object itself is malformed,
   delete only the live policy and let ArgoCD restore the checked-in Audit-mode
   policy:

   ```bash
   kubectl --context <prod-context> delete clusterpolicy verify-vhhealth-image-signatures
   ```

3. Confirm pod admission recovers with the server-side dry-run command above.
4. Record the failed PolicyReport rows, the rollback time, and the first
   recovered pod-admission proof before trying again.

## Evidence To Attach

- live gate output before the flip;
- `policyreport` and `clusterpolicyreport` JSON captured after the clean Audit
  cycle;
- public-key Secret metadata, not the key body;
- dry-run pod admission output after Enforce;
- live gate output after Enforce, if the operator completes the flip;
- rollback output if the ceremony is aborted.
