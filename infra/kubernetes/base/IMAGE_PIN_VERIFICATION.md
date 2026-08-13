# Production image pin verification

The production platform and application roots are separate ArgoCD sync units,
so image validation must render both of them:

```text
infra/kubernetes/overlays/prod
infra/kubernetes/apps
```

Run the repository guard from the repository root:

```bash
node scripts/check-prod-digests-pinned.mjs
```

The guard renders both roots with Kustomize, extracts every resulting `image:`
reference, and requires every active image to use a real `tag@sha256` reference.
It then requests the pinned digest through the registry's OCI Distribution API
and fails unless that manifest exists and its `Docker-Content-Digest` exactly
equals the rendered pin.
It supports anonymous Bearer challenges and optional Docker Hub, GHCR, or
generic registry credentials; authentication and rate-limit failures report
actionable status/header diagnostics without printing credentials.

The following all-zero application pins are the only exception, and only in
the rendered `infra/kubernetes/apps` root:

- `ghcr.io/bahuleyandr/vh-health-platform-backend`
- `ghcr.io/bahuleyandr/vh-health-platform-adminportal`
- `ghcr.io/bahuleyandr/vhhealth-staff-web`

They are deliberately held fail-closed until the signed release pipeline
writes build-emitted digests. The default guard reports them as `HELD`; pass
`--require-pinned` during activation to reject them.

## 2026-08-13 registry correction evidence

Baseline commit: `614216b28ffbf8f0270c4d88178cceae604ac091`.

Before correction, `docker buildx imagetools inspect <tag@digest>` returned
`not found` for all eight reviewed platform references below. Each unchanged
tag was then resolved live with:

```bash
docker buildx imagetools inspect <image:tag> --format '{{json .Manifest}}'
```

The resolved objects were multi-architecture indexes/manifest lists containing
`linux/amd64` plus at least one additional Linux platform. No image version was
changed and no held resource was composed or activated.

| Image tag | Correct multi-architecture digest |
|---|---|
| `redis:7.4.1-alpine` | `sha256:c1e88455c85225310bbea54816e9c3f4b5295815e6dbf80c34d40afc6df28275` |
| `oliver006/redis_exporter:v1.66.0` | `sha256:d98e6db8094f491b95791e9f776b0ba30a20aeacb90e18334935d5e51bf2e6a1` |
| `busybox:1.37.0` | `sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0` |
| `hashicorp/vault:1.18.2` | `sha256:2090eb7ac7a4bdef802f685698bd4dc0740de683affe8ff7df55f4fc77077ba7` |
| `smallstep/step-ca:0.28.1` | `sha256:a8308bddba866f5fccb2740c8bb2e5dea8cdde4b5856058539a7f5170894a9c0` |
| `docker.io/bitnami/sealed-secrets-controller:0.27.3` | `sha256:76f8c93c9e2e5450f90a416674f62ed9b9638b939561298f3218ed2a1cbe69d1` |
| `cloudflare/cloudflared:2024.11.1` | `sha256:665dda65335e35a782ed9319aa63e8404f88b34d2644d30adf3e91253604ffa0` |
| `ghcr.io/kubereboot/kured:1.16.2` | `sha256:c8c19766c778ba7fe87b4321eef05ba81dcc893a366a4cb3da00bf66a6d5d4df` |

This table records the tag resolution used for the committed correction. The
CI guard remains the authoritative current availability proof: it requests
every active rendered digest on each infrastructure gate and detects a missing
or invalid manifest. It deliberately does not require an upstream version tag
to remain bound forever; the digest, not the mutable tag, is Kubernetes' pull
authority.
