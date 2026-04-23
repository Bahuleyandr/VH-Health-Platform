# Runbook — Clinical AI provider switch

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P2 (draft generation degraded) / P1 (discharge workflow blocked)

Clinical AI powers discharge-summary and handover drafts. The default mode is
`template`, which keeps the feature usable without an LLM. External providers
are intentionally blocked unless `CLINICAL_AI_ALLOW_EXTERNAL=true` is set.

## Safety rules

- Treat all prompts and outputs as PHI-bearing clinical data.
- Use `template`, `ollama`, or a local `openai-compatible` endpoint unless a
  compliant external-provider agreement and approval are already in place.
- External/cloud providers require two gates: `CLINICAL_AI_ALLOW_EXTERNAL=true`
  and the specific Clinical AI module's `external_allowed=true`.
- AI output is always a draft. A clinician must review, edit if needed, and
  sign the final discharge note.
- Never put API keys in source files. Keys are sealed-secret managed — only
  the sealed form ever hits git.

## Env vars

All of these live in the sealed secret
`infra/kubernetes/apps/backend/vhhealth-clinical-ai.sealed-secret.yaml`.

```
CLINICAL_AI_PROVIDER          # template | ollama | openai-compatible | openai | anthropic
CLINICAL_AI_BASE_URL          # optional; defaults exist for ollama/openai/anthropic
CLINICAL_AI_MODEL             # provider model id
CLINICAL_AI_API_KEY           # generic key override
CLINICAL_AI_ALLOW_EXTERNAL    # must be true for openai/anthropic/external gateways
CLINICAL_AI_TIMEOUT_MS        # default 45000
CLINICAL_AI_MAX_TOKENS        # default 2200
CLINICAL_AI_TEMPERATURE       # default 0.15
```

Optional cost estimate inputs:

```
CLINICAL_AI_INPUT_COST_PER_MILLION_MINOR
CLINICAL_AI_OUTPUT_COST_PER_MILLION_MINOR
```

Provider-specific key aliases:

```
OPENAI_API_KEY
OPENAI_ORGANIZATION
OPENAI_PROJECT
ANTHROPIC_API_KEY
ANTHROPIC_VERSION
```

## Response

### Option A — local Ollama (in-cluster)

Ollama runs as a `Deployment` in `vhhealth-platform` namespace with a
service `ollama.vhhealth-platform.svc.cluster.local:11434`.

Build + seal:
```yaml
CLINICAL_AI_PROVIDER: "ollama"
CLINICAL_AI_BASE_URL: "http://ollama.vhhealth-platform.svc.cluster.local:11434"
CLINICAL_AI_MODEL: "llama3.1:8b"
CLINICAL_AI_ALLOW_EXTERNAL: "false"
```

Commit, sync, restart:
```bash
git commit -am "chore(clinical-ai): switch to in-cluster Ollama"
git push
argocd app sync vhhealth-backend
kubectl -n vhhealth rollout restart deployment/vhhealth-backend
```

Verify:
```bash
ADMIN_JWT=<admin-jwt>
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
    http://localhost:5000/api/v1/emr/clinical-ai/config | jq .data
```

Expected: `enabled=true`, `provider="ollama"`, `externalProvider=false`.

## Module controls

Admin can activate/deactivate Clinical AI modules from `/dashboard/clinical-ai`.
The backend API is:

```bash
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -X PATCH http://localhost:5000/api/v1/admin/clinical-ai/modules/discharge_summary \
    -H "x-api-key: $API_KEY_ADMIN" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d '{"enabled":true,"external_allowed":false}' | jq .data
```

If a module is disabled, the workflow stays available but uses deterministic
fallback templates and records `used_ai=false`.

Usage and provider status are visible at:

```bash
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
    "http://localhost:5000/api/v1/admin/clinical-ai/status?days=7" | jq .data.usage
```

## Budget guardrails

Admin can set daily token/cost caps, output-token caps, fallback alerts, latency
alerts, and the external-AI emergency switch from `/dashboard/clinical-ai`.

```bash
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -X PATCH http://localhost:5000/api/v1/admin/clinical-ai/guardrails \
    -H "x-api-key: $API_KEY_ADMIN" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d '{"daily_token_limit":200000,"request_token_limit":1800,"fallback_rate_alert_pct":40}' | jq .data
```

When a daily token or cost cap is exhausted, generation requests do not call the
provider. They continue through deterministic fallback templates and record the
budget reason in `clinical_ai_generations.metadata.fallback_reason`.

The emergency external-AI switch is separate from environment and module gates:

```bash
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -X PATCH http://localhost:5000/api/v1/admin/clinical-ai/guardrails \
    -H "x-api-key: $API_KEY_ADMIN" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d '{"external_ai_enabled":false}' | jq .data.guardrails.external_ai_enabled
```

### Option B — local OpenAI-compatible gateway

Use this for LM Studio, vLLM, llama.cpp server, LiteLLM on-prem, or a hospital
gateway that exposes `/v1/chat/completions`. Same sealed-secret update pattern
as Option A.

```yaml
CLINICAL_AI_PROVIDER: "openai-compatible"
CLINICAL_AI_BASE_URL: "http://gateway.vhhealth-platform.svc.cluster.local:1234/v1"
CLINICAL_AI_MODEL: "local-clinical-model"
CLINICAL_AI_ALLOW_EXTERNAL: "false"
```

Restart and verify as in Option A.

### Option C — OpenAI

Only use after external PHI approval is complete.

```yaml
CLINICAL_AI_PROVIDER: "openai"
CLINICAL_AI_MODEL: "gpt-5.4"
OPENAI_API_KEY: "<secret-value>"
CLINICAL_AI_ALLOW_EXTERNAL: "true"
```

Optional project headers:

```yaml
OPENAI_ORGANIZATION: ""
OPENAI_PROJECT: ""
```

Seal, commit, sync, restart. Verify `enabled=true`, `provider="openai"`,
`externalProvider=true`, and `externalAllowed=true`.

### Option D — Anthropic

Only use after external PHI approval is complete.

```yaml
CLINICAL_AI_PROVIDER: "anthropic"
CLINICAL_AI_MODEL: "claude-sonnet-4-20250514"
ANTHROPIC_API_KEY: "<secret-value>"
ANTHROPIC_VERSION: "2023-06-01"
CLINICAL_AI_ALLOW_EXTERNAL: "true"
```

Seal, commit, sync, restart. Verify `enabled=true`, `provider="anthropic"`,
`externalProvider=true`, and `externalAllowed=true`.

### Option E — emergency disable

```yaml
CLINICAL_AI_PROVIDER: "template"
CLINICAL_AI_ALLOW_EXTERNAL: "false"
```

Seal, commit, sync, restart. Draft generation will use deterministic templates
and keep recording audit rows with `used_ai=false`.

## Smoke test

Generate a draft for a known non-production admission:

```bash
DOCTOR_JWT=<test-doctor-jwt>
ADMISSION_ID=<test-admission-id>
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -X POST http://localhost:5000/api/v1/emr/$ADMISSION_ID/discharge-summary/generate \
    -H "x-api-key: $API_KEY_DOCTOR" \
    -H "Authorization: Bearer $DOCTOR_JWT" \
    -H "Content-Type: application/json" \
    -d '{}' | jq '.data.discharge_summary.ai_metadata'
```

Expected: provider/model match the env vars. If the provider is unavailable,
the response should still succeed with `used_ai=false` and a fallback reason.

## Post-change checks

- Review the latest rows in `/api/v1/admin/clinical-ai/generations`.
- Confirm safety flags are visible in `/dashboard/clinical-ai`.
- Check logs for `Clinical AI generation failed; falling back to template`:
  ```bash
  kubectl -n vhhealth logs deployment/vhhealth-backend --tail=500 | grep -i "clinical ai"
  ```
- If any external key was changed, revoke the old key in the provider console.
