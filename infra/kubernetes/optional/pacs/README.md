# PACS stack (Orthanc + OHIF) — OPT-IN module (roadmap B4)

On-prem PACS for the radiology closed loop: **Orthanc** (DICOM store +
DICOMweb + modality worklists) and the **OHIF viewer** pointed at it.

**Deliberately NOT referenced by `base/kustomization.yaml`.** The prod
overlay consumes `../../base` wholesale, so wiring this into base would have
ArgoCD deploy a PACS on the next sync. Imaging storage sizing, AE titles,
and modality network reachability are deployment decisions the owner makes
per `docs/HARDWARE_REQUIREMENTS.md`.

## Enabling

1. Size the PVC below for the imaging retention target (CT ≈ 0.5 GB/study).
2. Add the module to `overlays/prod/kustomization.yaml`:

   ```yaml
   resources:
     - ../../base
     - ../../optional/pacs
   ```

3. Set the backend ConfigMap values so the API emits viewer deep links and
   the staff/admin clients can embed OHIF:

   ```yaml
   PACS_DICOMWEB_URL: "http://orthanc.vhhealth.svc:8042/dicom-web"
   PACS_VIEWER_URL: "https://imaging.vhhealth.app"   # OHIF ingress
   PACS_AET: "VHHEALTH"
   ```

4. Point modalities at Orthanc (DICOM port 4242, AET `VHHEALTH`); the
   worklist sidecar pattern is: poll `GET /api/v1/pacs/worklist` and render
   Orthanc worklist (`.wl`) files into the `orthanc-worklists` volume.
5. Wire the study→order link: an Orthanc Lua hook (OnStableStudy) POSTs
   `{ study_instance_uid }` to
   `POST /api/v1/pacs/orders/:orderId/link-study` using the accession
   number (`RAD-<orderId>`) carried in the MWL entry. Linked studies appear
   on the patient clinical timeline with OHIF deep links.

Exposure: keep Orthanc LAN-only (no ingress); expose ONLY the OHIF viewer
through ingress-nginx if remote reading is required, behind SSO.
