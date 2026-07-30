# C2.2 split-horizon DNS operator artifacts

These files render, but do not deploy, BIND 9 configuration for the C2.2
same-host continuity route.

The managed-clinical view returns the C2.1 private IPv4 address for:

- `api.vhhealth.app`; and
- each explicitly inventoried `<slug>-api.vhhealth.app` hostname.

Every other client uses normal public resolution. The renderer never creates a
wildcard. Each private hostname is an exact authoritative zone with one A
record and no AAAA record, so an AAAA query returns authoritative NODATA rather
than falling through to a stale public IPv6 address.

## Safety boundary

- `managed-hosts.example.json` contains placeholders and is intentionally not
  renderable until an operator supplies approved values.
- `render.mjs` writes only to the output directory passed on its command line.
- Nothing here edits a resolver, Kubernetes object, DHCP/MDM setting, VPN,
  certificate, or live DNS record.
- Rendering is not authorization to deploy. C-D13 and the operational
  activation gates in the C2.2 design must be signed first.

## Required operator inputs

Copy `managed-hosts.example.json` outside the repository and replace every
placeholder:

- two distinct resolver names and private IPv4 addresses;
- managed clinical VLAN/SSID source CIDRs;
- known guest/patient/non-clinical CIDRs;
- the owner-approved C2.1 private IPv4 address;
- positive and negative TTLs;
- one monotonically increasing zone serial; and
- the complete, explicit onboarded API hostname list.

The renderer rejects missing values, wildcards, public or special-use
addresses, overlapping clinical/non-clinical CIDRs, duplicate hosts, and
non-VH-Health hostnames.

## Render and validate

```text
node infra/onprem/dns/c2-2/render.mjs <inventory.json> <empty-output-directory>
named-checkconf <empty-output-directory>/named.conf.c2-2
named-checkzone api.vhhealth.app <empty-output-directory>/zones/api.vhhealth.app.zone
```

Run `named-checkzone` for every file in the rendered `zones` directory. Compare
the full output-directory hash between resolver A and resolver B before a later
authorized rollout.

The operational diagnosis and rollback procedure is in
`docs/continuity/c2-2-split-horizon-dns-runbook.md`.
