# Runbook — Chatbot provider switch

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P2 (feature degraded) / P1 (paid-tier SLA breach)

The symptom-checker / patient chatbot uses a pluggable LLM provider
configured via `CHATBOT_*` env vars (see `.env.example`). When the
primary provider has an outage, key rotation, or quota exhaustion,
flip to the backup provider via sealed secret update — ArgoCD rolls
the backend automatically.

## Symptoms

- Patient app: "Sorry, I can't help right now" banner on symptom checker
- Admin portal notification drawer: `ChatbotFallbackRate` tile spikes
- Backend logs (`kubectl -n vhhealth logs deployment/vhhealth-backend`):
  `Chatbot provider <name> returned <status>` with retry count exhausted
- Sentry: `ChatbotProviderError` breadcrumbs trending up

## Prerequisites

- kubeconfig for `vhhealth-prod`.
- `kubeseal` CLI + write access to the repo.
- Backup provider API key ready (stored in the secrets locker alongside
  the primary).
- 30 seconds of downtime-acceptable window (rolling restart is non-blocking).

## Mental model — env vars

```
CHATBOT_PROVIDER       — "anthropic" | "openai" | "gemini" | "llama-local"
CHATBOT_BASE_URL       — override endpoint (for Azure OpenAI, custom gateways)
CHATBOT_MODEL          — model ID (e.g. "claude-3-5-sonnet", "gpt-4o-mini")
CHATBOT_API_KEY        — provider credential
CHATBOT_FALLBACK_ENABLED — if "true", on provider error the backend returns a
                          canned conservative response instead of propagating the error
```

All five live in the sealed secret
`infra/kubernetes/apps/backend/vhhealth-chatbot.sealed-secret.yaml`.

Adherence-risk ONNX + chatbot are intentionally decoupled; this only
touches the chatbot path.

## Response

### Option A — provider outage (full switch)

1. Confirm the primary is actually down (not just rate-limited):
   ```bash
   OLD_KEY=$(kubectl -n vhhealth get secret vhhealth-chatbot -o jsonpath='{.data.CHATBOT_API_KEY}' | base64 -d)
   curl -s -X POST https://api.anthropic.com/v1/messages \
       -H "x-api-key: $OLD_KEY" -H "anthropic-version: 2023-06-01" \
       -H "content-type: application/json" \
       -d '{"model":"claude-3-5-haiku-20241022","max_tokens":10,"messages":[{"role":"user","content":"ping"}]}' \
       -w '\nHTTP %{http_code}\n'
   ```
   If 5xx / timeout → provider outage. If 401 → key problem (skip to
   §Option B). If 429 → quota / rate limit (skip to §Option C).

2. Flip provider via sealed secret:
   ```bash
   cat > /tmp/chatbot-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: vhhealth-chatbot
     namespace: vhhealth
   stringData:
     CHATBOT_PROVIDER: "openai"
     CHATBOT_BASE_URL: "https://api.openai.com/v1"
     CHATBOT_MODEL: "gpt-4o-mini"
     CHATBOT_API_KEY: "$OPENAI_KEY"
     CHATBOT_FALLBACK_ENABLED: "false"
   EOF
   kubeseal < /tmp/chatbot-secret.yaml \
     > infra/kubernetes/apps/backend/vhhealth-chatbot.sealed-secret.yaml
   rm /tmp/chatbot-secret.yaml

   git commit -am "chore(chatbot): switch to openai (anthropic outage)"
   git push
   argocd app sync vhhealth-backend
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   kubectl -n vhhealth rollout status deployment/vhhealth-backend
   ```

3. Smoke-test:
   ```bash
   JWT=<test-patient-jwt>
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
     curl -s -X POST http://localhost:5000/api/v1/chatbot/symptom-check \
       -H "Authorization: Bearer $JWT" -H "x-api-key: $API_KEY_PATIENT" \
       -H "Content-Type: application/json" \
       -d '{"symptom":"headache for 2 days","context":{"age":35}}' | jq .data.response
   # Expected: a non-empty response string + provider field === "openai"
   ```

4. Flush the in-process response cache on each pod:
   ```bash
   kubectl -n vhhealth create job --from=cronjob/flush-chatbot-cache chatbot-flush-$(date +%s)
   kubectl -n vhhealth logs -l job-type=chatbot-flush --tail=50
   ```

### Option B — key rotation (same provider)

1. Generate / retrieve new key from provider console.
2. Update only `CHATBOT_API_KEY` in the sealed secret (rebuild the YAML with
   the rest of the values unchanged), commit, sync, restart.
3. Smoke-test as in Option A §3.
4. Revoke the old key in the provider console.

### Option C — quota exhaustion (temporary)

1. Enable the graceful-fallback flag so patients see a canned safe
   response instead of errors:
   ```bash
   # Rebuild the chatbot Secret with CHATBOT_FALLBACK_ENABLED: "true", commit, sync, restart.
   ```
2. Enable the backup provider per Option A.
3. After the quota window resets or backup carries the load, flip
   `CHATBOT_FALLBACK_ENABLED` back to `"false"`.

### Option D — local-only failover (network isolation)

If the hospital network is isolated from the internet (e.g. mTLS gate
blocks outbound to LLM providers), run a local Llama via an Ollama
`Deployment` in namespace `vhhealth-platform`:

1. Ensure Ollama is installed (see `infra/kubernetes/base/ollama/` —
   planned for batch 17; manifests not yet committed).
2. Update the chatbot secret:
   ```yaml
   CHATBOT_PROVIDER: "llama-local"
   CHATBOT_BASE_URL: "http://ollama.vhhealth-platform.svc.cluster.local:11434"
   CHATBOT_MODEL: "llama3.1-8b-instruct"
   CHATBOT_API_KEY: "<local-service-token>"
   ```
3. Commit, sync, restart, smoke-test.

Response quality degrades vs cloud providers — patient-facing banner
should add "Using on-premise AI" notice.

## Verify recovery

```bash
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health/metrics | jq .chatbot
# Expected: { "ok": true, "provider": "openai", "latencyMs": <2000 }

ADMIN_JWT=<admin-jwt>
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
    http://localhost:5000/api/v1/admin/chatbot/stats?window=1h | jq
# Error rate should be dropping; provider field should reflect the new one.
```

## Post-incident

- [ ] Document the switch in `docs/incidents/chatbot-provider-YYYYMMDD.md`:
      trigger, from-provider, to-provider, duration, patient sessions
      affected.
- [ ] If the switch was for a paid-tier SLA breach, file the SLA credit
      claim with the provider.
- [ ] If the fallback banner was on for > 15 minutes, post a note to
      `#vhhealth-ops` so support knows why patients may have gotten
      "I can't answer that" responses.
- [ ] Confirm ArgoCD shows `vhhealth-backend` Healthy + Synced after
      the rotation lands.
