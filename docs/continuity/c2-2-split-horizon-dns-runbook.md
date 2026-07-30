# C2.2 split-horizon DNS operator runbook

**Status:** inert procedure only
**Live DNS authorization:** not granted
**C-D13:** unsigned

This runbook describes how an authorized hospital DNS operator later validates,
activates, diagnoses, and withdraws the C2.2 split-horizon records. Executing a
WAN-removal, resolver-failure, DNS, VPN, MDM, or certificate change is outside
C2.2.

## 1. Preconditions

Do not proceed beyond offline rendering until all of these are recorded:

- C-D13 security/infrastructure/product/privacy signatures;
- the C2.1 internal ingress, owner-approved private VIP, and certificate are
  active and independently healthy;
- resolver A and resolver B identities and source networks are approved;
- the exact onboarded API host inventory is approved;
- positive and negative TTLs are approved;
- current and next pins are present in every production client release path;
- the readiness endpoint succeeds through the public path first; and
- an incident commander and rollback operator are named.

## 2. Offline render and review

1. Copy `infra/onprem/dns/c2-2/managed-hosts.example.json` to an operator
   workspace outside the repository.
2. Fill every placeholder from approved source records. Do not use a wildcard.
3. Render separate output directories for resolver A and resolver B from the
   same inventory.
4. Run `named-checkconf` on each generated `named.conf.c2-2`.
5. Run `named-checkzone <host> <zone-file>` for every exact host.
6. Hash both output trees. Resolver A and B must match.
7. Review the receipt's host list and private address against the C2.1
   activation record.

No render command connects to a resolver or deploys a record.

## 3. Read-only resolution evidence

Substitute actual resolver addresses and hosts:

```text
dig @<resolver-a> api.vhhealth.app A +noall +answer +authority
dig @<resolver-a> api.vhhealth.app AAAA +noall +answer +authority
dig @<resolver-b> <slug>-api.vhhealth.app A +noall +answer +authority
dig @<resolver-b> <slug>-api.vhhealth.app AAAA +noall +answer +authority
```

Expected on a managed clinical source:

- A is the C2.1 private address;
- AAAA has no answer and an authoritative SOA (NODATA);
- resolver A and B have the same SOA serial; and
- a non-inventoried hostname is not privately synthesized.

Expected on guest/patient/non-clinical sources:

- A/AAAA follow the normal public resolver path; and
- no C2.1 private address is returned.

Test every inventoried hostname, not only `api.vhhealth.app`.

## 4. Readiness evidence

DNS success is not drain readiness. From an authenticated managed Staff client:

1. verify Transport reports available;
2. verify Continuity reports ready through `internal`;
3. verify the returned tenant equals the client tenant;
4. verify database/policy checks are ready and clock skew is within 300
   seconds; and
5. preserve the sanitized readiness receipt without JWT, API key, staff data,
   patient data, or raw policy/database details.

From guest/patient/non-clinical resolution, the authenticated Staff diagnostic
must report `public`.

## 5. Stale A diagnosis

1. Query resolver A and B directly, bypassing the client cache.
2. Compare answer, TTL, authority, and SOA serial.
3. Query the client's configured DNS server and OS resolver cache.
4. Confirm the inventory, rendered zone, and deployed zone all carry the same
   private address.
5. If one resolver is stale, remove it from service through the hospital's
   approved resolver procedure; do not change clients to a public resolver.
6. After repair, confirm both direct answers and readiness route kind.

Never infer the active route from A alone; require the authenticated readiness
response.

## 6. Stale AAAA diagnosis

Any public or private AAAA answer for an inventoried managed-clinical host is a
failure:

1. query both hospital resolvers directly with `AAAA`;
2. confirm the exact-host zone is loaded in the clinical view;
3. confirm the query source matched the clinical ACL;
4. inspect intermediate forwarder, OS, browser, and VPN caches;
5. flush only through approved resolver/client procedures; and
6. require authoritative NODATA plus an internal readiness result before
   returning the client to service.

Do not add a fabricated private IPv6 address to suppress a stale answer.

## 7. Resolver failure behavior

- Managed DHCP/MDM advertises resolver A and resolver B only.
- Loss of one resolver must leave the other serving the same serial and host
  set.
- Loss of both resolvers is fail-closed: name resolution fails, Transport may
  remain available, Continuity becomes not ready, and queued clinical work does
  not drain.
- Do not configure or manually add a public fallback resolver on a managed
  clinical device.
- Resolver restoration requires both direct DNS evidence and authenticated
  readiness evidence before queue drain.

No resolver-failure drill is authorized by this runbook.

## 8. Private DNS, DoH, and browser bypass

Symptoms include a managed device resolving the public address while hospital
resolvers return the private address.

Check, without changing policy:

- the OS DNS server list and interface priority;
- DNS-over-HTTPS settings in managed browsers;
- endpoint-security or privacy clients that install a local DNS proxy;
- enterprise resolver profiles;
- secure-DNS canary or exception lists; and
- the actual resolver observed in packet/DNS diagnostics.

Remediation requires the approved MDM/browser policy. Do not disable an
enterprise security control ad hoc. After remediation, prove both the private A
answer and `routeKind: internal`.

## 9. VPN bypass

Check whether the VPN:

- replaces the DNS server list;
- captures the VH Health suffix;
- routes resolver A/B outside the hospital path;
- applies split-DNS rules in a different order; or
- keeps a stale DNS cache after disconnect.

Use the VPN owner's approved split-DNS exclusion/route. Do not add public
fallback DNS. Re-test on-VPN and off-VPN from the same managed network.

## 10. Android Private DNS

Android labels DNS-over-TLS as Private DNS:

- **Off:** uses network-provided DNS without opportunistic Private DNS.
- **Automatic:** may use network-provided DNS and opportunistic encrypted DNS;
  confirm which resolver is actually selected.
- **Private DNS provider hostname:** can bypass hospital resolvers and return
  the public route.

The approved clinical-device MDM profile must define the allowed mode. Do not
ask clinical users to change it manually as a permanent workaround. After any
authorized profile change:

1. reconnect to the managed clinical SSID;
2. confirm the hospital resolver addresses;
3. verify A and authoritative AAAA NODATA;
4. verify Continuity reports `internal`; and
5. verify guest/patient SSIDs still resolve publicly.

## 11. Cache handling

Work from the outermost authority inward:

1. deployed zone and SOA serial;
2. resolver A/B caches;
3. local caching resolver;
4. OS network-service cache;
5. VPN/security proxy cache; and
6. browser/application cache.

Use platform/operator-approved cache flush commands. Record timestamps and
serials. A cache flush is not a substitute for correcting the authoritative
zone or client bypass.

## 12. Rollback

Rollback order is mandatory:

1. close or withhold readiness so no new drain begins;
2. withdraw every private exact-host zone from both resolvers;
3. increment serials and clear approved resolver caches;
4. prove managed and non-managed sources resolve the public route;
5. prove authenticated readiness reports `public`;
6. only then roll back the C2.1 internal ingress/VIP; and
7. retain the current/next pin overlap until release coverage proves a key can
   be removed.

Record every host, resolver, serial, command, operator, timestamp, and
readiness result. Do not include credentials, PHI, policy bodies, or database
details in the receipt.
