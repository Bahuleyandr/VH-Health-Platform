# VH Health device gateway

Held ingress for hospital-side devices: MLLP/HL7v2 bedside monitors (NL-7,
interface family I09), the opt-in cold-chain HTTP relay, and the LIS analyzer
transport. Everything received is durably spooled to local disk BEFORE any
protocol acknowledgement, then drained to the backend with at-least-once
delivery — a backend outage buffers locally and replays on recovery.

## Runtime surfaces

| Surface | Default | Enabled by |
|---|---|---|
| Bedside MLLP listeners | port 2575 | `DEVICE_GATEWAY_LISTENERS` |
| Prometheus metrics + `/readyz` | port 9108 | always on (`DEVICE_GATEWAY_METRICS_PORT`) |
| Cold-chain HTTP ingest | **off** | `DEVICE_GATEWAY_COLD_CHAIN_PORT` |
| LIS analyzer listeners | **off** | `DEVICE_GATEWAY_LIS_LISTENERS` |

## LIS analyzer transport (ships dark)

TCP listener profiles that let lab analyzers stream results straight into the
backend's lab closed loop (specimen linkage, delta checks, critical alerts)
with no middleware PC. Two protocols per listener:

- `astm-e1394` — ASTM E1381/LIS1-A framing (ENQ handshake, STX frames with
  checksum verification and ACK/NAK, EOT) carrying ASTM E1394 / LIS2-A2
  records (`src/astmFrameReader.js` + the session in `src/lisTransport.js`).
  Assembled messages are forwarded to `POST /api/v1/lab/interface/ingest` as
  `{ protocol: 'astm_e1394', message, analyzer_code }`.
- `mllp-hl7v2` — MLLP-framed HL7v2 ORU, forwarded to
  `POST /api/v1/lab/oru/ingest` as `{ message }`.

Configuration is one env var holding a JSON array — absent means the feature
is fully dark (no open ports, no timers):

```bash
DEVICE_GATEWAY_LIS_LISTENERS='[
  {"name":"chem1","port":3101,"protocol":"astm-e1394","tenant_slug":"vh-main","analyzer_code":"BS-240",
   "token_env":"LIS_CHEM1_TOKEN","allowed_source_ips":["10.20.0.41"]},
  {"name":"hema1","port":3102,"protocol":"mllp-hl7v2","tenant_slug":"vh-main","analyzer_code":"XN-1000",
   "token_env":"LIS_HEMA1_TOKEN"}
]'
LIS_CHEM1_TOKEN=<tenant-bound machine JWT with a lab-interface ingest role>
LIS_HEMA1_TOKEN=<same, may differ per analyzer>
```

In Kubernetes, add every named `LIS_*_TOKEN` key to the operator-managed
`device-gateway-secret` (use the adjacent SealedSecret example). The Deployment
projects those dynamic keys into the gateway container, while retaining the
explicit `backend-token` and `api-key` mappings. The Secret is loaded before
`device-gateway-config`, so a Secret key cannot replace the authoritative
non-secret listener profiles. With the committed `[]` profile list, no LIS
listener opens even when token keys exist.

Per-listener fields: `name` (unique), `port`, optional `host` (default
`0.0.0.0`), `protocol`, `tenant_slug` (non-secret deployment metadata used
only to correlate the admin gate; never trusted for authorization),
`analyzer_code` (the backend `lab_analyzers` code),
`token_env` (the NAME of the env var holding that analyzer's backend bearer
token, matching `^LIS_[A-Z][A-Z0-9_]*_TOKEN$`, so the JSON never contains
credential material or aliases a global gateway credential), optional
`allowed_source_ips`, optional `max_message_bytes` (default 1 MiB). The
bearer token is a tenant-bound machine JWT (role `DEVICE_GATEWAY` /
`WEBHOOK_CLIENT` or a lab staff role) — the backend derives tenant identity
from the token and fails closed, the gateway never asserts a tenant itself.
The gateway `x-api-key` (`DEVICE_GATEWAY_API_KEY`/`API_KEY`) and
`BACKEND_BASE_URL` are shared with the vitals path.

Durability: each complete message is appended to a per-listener NDJSON spool
under `$DEVICE_GATEWAY_SPOOL_DIR/lis/` before the final protocol ACK (the
ETX-frame ACK for ASTM, the `MSA|AA` for MLLP). A failed append answers NAK /
`AE`, so the analyzer retransmits. The supervised drain posts spooled entries
to the backend in order: definite 4xx dead-letters with evidence, 401/403
(credential rotation) and 5xx/timeouts retry forever, spools left by a
previous process are discovered and drained on startup.

**No physical serial support.** Analyzers that only speak RS-232 attach
through a serial-to-TCP adapter (e.g. a Moxa NPort / USR-TCP232 class device
server) configured in TCP-client or TCP-server mode and pointed at that
analyzer's `astm-e1394` listener port; the adapter carries bytes verbatim and
the gateway runs the same ASTM handshake over the resulting socket. Buy one
adapter per serial analyzer — the gateway deliberately contains no tty
handling, so go-live for a serial analyzer is cabling plus one listener entry
here, not a software project.

## Commands

```bash
npm ci
npm test         # jest, --runInBand
npm run lint     # node --check over src/tests/scripts
npm run soak:replay
```
