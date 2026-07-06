# NL-3 Teleconsultation LiveKit Manifests

This directory is a held P1 ops bundle for self-hosted LiveKit. It is not listed
from `infra/kubernetes/base/kustomization.yaml`, so it will not deploy through
the normal overlays until owners explicitly wire it in.

Activation gates:

- Hospital-owned L4/public-IP media edge approved for RTC UDP/TCP and embedded
  TURN ports.
- `teleconsult.vhhealth.app` approved for HTTPS/WSS signaling only.
- `turn.teleconsult.vhhealth.app` certificate sealed in `livekit-secret`.
- Backend env sealed with matching `LIVEKIT_SERVER_URL`, `LIVEKIT_API_KEY`, and
  `LIVEKIT_API_SECRET`, then `LIVEKIT_ENABLED=true`.
- Manual two-device smoke completed from hospital LAN and mobile/restrictive
  network.

P1 intentionally does not deploy LiveKit Egress, coturn, Jibri, FFmpeg, or any
other recorder. Recording grants must remain absent from backend-issued tokens,
and `video_sessions.recording_status` remains `disabled`.

Embedded TURN is configured first. If ops later wants a DMZ TURN tier, add a
separate coturn bundle and keep it hospital-operated; do not configure LiveKit
Cloud or third-party TURN/SFU credentials.

The one-replica Deployment is for the first manual smoke. A later production
rollout can replace it with a host-networked DaemonSet or node-pinned topology
after the L4 edge and firewall model is approved.
