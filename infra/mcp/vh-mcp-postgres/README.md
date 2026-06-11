# vh-mcp-postgres

Streamable-HTTP MCP server exposing **three read-only purpose-built diagnostic
tools** backed by hard-coded SQL against the VH-Health Postgres. Not a generic
Postgres MCP — there is no `query` tool and no SQL injection surface.

Deployed on Dalekdefender k3s. The Kubernetes Service is ClusterIP with
default-deny pod ingress; expose it only through an API-server port-forward
or equivalent operator-controlled tunnel.

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

# 2. Create a dedicated read-only login role. The server refuses superuser or
#    BYPASSRLS roles at startup in production.
READONLY_PASSWORD="$(openssl rand -base64 32 | tr -d '\n')"
ssh dalekdefender "sudo -n kubectl -n vhhealth exec deploy/vhhealth-backend -- \
  psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 <<SQL
DO \\\$\\\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vhhealth_mcp_reader') THEN
    CREATE ROLE vhhealth_mcp_reader LOGIN PASSWORD '${READONLY_PASSWORD}';
  ELSE
    ALTER ROLE vhhealth_mcp_reader PASSWORD '${READONLY_PASSWORD}';
  END IF;
END \\\$\\\$;
ALTER ROLE vhhealth_mcp_reader NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE vhhealth TO vhhealth_mcp_reader;
GRANT USAGE ON SCHEMA public TO vhhealth_mcp_reader;
GRANT SELECT ON users, medical_records, audit_log TO vhhealth_mcp_reader;
SQL"

# 3. Create the Secret with bearer token + read-only DATABASE_URL.
#    Re-run with --dry-run -o yaml | kubectl apply to rotate.
TOKEN="$(openssl rand -base64 32 | tr -d '=/+\\n' | head -c 48)"
ssh dalekdefender "sudo -n kubectl -n vhhealth create secret generic vh-mcp-postgres \
  --from-literal=bearer_token='${TOKEN}' \
  --from-literal=database_url='postgresql://vhhealth_mcp_reader:${READONLY_PASSWORD}@vhhealth-postgres:5432/vhhealth' \
  --dry-run=client -o yaml | sudo -n kubectl apply -f -"

# 4. Apply the Deployment + Service
ssh dalekdefender 'sudo -n kubectl -n vhhealth apply -f ~/VH-Health-Platform/infra/mcp/vh-mcp-postgres/k8s.yaml'

# 5. Wait for readiness
ssh dalekdefender 'sudo -n kubectl -n vhhealth rollout status deploy/vh-mcp-postgres --timeout=60s'

# 6. Expose through an operator-controlled API-server port-forward, then point
#    Tailscale Funnel at the local forwarded port.
ssh dalekdefender 'sudo -n kubectl -n vhhealth port-forward svc/vh-mcp-postgres 10000:8080'
# In a separate managed service/session on the host:
ssh dalekdefender 'sudo -n tailscale funnel --bg --https=10000 http://localhost:10000'
```

Public URL after step 6:
```
https://dalekdefender.hippocampus-monitor.ts.net:10000/mcp
```

## Test

```bash
# Health (no auth; readiness only)
curl https://dalekdefender.hippocampus-monitor.ts.net:10000/health

# MCP initialize (Authorization header required; query-string tokens are rejected)
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
  cert; the bearer token is the gate. Tokens in `?token=` are intentionally not
  accepted because proxy/Funnel/request logs can retain URLs.
- The DB user used by `DATABASE_URL` must be a SELECT-only role on
  `users`, `medical_records`, `audit_log`. The server exits in production if
  the role is superuser or has BYPASSRLS.
- This server runs on the Dalekdefender **dev/test** rig — the data is
  test fixtures, not production PHI. Re-evaluate before pointing at prod.
