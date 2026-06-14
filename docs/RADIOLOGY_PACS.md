# RADIOLOGY PACS Runbook — VH Health Platform

Roadmap: WS4 B4.4 / Epic B4 (infra portion)
Status: manifests merged; **OPERATOR-GATED before first sync** (see checklist below)

---

## 1. Architecture

```
Hospital LAN
│
├─ Modalities (CT, MRI, X-Ray)
│   └─ DICOM C-STORE / C-MOVE ──────────────────► Orthanc :4242
│                                                  (AET: VHHEALTH)
│
├─ Staff workstations / ward PCs
│   └─ HTTPS ──────────────────────────────────► OHIF Viewer
│          imaging.vhhealth.hospital.local           (nginx-internal ingress)
│                                                      │
│                                         DICOMweb ◄──┘
│                                     http://orthanc:8042/dicom-web
│
└─ VH Health backend (in-cluster)
    └─ DICOMweb (query/retrieve) ───────────────► Orthanc :8042
       POST /api/v1/pacs/orders/:id/link-study        (NetworkPolicy allow)
```

### Component overview

| Component | Kind | Image | Port | Namespace |
|---|---|---|---|---|
| Orthanc PACS | StatefulSet | `orthancteam/orthanc:24.10.1` | 4242 (DICOM), 8042 (DICOMweb/HTTP) | `vhhealth` |
| OHIF Viewer | Deployment | `ohif/app:v3.9.2` | 80 (HTTP, cluster-internal) | `vhhealth` |
| OHIF Ingress | Ingress | — | 443 (HTTPS, LAN-only) | `vhhealth` |

### Storage

- Orthanc study data: PVC `storage-orthanc-0`, 500 Gi, `ReadWriteOnce`
  - Default storageClass: cluster default (`local-path` on single-node, NOT replicated)
  - **Recommended**: un-comment `storageClassName: longhorn` in `orthanc.yaml`
    after INF-5/B2.6 Longhorn pre-install is complete (3-replica block storage)
- Worklist files: `emptyDir` (runtime only; populated by the worklist sidecar pattern —
  see Section 4)

### Network security

All pods operate under the repo-wide default-deny NetworkPolicy baseline
(see `base/_common/network-policies.yaml`). PACS-specific allows:

| Source | Destination | Port | Policy name |
|---|---|---|---|
| backend pods (vhhealth-platform ns) | Orthanc | 8042/TCP | `orthanc-ingress` |
| Imaging modality VLAN (CIDR placeholder) | Orthanc | 4242/TCP | `orthanc-ingress` |
| OHIF pod | Orthanc | 8042/TCP | `orthanc-ingress` |
| nginx-internal ingress-controller | OHIF | 80/TCP | `ohif-viewer` |
| Orthanc pod | kube-dns | 53/UDP+TCP | `orthanc-egress` |
| OHIF pod | kube-dns | 53/UDP+TCP | `ohif-viewer` |
| OHIF pod | Orthanc | 8042/TCP | `ohif-viewer` |

---

## 2. Enabling the PACS stack (operator checklist)

Complete every item before adding the pacs module to a prod overlay or applying
`argocd-pacs-app.yaml`.

### 2.1 Storage sizing

```
# Estimate: CT ≈ 0.5 GB/study, X-Ray ≈ 10–50 MB/image.
# Size the PVC for your retention target (e.g. 3 months of daily CTs).
# Edit infra/kubernetes/optional/pacs/orthanc.yaml:
#   volumeClaimTemplates[0].spec.resources.requests.storage: 2Ti  # example
```

If Longhorn is available (INF-5/B2.6 complete), un-comment
`storageClassName: longhorn` in the same block to get 3-replica redundancy.

### 2.2 Seal the admin credentials SealedSecret

```bash
# 1. Generate a strong password
PW="$(openssl rand -base64 32)"

# 2. Create the plaintext Secret locally (DO NOT COMMIT this file)
cat > /tmp/orthanc-users.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: orthanc-users
  namespace: vhhealth
type: Opaque
stringData:
  registered_users_json: '{"vhhealth-admin": "$PW", "ohif-reader": "CHANGE_ME_READER_PW"}'
EOF

# 3. Seal it with kubeseal (controller lives in vhhealth-security)
kubeseal \
  --controller-namespace vhhealth-security \
  --controller-name sealed-secrets \
  --format yaml \
  < /tmp/orthanc-users.yaml \
  > infra/kubernetes/optional/pacs/registered-users.sealed-secret.yaml

# 4. Un-comment the resource line in optional/pacs/kustomization.yaml:
#    - registered-users.sealed-secret.yaml

# 5. Commit the sealed file, delete the plaintext
rm /tmp/orthanc-users.yaml
git add infra/kubernetes/optional/pacs/registered-users.sealed-secret.yaml
```

**Record the passwords in the hospital credential vault** (Vault/KeePass) before
deleting the plaintext. The OHIF viewer also needs the `ohif-reader` credential to
authenticate against Orthanc's DICOMweb — configure it in the OHIF `app-config.js`
`authentication` block if DICOMweb auth is required (see Orthanc docs).

### 2.3 Modality VLAN network policy

Edit `orthanc-ingress` NetworkPolicy in `orthanc.yaml`:

```yaml
- from:
    - ipBlock:
        cidr: 10.30.40.0/24   # REPLACE with your real imaging VLAN CIDR
  ports:
    - port: 4242
      protocol: TCP
```

Confirm with the hospital network team which VLAN/CIDR the modalities use.

### 2.4 Hostname and TLS

The OHIF ingress defaults to `imaging.vhhealth.hospital.local`. Override per
overlay if the hospital uses a different naming convention:

```yaml
# In overlays/prod/kustomization.yaml patches section:
- target:
    kind: Ingress
    name: ohif-viewer
  patch: |-
    - op: replace
      path: /spec/rules/0/host
      value: imaging.hospital.example.local
    - op: replace
      path: /spec/tls/0/hosts/0
      value: imaging.hospital.example.local
```

Hospital DNS: add an A or CNAME record pointing `imaging.vhhealth.hospital.local`
to the nginx-internal ingress controller's LAN IP (typically a MetalLB or hostNetwork
binding on the private interface).

For staff workstations to trust the TLS certificate without browser warnings,
the step-ca root CA must be imported into Windows/macOS/Linux trust stores on each
workstation (group policy push is recommended). See `base/cert-manager/`.

### 2.5 Pin image digests

Per `SECURITY_HARDENING_CHECKLIST.md`, pin both images with `@sha256:` digests
before first deploy:

```bash
# Fetch digests
docker pull orthancteam/orthanc:24.10.1
docker inspect --format='{{index .RepoDigests 0}}' orthancteam/orthanc:24.10.1

docker pull ohif/app:v3.9.2
docker inspect --format='{{index .RepoDigests 0}}' ohif/app:v3.9.2

# Update optional/pacs/orthanc.yaml and ohif.yaml:
#   image: orthancteam/orthanc:24.10.1@sha256:<DIGEST>
#   image: ohif/app:v3.9.2@sha256:<DIGEST>
```

### 2.6 Enable via GitOps (prod)

Add the module to `overlays/prod/kustomization.yaml`:

```yaml
resources:
  - ../../base
  - ../../optional/pacs
```

Then add `argocd-pacs-app.yaml` to the ArgoCD Application list so it is
GitOps-managed:

```yaml
# In base/argocd/applications/kustomization.yaml:
resources:
  - platform.yaml
  - apps.yaml
  - monitoring.yaml
  - ../../../optional/pacs/argocd-pacs-app.yaml   # add this line
```

Or apply it once manually to bootstrap:

```bash
kubectl apply -f infra/kubernetes/optional/pacs/argocd-pacs-app.yaml
```

After the ArgoCD Application is created, enable automated sync by un-commenting
the `automated:` block in `argocd-pacs-app.yaml` (once the first manual sync
verifies everything is healthy).

---

## 3. Staff and admin access (how to reach OHIF)

### LAN URL

```
https://imaging.vhhealth.hospital.local
```

This resolves on the hospital LAN only (nginx-internal IngressClass). The URL
shows the OHIF study list — staff authenticate with the Orthanc credentials
configured in the SealedSecret.

### Embedding OHIF in the staff app

The backend exposes OHIF deep links via the clinical timeline API. Once the
backend `link-study` endpoint is wired (see Section 5 — flagged follow-up),
the staff Flutter app can open a study via:

```
https://imaging.vhhealth.hospital.local/viewer?StudyInstanceUIDs=<uid>
```

The backend ConfigMap entries that unlock this (set in the overlay or via a
separate ConfigMap patch):

```yaml
PACS_DICOMWEB_URL: "http://orthanc.vhhealth.svc.cluster.local:8042/dicom-web"
PACS_VIEWER_URL:   "https://imaging.vhhealth.hospital.local"
PACS_AET:          "VHHEALTH"
```

---

## 4. DICOM modality worklist (MWL) integration — OPERATOR/HARDWARE-FLAGGED

**This step requires physical access to the imaging modalities and hospital
biomedical/IT engineering. It is NOT automated by this GitOps stack.**

### Conceptual flow

```
Radiology order created in VH Health
         │
         ▼
Backend writes order row + clinical_timeline_events row
         │
         ▼  (future worklist sidecar — not yet implemented)
Worklist .wl file written to orthanc-worklists emptyDir volume
         │
         ▼
Orthanc MWL plugin serves C-FIND MWL responses on port 4242
         │
         ▼
CT scanner / MRI / X-Ray queries AET VHHEALTH for worklist
         │
         ▼
Technician selects worklist entry → exam is performed
         │
         ▼
Scanner C-STOREs DICOM to AET VHHEALTH on port 4242
         │
         ▼
Orthanc OnStableStudy Lua hook → POST /api/v1/pacs/orders/:id/link-study
```

### AE title configuration

| Field | Value |
|---|---|
| Called AE Title (Orthanc) | `VHHEALTH` |
| Orthanc DICOM port | `4242` |
| Orthanc host (in-cluster) | `orthanc.vhhealth.svc.cluster.local` |
| Orthanc host (from LAN, if node-port exposed) | `<k8s-node-LAN-IP>:<NodePort>` |

**Each modality must be configured to point to Orthanc:**

1. On the CT/MRI console, navigate to DICOM Network Configuration.
2. Add a new destination AE:
   - AE Title: `VHHEALTH`
   - Host: `<orthanc-LAN-IP>` (the node IP or LB IP for port 4242)
   - Port: `4242`
3. Add Orthanc as a query/retrieve (C-FIND MWL) target with the same AE settings.
4. Test connectivity:
   ```bash
   # From a DICOM tool on the LAN (storescu / findscu from dcmtk):
   echoscu -v <orthanc-ip> 4242 -aec VHHEALTH
   ```
5. Set up the modality VLAN CIDR in the `orthanc-ingress` NetworkPolicy
   (see Section 2.3) so DICOM traffic from the modalities is permitted.

### Orthanc DicomModalities config

Add each modality to the `DicomModalities` section in `orthanc-config` ConfigMap:

```json
"DicomModalities": {
  "CT01": ["CT01", "<ct-ip>", 104],
  "MRI01": ["MRI01", "<mri-ip>", 104]
}
```

Edit `optional/pacs/orthanc.yaml` ConfigMap, commit, and ArgoCD will sync.

---

## 5. Backup of the Orthanc PVC

The Orthanc PVC (`storage-orthanc-0`) holds all DICOM objects. Two backup
strategies are available:

### 5.1 Longhorn snapshots (recommended when Longhorn is active)

Longhorn automatically snapshots volumes on a configurable schedule. The
`longhorn-s3-secret` in the `longhorn-system` namespace targets the MinIO bucket
`longhorn-backups`. Orthanc PVC backups land there automatically once Longhorn is
configured per `base/longhorn/longhorn-app.yaml`.

```bash
# Trigger a manual snapshot via Longhorn UI or API:
# https://longhorn.vhhealth.hospital.local → Volumes → orthanc-storage-0 → Take Snapshot
```

### 5.2 Orthanc DICOM export (DICOM-level backup, storageClass-independent)

```bash
# Export all studies to a DICOM archive:
# (run from a pod or bastion with access to orthanc.vhhealth.svc:8042)
curl -u vhhealth-admin:<password> \
  http://orthanc.vhhealth.svc.cluster.local:8042/instances \
  | jq -r '.[]' \
  | xargs -I{} curl -u vhhealth-admin:<password> \
      -o /backup/{}.dcm \
      http://orthanc.vhhealth.svc.cluster.local:8042/instances/{}/file
```

For production, prefer a Velero backup of the PVC using the `longhorn` CSI plugin
or a pre/post hook job that quiesces Orthanc before snapshotting.

### 5.3 Retention policy

DICOM objects contain PHI and are subject to the hospital's data-retention policy
(typically 7–10 years for India-based hospitals under IT Act / NABH guidelines).
Configure Longhorn's `defaultReplicaCount: 3` and confirm off-site backup targets
(MinIO `longhorn-backups` bucket) before enabling the stack in production.

---

## 6. Flagged follow-ups (not implemented here)

### 6.1 Backend: link radiology images to the clinical timeline

**Status: FLAGGED — separate backend batch (do NOT implement in this infra PR)**

The endpoint `POST /api/v1/pacs/orders/:orderId/link-study` and the Orthanc
OnStableStudy Lua hook that calls it are a backend task. Once implemented:

1. Linked studies appear on the patient clinical timeline with OHIF deep links.
2. The staff app can open the viewer from the timeline card.
3. The backend must emit a `clinical_timeline_events` row for each linked study
   (per `docs/CANONICAL_CLINICAL_TIMELINE.md`).

### 6.2 Worklist sidecar

The MWL `.wl` file generation (converting backend radiology orders into Orthanc
worklist format) requires a sidecar process or a background job. The emptyDir
`orthanc-worklists` volume in the Orthanc StatefulSet is already mounted at
`/var/lib/orthanc/worklists` ready to receive `.wl` files. Implementation is
a backend concern.

### 6.3 SSO / OHIF authentication

Currently OHIF authenticates against Orthanc using the basic-auth credentials
in the `orthanc-users` SealedSecret. If remote reading (outside the LAN) is ever
required, add OIDC via Dex/Keycloak and configure the OHIF `oidc.json` in the
`ohif-config` ConfigMap. This is an enhancement, not required for on-prem LAN use.

### 6.4 Kyverno image-signature policy

Once the Kyverno `ClusterPolicy` in `base/image-policy/` is flipped to `Enforce`
mode (per `PHASE0_OPERATOR_ACTIONS_2026-06-10.md §6`), both Orthanc and OHIF
images must be cosign-signed or policy-exempted. Add their digests to the policy
`imageReferences` allow-list or sign them via the VH Health CI pipeline before
enabling production sync.

---

## 7. Quick-reference

| Task | Command |
|---|---|
| Validate pacs module | `kubectl kustomize infra/kubernetes/optional/pacs` |
| Check Orthanc health | `kubectl -n vhhealth exec deploy/... -- curl -u <ORTHANC_USER>:<ORTHANC_PW> http://orthanc:8042/system` |
| View OHIF (LAN) | `https://imaging.vhhealth.hospital.local` |
| View DICOM study | `https://imaging.vhhealth.hospital.local/viewer?StudyInstanceUIDs=<uid>` |
| Orthanc DICOMweb (backend) | `http://orthanc.vhhealth.svc.cluster.local:8042/dicom-web/` |
| Orthanc REST API (ops) | `http://orthanc.vhhealth.svc.cluster.local:8042/` |
| Trigger ArgoCD sync | `argocd app sync vhhealth-pacs` |
| ArgoCD Application status | `argocd app get vhhealth-pacs` |
