# Runbook - Device Gateway Activation Checklist

> NL-7 deploy remains held until the operator deliberately flips these items.
> Complete this checklist in order for each pilot ward or unit.

## Prerequisites

- Hospital IT has approved the device VLAN to cluster VLAN firewall rule.
- Device registry rows exist with source IPs or bearer credentials.
- A DEVICE_GATEWAY service credential exists in `device-gateway-secret`.
- Staff have rehearsed scan-based device-to-patient association.
- ADT-driven association assist remains disabled unless the pilot proves bed-data
  trust and a governance flag is approved. The safe default is scan/manual
  association plus ADT auto-end on transfer or discharge.
- RTLS remains contract-only unless a named vendor pilot is approved in the playbook decision log.

## 1. Render the Held Manifests

```bash
kustomize build infra/kubernetes/base/device-gateway
kustomize build infra/kubernetes/base/monitoring
```

## 2. Flip the Base Kustomization

Add `device-gateway` to `infra/kubernetes/base/kustomization.yaml` resources.
Keep it out of environment overlays until the pilot window is staffed.

```bash
git diff -- infra/kubernetes/base/kustomization.yaml infra/kubernetes/base/device-gateway
```

## 3. Patch Network Exposure for the Pilot

The base service is ClusterIP. For a real monitor VLAN pilot, patch the service
in the environment overlay to `type: NodePort` and pin the approved port.

```bash
kubectl -n vhhealth get svc device-gateway -o wide
kubectl -n vhhealth get networkpolicy device-gateway -o yaml
```

## 4. Apply and Wait for Readiness

```bash
kubectl -n vhhealth apply -k infra/kubernetes/base/device-gateway
kubectl -n vhhealth rollout status deployment/device-gateway
kubectl -n vhhealth get pods -l app.kubernetes.io/name=device-gateway
```

## 5. Verify Metrics and Alerts

```bash
kubectl -n vhhealth port-forward svc/device-gateway 9108:9108
curl -fsS http://127.0.0.1:9108/metrics | grep -E 'mllp_connections_active|mllp_messages_received_total|gateway_spool_depth|gateway_spool_oldest_age_seconds|gateway_forward_failures_total|gateway_dead_letter_total'
kubectl -n vhhealth-monitoring get prometheusrule vhhealth-device-gateway-alerts
```

## 6. Run the Synthetic Soak Replay

```bash
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- node scripts/soak-replay.mjs --cycles=250 --duplicate-every=25
```

Do not open the live monitor feed unless accepted equals ingested and duplicate
ACKs are non-zero.

## 7. Open One Feed and Watch

```bash
kubectl -n vhhealth logs deployment/device-gateway -c device-gateway --since=15m
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT analyzer_code, status, error, created_at FROM lab_interface_messages WHERE message_type = 'ORU^VITALS' ORDER BY id DESC LIMIT 20;"
```

Rollback is to close the device VLAN firewall rule and remove `device-gateway`
from the kustomization. Do not delete the spool PVC until the coordinator has
confirmed there are no undrained accepted frames.
