# Runbook — Chatbot provider switch

**Severity:** P2 (feature degraded) / P1 (paid-tier SLA breach)

The symptom-checker / patient chatbot uses a pluggable LLM provider
configured via `CHATBOT_*` env vars (see `.env.example`). When the
primary provider has an outage, key rotation, or quota exhaustion,
flip to the backup provider via env vars — no code change / deploy
needed.

## Symptoms

- Patient app: "Sorry, I can't help right now" banner on symptom checker
- Admin portal notification drawer: `ChatbotFallbackRate` tile spikes
- Backend logs: `Chatbot provider <name> returned <status>` with retry count exhausted
- Sentry: `ChatbotProviderError` breadcrumbs trending up

## Prerequisites

- Root SSH on the API host.
- Backup provider API key ready (stored in the secrets locker alongside
  the primary).
- 30 seconds of downtime-acceptable window (restart is non-blocking).

## Mental model — env vars

```
CHATBOT_PROVIDER       — "anthropic" | "openai" | "gemini" | "llama-local"
CHATBOT_BASE_URL       — override endpoint (for Azure OpenAI, custom gateways)
CHATBOT_MODEL          — model ID (e.g. "claude-3-5-sonnet", "gpt-4o-mini")
CHATBOT_API_KEY        — provider credential
CHATBOT_FALLBACK_ENABLED — if "true", on provider error the backend returns a
                          canned conservative response instead of propagating the error
```

Adherence-risk ONNX + chatbot are intentionally decoupled; this only
touches the chatbot path.

## Response

### Option A — provider outage (full switch)

1. Confirm the primary is actually down (not just rate-limited):
   ```bash
   $ curl -s -X POST https://api.anthropic.com/v1/messages \
       -H "x-api-key: $OLD_KEY" -H "anthropic-version: 2023-06-01" \
       -H "content-type: application/json" \
       -d '{"model":"claude-3-5-haiku-20241022","max_tokens":10,"messages":[{"role":"user","content":"ping"}]}' \
       -w '\nHTTP %{http_code}\n'
   ```
   If 5xx / timeout → provider outage. If 401 → key problem (skip to
   §Option B). If 429 → quota / rate limit (skip to §Option C).

2. Flip env vars to backup provider:
   ```bash
   $ sudo nano /srv/vhhealth/.env.local
   # Change:
   #   CHATBOT_PROVIDER=anthropic       →  openai
   #   CHATBOT_BASE_URL=https://api.anthropic.com/v1  →  https://api.openai.com/v1
   #   CHATBOT_MODEL=claude-3-5-sonnet  →  gpt-4o-mini
   #   CHATBOT_API_KEY=<anthropic-key>  →  <openai-key>
   ```

3. Restart the API:
   ```bash
   $ sudo systemctl restart vhhealth-backend.service
   ```

4. Smoke-test:
   ```bash
   $ curl -s -X POST http://localhost:5000/api/v1/chatbot/symptom-check \
       -H "Authorization: Bearer $JWT" -H "x-api-key: $API_KEY_PATIENT" \
       -H "Content-Type: application/json" \
       -d '{"symptom":"headache for 2 days","context":{"age":35}}' | jq .data.response
   # Expected: a non-empty response string + provider field === "openai"
   ```

5. Update the in-flight patient session banner:
   ```bash
   [backend] $ node scripts/flush-chatbot-cache.js
   # Clears stale response cache so follow-up prompts re-hit the new provider
   ```

### Option B — key rotation (same provider)

1. Generate / retrieve new key from provider console.
2. Update `CHATBOT_API_KEY`:
   ```bash
   $ sudo sed -i "s|^CHATBOT_API_KEY=.*|CHATBOT_API_KEY=$NEW_KEY|" /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```
3. Smoke-test as in Option A §4.
4. Revoke the old key in the provider console.

### Option C — quota exhaustion (temporary)

1. Enable the graceful-fallback flag so patients see a canned safe
   response instead of errors:
   ```bash
   $ sudo sed -i "s|^CHATBOT_FALLBACK_ENABLED=.*|CHATBOT_FALLBACK_ENABLED=true|" /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```
2. Enable the backup provider per Option A.
3. After the quota window resets or backup carries the load:
   ```bash
   $ sudo sed -i "s|^CHATBOT_FALLBACK_ENABLED=.*|CHATBOT_FALLBACK_ENABLED=false|" /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```

### Option D — local-only failover (network isolation)

If the hospital network is isolated from the internet (e.g. mTLS gate
blocks outbound to LLM providers), run a local Llama model:

1. Start the local provider (assumes it's already installed — see
   [`docs/CHATBOT-LOCAL-SETUP.md`](../CHATBOT-LOCAL-SETUP.md) — TODO: write).
2. Update env:
   ```
   CHATBOT_PROVIDER=llama-local
   CHATBOT_BASE_URL=http://localhost:11434
   CHATBOT_MODEL=llama3.1-8b-instruct
   CHATBOT_API_KEY=<local-service-token>
   ```
3. Restart + smoke-test.

Response quality degrades vs cloud providers — patient-facing banner
should add "Using on-premise AI" notice.

## Verify recovery

```bash
$ curl -s http://localhost:5000/health/metrics | jq .chatbot
# Expected: { "ok": true, "provider": "openai", "latencyMs": <2000 }

$ curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $ADMIN_JWT" \
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
- [ ] Confirm the next scheduled config-sync job (`npm run config:sync`)
      propagates the new `.env.local` to any hot-standby API hosts.
