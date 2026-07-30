# Held continuity publication RWX component

This component references the pre-created
`vhhealth-continuity-publication` `ReadWriteMany` PVC. It does not declare the
PVC or choose a StorageClass.

No active overlay includes the component. Selection is blocked until
`docs/C1_2_STORAGE_PLACEMENT_GATE.md` records `PLACEMENT QUALIFIED / CHANGE
APPROVED` and `docs/GO_LIVE_ACTIVATION_CHECKLIST.md` H1 has every required
operator receipt.

The selected render mounts `/var/lib/vhhealth/continuity`:

- read-only in `Deployment/vhhealth-backend`; and
- read/write in `CronJob/ward-downtime-packs`.

Both workloads receive `DOWNTIME_MIRROR_DIR` from the component and retain
`CLINICAL_CONTINUITY_PACKS_ENABLED=false`. Enabling publication is a separate,
explicit activation change after the owner and drill gates.

The held validation render is:

```sh
kustomize build --load-restrictor LoadRestrictionsNone \
  infra/continuity-edge/test/fixtures/held-publication
```
