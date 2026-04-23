# VH Health Platform — Hardware Requirements

> Target: **3-node on-prem RKE2 Kubernetes cluster** running inside the
> hospital data centre. Intended audience: hospital IT / procurement.
> Companion doc: [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

This spec is sized for a mid-size (200–500 bed) hospital running the
backend, admin portal, CNPG-managed Postgres, Redis, MinIO, Harbor,
ArgoCD, and monitoring stack on the same 3-node cluster. Scale up per
the sizing tables at the bottom for larger facilities.

---

## Per-node compute

| Tier | CPU | RAM | Notes |
|------|-----|-----|-------|
| **Minimum** | 16 vCPU — Intel Xeon Silver 4310 (12c/24t, 2.1 GHz) or AMD EPYC 7313P (16c/32t, 3.0 GHz) | 64 GB ECC DDR4 / DDR5 | Comfortable for 200-bed workload; headroom tight at peak OPD hours |
| **Recommended** | 32 vCPU — Xeon Silver 4314 / EPYC 7413 | 128 GB ECC | Gives 2× margin for growth; lets you soak an HPA burst without shedding load |
| **Headroom** | 48+ vCPU — Xeon Gold 5318Y / EPYC 7453 | 256 GB ECC | Needed if adding on-prem LLM inference (Ollama) or vLLM-hosted models |

ECC RAM is non-negotiable — Postgres corruption from a single-bit flip
is not an incident you want.

---

## Per-node storage

| Volume | Capacity | Type | Purpose |
|--------|----------|------|---------|
| Boot | 2× 480 GB SSD in RAID1 | Enterprise SATA / NVMe | OS only |
| Cluster data (min) | 2× 1 TB NVMe in RAID1 | Enterprise NVMe (PLP / power-loss protection mandatory) | Pods, PVCs, container images |
| Cluster data (recommended) | 2× 2 TB NVMe in RAID1 | Same | More room for logs + image cache + staging PITR |
| etcd | Optional dedicated NVMe partition (separate device) | Enterprise NVMe | Isolates etcd fsync latency |

RAID1 can be hardware RAID (Dell PERC / HPE Smart Array / LSI MegaRAID)
or Linux `mdadm` on passthrough mode — hardware RAID is preferred for
write-back cache with battery/capacitor.

### Storage sizing breakdown (per node)

| Tenant | Initial | 3-year projection | Notes |
|--------|---------|-------------------|-------|
| Etcd data + WAL | 2 GB | 100 GB reserved | Dedicated volume if possible |
| Postgres (CNPG PV) | 100 GB | 500 GB | One replica per node; data replicated to peers via Postgres streaming, not a shared PV |
| Postgres WAL (in MinIO) | — | 100 GB | Depends on archive retention (default 30d local + offsite R2) |
| MinIO data drives | 100 GB × 4 drives = 400 GB | 1.6 TB | Distributed erasure-coding across all 3 nodes; sizing is per-node |
| Harbor registry | 50 GB | 200 GB | Grows with image tag retention; prune stale tags weekly |
| Container image cache (containerd) | 20 GB | 50 GB | Set `containerd` garbage-collection retention to 168h |
| Prometheus | 50 GB | 100 GB | 30-day metric retention |
| Loki | 100 GB | 300 GB | 30-day log retention; bump for HIPAA audit trail needs |
| Backend pod logs (transient) | 10 GB | 10 GB | Rotated out to Loki |
| **Total per node (3-year)** | ~500 GB | ~1.3 TB | Hence 2× 1 TB NVMe in RAID1 = 1 TB usable is the floor; 2× 2 TB RAID1 = 2 TB usable for 5-year runway |

---

## Networking

| Item | Spec |
|------|------|
| Per-node NIC | Dual 10 GbE, bonded (LACP preferred) or active-backup |
| OOB management | Dedicated 1 GbE IPMI/iDRAC/iLO on separate VLAN |
| Top-of-Rack switch | 2× 48-port 10 GbE with MLAG / VSS / stacking |
| Uplink to hospital core | 10 GbE minimum |
| Cable runs | Cat6a or OM3/OM4 fibre for 10 GbE SFP+ |

### VLAN layout

| VLAN | Purpose | CIDR (example) |
|------|---------|----------------|
| VLAN 100 — cluster | Node-to-node, pod networking | `10.10.0.0/24` |
| VLAN 101 — mgmt | IPMI / iDRAC / iLO | `10.10.1.0/24` |
| VLAN 102 — storage | Dedicated for future iSCSI / NFS (if added) | `10.10.2.0/24` |
| VLAN 200 — hospital-LAN | Client traffic reaching ingress via internal DNS | Per hospital |

### Internet egress

Outbound 443 / TCP only, through the hospital firewall. Used for:
- Cloudflare Tunnel (inbound proxy) — dials out to Cloudflare edge.
- Cloudflare R2 — backups, cold PHI storage.
- Firebase — patient OTP + FCM push.
- LLM backends (if external providers enabled) — `api.anthropic.com`, `api.openai.com`.
- Container image pulls — `ghcr.io`, Docker Hub mirror via Harbor proxy-cache.
- GitHub — ArgoCD pulls repo manifests.

Zero inbound ports opened on the hospital firewall.

### Redundancy / multi-homing

- **Default:** single ISP is acceptable — Cloudflare Tunnel handles
  outage from Cloudflare's side; if the hospital ISP drops, workloads
  stay up internally but external access is lost. Acceptable trade-off
  for most hospitals.
- **Optional:** BGP dual-ISP + on-prem BGP-capable firewall for
  ISP-level failover. Adds ₹40k-80k/year in transit costs and requires
  public AS / PI space. Defer to **batch 17**.

---

## Rack space + power + cooling

| Item | Spec |
|------|------|
| Rack space | 3U minimum (1U per server) + 1U ToR switch + 1U UPS/ATS = 5U |
| Server form factor | 1U rack (Dell R650 / HPE DL360 Gen11 / Supermicro Ultra 1U) |
| Power draw per server | ~400 W typical, 600 W peak |
| Total cluster power | ~1.5 kW steady, 2 kW peak |
| Power feeds | Dual — feed A and feed B to separate PDUs |
| UPS | Online double-conversion, 3 kVA min, 15 min runtime at full load |
| Generator | Hospital DC's existing backup genset — confirm cutover < 15s |
| Cooling | 2,000–3,000 BTU/hr removed; hospital DC cold-aisle sufficient. If rack is in an office closet: dedicated rack cooler required |
| Floor loading | ~40 kg per server + rails — verify with facilities |

---

## Concrete vendor SKUs (reference)

Prices are **approximate, India, April 2026**, per server, including
3-year NBD warranty, 2× PSU, IPMI, 64 GB RAM, 2× 1 TB NVMe. Rates
change — use as order-of-magnitude estimates only.

### Tier 1 (enterprise, 3–5 year OEM warranty)

| SKU | Approx. INR | Notes |
|-----|-------------|-------|
| Dell PowerEdge R650 (1U) | ₹8–12 lakh | Most common in Indian hospital DCs; Dell ProSupport is strong |
| HPE ProLiant DL360 Gen11 | ₹9–14 lakh | iLO 6 is best-in-class for remote ops |
| Supermicro Ultra 1U (SYS-120U) | ₹7–10 lakh | Cheapest tier-1; weaker local support network |
| Lenovo ThinkSystem SR650 V3 | ₹8–12 lakh | Solid option; less common in healthcare |

### Tier 2 (refurb / white-label, no OEM warranty past 1 year)

| Option | Approx. INR | Notes |
|--------|-------------|-------|
| Refurbished Dell R640 / HPE DL360 Gen10 (2 generations back) | ₹2–4 lakh each | Viable for smaller hospitals; ensure ECC + enterprise NVMe + PSU replacement |

### Tier 3 (budget — smaller hospitals / clinics, single-building DC)

For a 50–100 bed hospital where the spend above is prohibitive:

| Option | Approx. INR (3-node) | Notes |
|--------|----------------------|-------|
| 3× Minisforum MS-01 (i9-13900H, 64 GB, 2× 2 TB NVMe) | ₹1.5–2 lakh total | Consumer-grade; accept single-point-of-failure on cooling + PSU |
| 3× Beelink GTR7 (Ryzen 9 7940HS, 64 GB, 2× 2 TB NVMe) | ₹1.8–2.5 lakh total | Same caveat |
| 3× ASRock Rack 1U short-depth with Ryzen | ₹3–4 lakh total | Middle ground — real ECC, real IPMI, but fewer SLAs |

Trade-off at this tier: you lose enterprise-support SLAs and ECC RAM is
not always available on consumer chipsets. Acceptable for clinics with
a clear "downtime means human workflows, not cardiac events" risk
profile.

---

## Operating system

- **Ubuntu 24.04 LTS Server** — minimal install, no desktop.
- User `vhhealth` with key-only SSH (no passwords), `sudo` via
  sudoers.d drop-in. Defined in Ansible role `common`.
- Hostnames: `vhh-k8s-01`, `vhh-k8s-02`, `vhh-k8s-03`.
- Static IPs on VLAN 100 (cluster) + VLAN 101 (IPMI).
- Time: `chrony` pointed at hospital NTP source with Cloudflare NTP as
  fallback.
- Journald persistent logs at `/var/log/journal`.
- Kernel: stock HWE (6.8+) from Ubuntu; no custom kernel.

---

## Backup storage (offsite)

**Cloudflare R2** already in use for PHI uploads — same account hosts:

- `vhhealth-pg-backups-cold` — 180-day retention on encrypted PG base
  + WAL backups (AES-256 via pgBackRest, customer-managed cipher).
- `vhhealth-etcd-backups` — 7-day rolling etcd snapshots.
- `vh-health-records` — primary PHI object store (already in production).

R2 egress is free up to bucket-bandwidth limits; storage cost ~$0.015 /
GB-month. A year of backups for this cluster (~2 TB) = ~$30/month.
Budget line in the TCO below.

---

## Estimated total cost of ownership (India, 3-year)

| Item | Capex (one-time) | Opex (per year) |
|------|------------------|-----------------|
| 3× Dell R650 (recommended tier) | ₹30–40 lakh | — |
| 2× ToR 10 GbE switches (Cisco / Juniper / Aruba) | ₹4–8 lakh | — |
| UPS 3 kVA online + install | ₹1.5–2.5 lakh | — |
| Rack, PDUs, cabling, install | ₹1–2 lakh | — |
| **Capex subtotal** | **₹37–53 lakh** | |
| Electricity (1.5 kW × ₹8/kWh × 8760h) | — | ₹1–1.5 lakh |
| Cloudflare (R2 + Tunnel) | — | ₹30–50 k |
| ISP (1 Gbps symmetric business) | — | ₹3–5 lakh |
| OEM warranty extensions (yr 4 / 5 if needed) | — | ₹2–3 lakh |
| On-call / SRE retainer (partial FTE share) | — | Variable — ₹3–8 lakh if outsourced |
| **Opex subtotal** | | **₹5–8 lakh/year** |

3-year total: **capex ₹37–53 lakh + opex ₹15–24 lakh = ₹50–75 lakh all-in**.

For context: a comparable 3-year SaaS-managed stack (managed k8s +
managed Postgres + observability + backup) for the same workload is
roughly ₹60–90 lakh over 3 years at current India cloud pricing, plus
the policy problem of PHI leaving the hospital — which DPDP and many
hospital boards will not approve. On-prem comes out ahead on cost and
compliance posture both.

---

## Scaling beyond 3 nodes

The 3-node topology is quorum-safe (etcd tolerates 1 failure). To
scale:

| Hospital size | Nodes | Notes |
|---------------|-------|-------|
| 50–200 beds | 3 | Minimum viable. |
| 200–500 beds | 3–5 | Add 2 worker-only nodes if CPU/RAM pressured. |
| 500–1000 beds | 5 control-plane + N workers | Separate control plane from workloads. |
| 1000+ beds / multi-facility | 5+ control-plane, regional clusters | Standby site (batch 17). |

Adding worker-only nodes uses the same Ansible role with a different
group in the inventory (`workers` vs `servers`).

---

## What's deferred (batch 17)

- Offsite standby cluster at a partner hospital site (DR scenario 6).
- BGP dual-ISP multi-homing for internet egress.
- Dedicated storage tier (Ceph / Longhorn-distributed beyond replica-1).
- SOC 2 Type II formal audit + pentest.
- On-prem LLM inference hardware (GPU sled — 1× A100 80 GB min) for
  Ollama / vLLM — currently optional CPU-only Ollama for draft
  generation.
