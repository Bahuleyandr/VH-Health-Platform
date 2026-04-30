# vh-mcp-postgres

Streamable-HTTP MCP server exposing **three read-only purpose-built diagnostic
tools** backed by hard-coded SQL against the VH-Health Postgres. Not a generic
Postgres MCP — there is no `query` tool and no SQL injection surface.

Deployed on Dalekdefender k3s; reachable from Anthropic's cloud routines via
Tailscale Funnel.

## Tools

| Tool | Purpose |
|---|---|
| `phi_backfill_status` | Counts of unencrypted PHI rows per shadow column (Phase E3 follow-up). |
| `error_patterns` | Top status_code≥500 patterns from `audit_log` over last N days. |
| `new_error_patterns` | Patterns seen in last 14 days but NOT in 14-28 days ago. |

## Deploy on Dalekdefender

```bash
ssh dalekdefender 'cd ~/VH-Health-Platform && git pull'

# 1. Build the image on the host (k3s containerd consumes from docker via save/import)
ssh dalekdefender 'cd ~/VH-Health-Platform/infra/mcp/vh-mcp-postgres && \
  sudo -n docker build -t vh-mcp-postgres:dev . && \
  sudo -n docker save vh-mcp-postgres:dev | sudo -n k3s ctr images import -'

# 2. Create the Secret with bearer token + DATABASE_URL.
#    Re-run with --dry-run -o yaml | kubectl apply to rotate.
TOKEN="$(openssl rand -base64 32 | tr -d '=/+\\n' | head -c 48)"
PG_PASSWORD="$(ssh dalekdefender 'sudo -n kubectl -n vhhealth get secret vhhealth-postgres -o jsonpath={.data.password} | base64 -d')"
ssh dalekdefender "sudo -n kubectl -n vhhealth create secret generic vh-mcp-postgres \
  --from-literal=bearer_token='${TOKEN}' \
  --from-literal=database_url='postgresql://vhhealth:${PG_PASSWORD}@vhhealth-postgres:5432/vhhealth' \
  --dry-run=client -o yaml | sudo -n kubectl apply -f -"

# 3. Apply the Deployment + Service
ssh dalekdefender 'sudo -n kubectl -n vhhealth apply -f ~/VH-Health-Platform/infra/mcp/vh-mcp-postgres/k8s.yaml'

# 4. Wait for readiness
ssh dalekdefender 'sudo -n kubectl -n vhhealth rollout status deploy/vh-mcp-postgres --timeout=60s'

# 5. Funnel to public internet on port 10000 (Tailscale-allowed Funnel port)
ssh dalekdefender 'sudo -n tailscale funnel --bg --https=10000 http://localhost:30092'
```

Public URL after step 5:
```
https://dalekdefender.hippocampus-monitor.ts.net:10000/mcp
```

## Test

```bash
# Health (no auth)
curl https://dalekdefender.hippocampus-monitor.ts.net:10000/health

# MCP initialize (with auth)
curl -X POST https://dalekdefender.hippocampus-monitor.ts.net:10000/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## Add as a connector

1. Visit https://claude.ai/customize/connectors
2. Add a custom MCP server with:
   - URL: `https://dalekdefender.hippocampus-monitor.ts.net:10000/mcp`
   - Authentication: Bearer token (paste the value from `vh-mcp-postgres` secret)
3. Once added, the routines `feat/dalek-mcp-postgres-server` updates can attach
   it via `mcp_connections` in the routine config.

## Rotate the bearer token

```bash
NEW_TOKEN="$(openssl rand -base64 32 | tr -d '=/+\\n' | head -c 48)"
ssh dalekdefender "sudo -n kubectl -n vhhealth patch secret vh-mcp-postgres \
  --type merge -p '{\"data\":{\"bearer_token\":\"$(echo -n $NEW_TOKEN | base64)\"}}'  && \
  sudo -n kubectl -n vhhealth rollout restart deploy/vh-mcp-postgres"
```

Then re-add the connector at claude.ai/customize/connectors with the new token.

## Take it down (security tear-down)

```bash
ssh dalekdefender 'sudo -n tailscale funnel --https=10000 off && \
  sudo -n kubectl -n vhhealth delete deployment vh-mcp-postgres && \
  sudo -n kubectl -n vhhealth delete service vh-mcp-postgres && \
  sudo -n kubectl -n vhhealth delete secret vh-mcp-postgres'
```

## Security notes

- Three hard-coded queries — no general SELECT, no parameterised user input
  reaches the DB beyond ints (days / limit) for `error_patterns`.
- Bearer token is the only auth. Tailscale Funnel terminates TLS with a public
  cert; the bearer token is the gate.
- The DB user used by `DATABASE_URL` should ideally be a SELECT-only role on
  `users`, `medical_records`, `audit_log`. Current setup uses the default
  `vhhealth` superuser; harden by creating a dedicated `mcp_reader` role.
- This server runs on the Dalekdefender **dev/test** rig — the data is
  test fixtures, not production PHI. Re-evaluate before pointing at prod.
