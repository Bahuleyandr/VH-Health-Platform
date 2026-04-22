# Runbook — Clinical AI provider switch

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
- Never put API keys in source files. Store them in the deployment secret
  manager or host environment.

## Env vars

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

### Option A — local Ollama

```
CLINICAL_AI_PROVIDER=ollama
CLINICAL_AI_BASE_URL=http://localhost:11434
CLINICAL_AI_MODEL=llama3.1:8b
CLINICAL_AI_ALLOW_EXTERNAL=false
```

Restart the API, then verify:

```bash
$ curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
    http://localhost:5000/api/v1/emr/clinical-ai/config | jq .data
```

Expected: `enabled=true`, `provider="ollama"`, `externalProvider=false`.

## Module controls

Admin can activate/deactivate Clinical AI modules from `/dashboard/clinical-ai`.
The backend API is:

```bash
$ curl -s -X PATCH http://localhost:5000/api/v1/admin/clinical-ai/modules/discharge_summary \
    -H "x-api-key: $API_KEY_ADMIN" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d '{"enabled":true,"external_allowed":false}' | jq .data
```

If a module is disabled, the workflow stays available but uses deterministic
fallback templates and records `used_ai=false`.

Usage and provider status are visible at:

```bash
$ curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
    "http://localhost:5000/api/v1/admin/clinical-ai/status?days=7" | jq .data.usage
```

### Option B — local OpenAI-compatible gateway

Use this for LM Studio, vLLM, llama.cpp server, LiteLLM on-prem, or a hospital
gateway that exposes `/v1/chat/completions`.

```
CLINICAL_AI_PROVIDER=openai-compatible
CLINICAL_AI_BASE_URL=http://localhost:1234/v1
CLINICAL_AI_MODEL=local-clinical-model
CLINICAL_AI_ALLOW_EXTERNAL=false
```

Restart and verify as in Option A.

### Option C — OpenAI

Only use after external PHI approval is complete.

```
CLINICAL_AI_PROVIDER=openai
CLINICAL_AI_MODEL=gpt-5.4
OPENAI_API_KEY=<secret-manager-value>
CLINICAL_AI_ALLOW_EXTERNAL=true
```

Optional project headers:

```
OPENAI_ORGANIZATION=
OPENAI_PROJECT=
```

Restart and verify `enabled=true`, `provider="openai"`,
`externalProvider=true`, and `externalAllowed=true`.

### Option D — Anthropic

Only use after external PHI approval is complete.

```
CLINICAL_AI_PROVIDER=anthropic
CLINICAL_AI_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=<secret-manager-value>
ANTHROPIC_VERSION=2023-06-01
CLINICAL_AI_ALLOW_EXTERNAL=true
```

Restart and verify `enabled=true`, `provider="anthropic"`,
`externalProvider=true`, and `externalAllowed=true`.

### Option E — emergency disable

```
CLINICAL_AI_PROVIDER=template
CLINICAL_AI_ALLOW_EXTERNAL=false
```

Restart the API. Draft generation will use deterministic templates and keep
recording audit rows with `used_ai=false`.

## Smoke test

Generate a draft for a known non-production admission:

```bash
$ curl -s -X POST http://localhost:5000/api/v1/emr/$ADMISSION_ID/discharge-summary/generate \
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
- Check logs for `Clinical AI generation failed; falling back to template`.
- If any external key was changed, revoke the old key in the provider console.
