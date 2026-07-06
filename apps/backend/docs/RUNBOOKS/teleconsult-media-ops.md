# Teleconsult Media Ops Runbook

Status: NL-3 P4 operational wrap-up is in review. LiveKit deploy is still
HELD. Recording remains OFF. Teleconsult appointments remain ordinary
doctor/department queue items with badges.

## Scope

Use this runbook for:

- TURN, firewall, or media-edge failures after the self-hosted LiveKit bundle is
  explicitly activated.
- The manual two-device teleconsult media smoke.
- Future LiveKit activation steps for the held manifest bundle.

Do not use this runbook to:

- Enable LiveKit Cloud or any third-party SFU/TURN relay for PHI media.
- Deploy LiveKit Egress, Jibri, FFmpeg, or any recorder.
- Add a dedicated teleconsult queue kind.

## Symptoms

- Admin teleconsult ops panel shows rising join failures.
- WSS/signaling connects, but patient or clinician video/audio never starts.
- Media works on hospital LAN but fails on mobile data or a restrictive network.
- TURN usage is unexpectedly zero during restrictive-network tests.
- TURN usage spikes to all sessions after a firewall or L4 change.
- Patients fall back to audio-only or secure messaging more than expected.

## Prerequisites

- Current kube context points to the target RKE2 cluster.
- Access to `vhhealth`, `vhhealth-platform`, and `vhhealth-telemedicine`
  namespaces.
- A synthetic TELE appointment and test patient/clinician users. Do not use real
  patient names, diagnoses, notes, or production PHI in smoke evidence.
- Backend telemetry access for `/metrics` and the admin teleconsult ops panel.
- If running local smoke from Codex, write evidence under
  `D:\Dev\_codex\artifacts\logs\YYYY-MM-DD\`.

## Immediate Guardrails

1. Confirm whether media deploy is still held:

   ```bash
   grep -R "telemedicine" infra/kubernetes/base/kustomization.yaml infra/kubernetes/overlays/*/kustomization.yaml
   ```

   Expected for the held state: no root or overlay includes
   `infra/kubernetes/base/telemedicine`.

2. Confirm recording is not deployed:

   ```bash
   kubectl -n vhhealth-telemedicine get deploy,ds,sts | grep -Ei "egress|record|jibri|ffmpeg" || true
   ```

   Expected: no recorder workloads.

3. Confirm backend feature flag state:

   ```bash
   kubectl -n vhhealth get deploy backend -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LIVEKIT_ENABLED")].value}{"\n"}'
   ```

   Expected before activation: `false` or unset.

## TURN and Firewall Failure Triage

1. Check application telemetry first:

   ```bash
   curl -fsS https://api.vhhealth.app/metrics | grep -E "teleconsult_ops_(join_failure|turn_session|turn_usage|active|waiting)"
   ```

   If join failures are rising while active/waiting counts are normal, suspect
   token, signaling, or media-edge reachability. If TURN usage is zero on a
   restrictive network, suspect TURN DNS/firewall/certificate routing.

2. Check LiveKit workload health after activation:

   ```bash
   kubectl -n vhhealth-telemedicine get pods,svc,ingress,endpoints
   kubectl -n vhhealth-telemedicine logs deploy/livekit --tail=200 | grep -Ei "turn|ice|rtc|udp|tcp|failed|error"
   ```

   No pods means the deploy is still held or activation was rolled back.

3. Check signaling DNS and TLS:

   ```bash
   nslookup teleconsult.vhhealth.app
   curl -vk https://teleconsult.vhhealth.app/
   ```

   HTTPS/WSS signaling can use the existing ingress/Tunnel path. Passing this
   step does not prove media works.

4. Check TURN DNS and TCP/TLS reachability from outside the hospital network:

   ```powershell
   Resolve-DnsName turn.teleconsult.vhhealth.app
   Test-NetConnection turn.teleconsult.vhhealth.app -Port 5349
   ```

   UDP TURN and RTC UDP require firewall/L4 evidence; use network firewall logs,
   LiveKit logs, and the two-device smoke rather than assuming TCP success proves
   UDP success.

5. Check approved media ports against the held config:

   ```bash
   grep -nE "tcp_port|port_range_start|port_range_end|udp_port|tls_port" infra/kubernetes/base/telemedicine/livekit-config.yaml
   ```

   Current held defaults:

   - LiveKit TCP fallback: `7881`.
   - RTC UDP range: `50000-50100`.
   - Embedded TURN UDP: `3478`.
   - Embedded TURN/TLS: `5349`.

6. Classify the failure:

   - DNS/TLS: name does not resolve, wrong certificate, or ingress 404/502.
   - Signaling: token accepted but WSS cannot connect.
   - Direct media: LAN works, outside network cannot send UDP/TCP media.
   - TURN relay: restrictive network cannot relay, or TURN usage never appears.
   - Backend token: token TTL, room grant, tenant, consent, or appointment status
     failure.

7. Mitigate safely:

   - Keep `LIVEKIT_ENABLED=false` if activation gates are not satisfied.
   - Route active patients to audio-only, secure messaging fallback, reschedule,
     or in-person conversion according to clinical safety.
   - Do not add third-party relay credentials.
   - Do not enable recording or recorder workloads.

## Manual Two-Device Media Smoke

Generate tokens for a synthetic TELE appointment:

```bash
cd apps/backend
TELECONSULT_SMOKE_CONFIRM=I_UNDERSTAND_THIS_WRITES_FIXTURES \
LIVEKIT_ENABLED=true \
LIVEKIT_SERVER_URL=https://teleconsult.vhhealth.app \
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
DATABASE_URL=... \
node scripts/smoke-teleconsult-token.mjs \
  --tenant-id=<uuid> \
  --appointment-id=<tele-appointment-id> \
  --json
```

Open `apps/backend/scripts/teleconsult-smoke-join.html` on both devices, using a
hospital-hosted or locally approved LiveKit browser SDK. Paste one patient token
on the patient device and one clinician token on the clinician device. Never
paste tokens into tickets or chat.

Spec section 9 checklist, verbatim:

- Two devices on different networks, including one outside the hospital network.
- Patient lobby consent and join.
- Clinician join.
- Video and audio success.
- TURN path verified on a restrictive network or mobile data.
- Deliberate degradation to audio-only and secure messaging.
- OP note creation/signing through existing flow.
- Patient portal visibility of only the signed appointment-bound note.
- e-Rx and payment-link workflow checked if applicable.

Close the smoke only after the admin teleconsult ops panel reflects the expected
join result, final modality, TURN usage, and consent-recorded state without PHI
in telemetry.

## LiveKit Activation Steps - Still Held

These are the operator steps for a later activation change. Do not execute them
from the NL-3 P4 PR.

1. Confirm owner approvals:

   - Hospital-owned L4/public-IP path approved for RTC UDP/TCP.
   - Embedded TURN UDP/TLS ports approved.
   - `teleconsult.vhhealth.app` approved for signaling.
   - `turn.teleconsult.vhhealth.app` certificate issued and sealed.
   - Backend LiveKit API key/secret sealed.
   - Manual smoke window scheduled with clinical and network owners.

2. Render the held bundle:

   ```bash
   kubectl kustomize infra/kubernetes/base/telemedicine > /tmp/livekit-held-render.yaml
   ```

3. Validate server-side without applying:

   ```bash
   kubectl apply --dry-run=server -f /tmp/livekit-held-render.yaml
   ```

4. Apply only during the approved activation window:

   ```bash
   kubectl apply -f /tmp/livekit-held-render.yaml
   ```

5. Patch backend secrets/env in the same change window:

   - `LIVEKIT_ENABLED=true`
   - `LIVEKIT_SERVER_URL=https://teleconsult.vhhealth.app`
   - `LIVEKIT_API_KEY=<sealed>`
   - `LIVEKIT_API_SECRET=<sealed>`

6. Run the manual two-device media smoke above.

7. After smoke passes, wire `infra/kubernetes/base/telemedicine` into the
   relevant environment overlay in a separate deployment PR. Keep recorder
   workloads absent.

## Verify Recovery

- `teleconsult_ops_join_failure_count` stops increasing for new sessions.
- `teleconsult_ops_turn_usage_rate_pct` matches the restrictive-network test.
- Active/waiting counts on the admin panel match synthetic consult state.
- Final modality distribution records video, audio-only, or secure messaging
  truthfully.
- Recording remains disabled in tokens, `video_sessions.recording_status`, and
  Kubernetes workloads.

## Post-Incident

- Attach non-PHI smoke evidence and metric snapshots to the incident.
- Record which firewall/L4/DNS change fixed or caused the issue.
- File follow-up work for any missing alert, dashboard field, or runbook step.
- If a token, URL, or room name leaked outside the smoke evidence store, rotate
  the LiveKit API secret before the next activation attempt.
