# Forgejo CI runner image (`vhhealth/act-java17`)

`Dockerfile` in this directory is the image that the Forgejo runner serving the
`ubuntu-latest` label boots for every job. It is `ghcr.io/catthehacker/ubuntu`
plus a JDK 17, which the `fhir` stage needs for the HL7 FHIR validator.

The image is **built by hand on the runner host and never pushed anywhere**.
Nothing in this repository builds, publishes, or refreshes it. That is why the
mirror's CI died silently on 2026-08-17 and stayed dead for three weeks.

## What went wrong on 2026-08-17

The runner maps `runs-on: ubuntu-latest` to the local image
`vhhealth/act-java17:20260531`. That image disappeared from the runner host's
Docker daemon some time between 2026-08-14 01:49 IST and 2026-08-17 01:30 IST.
`act` then fell back to pulling it, and the name is unqualified, so Docker
resolved it to `docker.io/vhhealth/act-java17`, which does not exist.

Last healthy job, run 5510 (2026-08-14) — no pull, the image was present:

```
🚀  Start image=vhhealth/act-java17:20260531
  🐳  docker create image=vhhealth/act-java17:20260531 platform=linux/amd64 ...
```

First broken job, run 5511 (2026-08-17) — `docker create` became `docker pull`:

```
🚀  Start image=vhhealth/act-java17:20260531
  🐳  docker pull image=vhhealth/act-java17:20260531 platform=linux/amd64 username= forcePull=false
Error response from daemon: pull access denied for vhhealth/act-java17, repository does not exist or may require 'docker login': denied: requested access to the resource is denied
```

Every job died in the `Set up job` step in about two seconds, before any
workflow step ran. No workflow YAML changed across that boundary.

## Restoring the image (owner action, on the runner host)

Run this on the host running the act_runner that advertises `ubuntu-latest`
(runner id `04ede9df-dd57-4a64-a0fd-cf2e26fc2002`). It must be the same Docker
daemon that runner talks to.

```bash
git clone https://forgejo.hippocampus-monitor.ts.net/bahuleyan/VH-Health-Platform.git
cd VH-Health-Platform
docker build -t vhhealth/act-java17:20260531 infra/forgejo/ci-image
docker image inspect vhhealth/act-java17:20260531 --format '{{.Id}}'
```

Then re-run any Forgejo workflow and confirm the log shows `docker create`
rather than `docker pull` on the `Start image=` line.

## Making it stop rotting

The rebuild above restores service but leaves the same trap: one untagged,
unpushed, GC-eligible local image with no provenance. Two durable options,
both requiring a change to the runner's own configuration (owner action):

1. **Publish the image and reference it by registry path.** Build it, push it
   to the registry the mirror already authenticates against (the
   `CONTAINER_REGISTRY*` secrets exist on the Forgejo repository), and change
   the runner's label mapping from `vhhealth/act-java17:20260531` to the fully
   qualified `<registry>/vhhealth/act-java17:<tag>`. A pull then succeeds
   instead of 404-ing, so host-side image GC becomes survivable rather than
   fatal.

2. **Rebuild it automatically.** If the `docker-builder` runner
   (`b79383a6-89bd-432a-a157-b43ada0d2e19`) shares a Docker daemon with the
   `ubuntu-latest` runner, a scheduled `.forgejo` workflow pinned to
   `runs-on: docker-builder` can rebuild this Dockerfile on a cadence and the
   image is simply always there. Verify the shared-daemon premise first —
   `docker info` on both runner hosts — because the whole approach depends on
   it and it has not been confirmed.

Either way, `.github/workflows/forgejo-mirror-liveness.yml` now watches the
mirror daily and will say so out loud the next time it breaks.
