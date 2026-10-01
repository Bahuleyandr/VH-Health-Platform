# Laptop-only VH runtime

The owner's 2026-10-01 direction makes this laptop the exclusive VH development
and testing target, including databases, Backend, Admin, client builds, emulators
and local CI. Earlier Dalek-default instructions are superseded. Do not fall back
to Dalek APIs, databases, runners or deployment helpers when local checks fail.
Remaining coordinator access to Dalek is limited to preserving existing data and
safely retiring the old VH services. Other projects on that host are out of scope.

This configuration relocates the normal runtime; it is not a queue freeze or a
new application mode. No service starts under the default Compose profile.
The `database` profile selects only PostgreSQL; `runtime` selects the complete
stack. Runtime activation is held until the coordinator has fenced every old
VH writer and public entrypoint and verified the final consistent export and
restore. Preserve the historical export and its hashes as an immutable archive.

## Fixed boundary

- Project: `vhhealth-laptop`; candidate internal subnet `10.231.254.32/28`
  and nginx-only edge subnet `10.231.254.48/28`.
- PostgreSQL 17 image: `pgvector/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67`.
- Backend image: `ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:94739041b7d96e30517085a8950544953fd062dbeb34c478d57140e03d46d883`.
- TLS proxy image: `nginxinc/nginx-unprivileged@sha256:f35982400455b4f359083ba9d1ef573fbbe4221a6a8a194dc7a14beb4e2cd3dc`.
- Admin: locally built image ID, never a mutable tag or a published image.
- API: `https://localhost:8444`; Admin: `https://localhost:8445`.
- Only the TLS proxy publishes ports, both explicitly on IPv4 loopback.
  PostgreSQL has no host port. IPv6 is disabled on both Compose networks.
- One backend process runs `node src/bin/www.js`, without the cluster respawner.
  Every container has `restart: "no"` and `pull_policy: never`.
- Backend memory limit is 1536 MiB, Admin 1024 MiB, PostgreSQL 1024 MiB,
  proxy 128 MiB; both Node heaps are 768 MiB. These are limits, not reservations.

PostgreSQL, backend and Admin attach only to the internal bridge. Its
`gateway_mode_ipv4=isolated` removes the host bridge address; no external gateway
is provided. `dns: [127.0.0.1]` retains Docker service aliases without configuring
an external DNS resolver. Only nginx also attaches to the ordinary edge bridge,
which supplies the gateway required for explicit host-loopback publication.
No application service may join that edge network or any additional network.

This is configuration, not proof of containment. Before restoring application
access, verify service-alias resolution, external DNS failure, application
external IPv4/IPv6 and host/LAN access denial, both subnet non-overlaps, and
Windows-loopback publication using the actual Docker/WSL installation. Record
the targets, error classes and routing/resolver evidence; a failed connection
alone does not prove absence of DNS leakage or universal network isolation.
Stop if those checks fail; do not silently restore host DNS or add routing to
make a feature work.

Nginx has no database or application environment file and only fixed internal
HTTP upstreams, with no dynamic resolver or request-controlled proxy target.
It still handles authentication material in transit and can originate traffic
through its edge bridge. This design does not claim universal proxy egress
denial or protect against a compromised proxy. Do not add provider credentials,
application mounts, dynamic upstreams or forwarding features to that container.

## Private inputs and database preconditions

Use a private interpolation file based on `infra/local/laptop/.env.example`.
All path bindings must be absolute WSL paths, outside this checkout and the
immutable backup archive. Bind sources must exist; Compose must not create them.
Use separately reviewed backend and Admin env files in raw format so `$` in
existing keys is not interpolated. Never print a resolved secret-bearing Compose
configuration into ordinary logs. Do not mount an old `.env` into either image.

The PostgreSQL volume is external and required. Its mount root must contain
`pgdata/PG_VERSION` equal to `17` and `pgdata/global/pg_control`; the entrypoint
refuses an empty or differently versioned volume before the image can initialize
anything. That check does not prove backup provenance: the coordinator must also
verify the final restore receipt, database identities, roles, extensions and
checksums. Do not use `down --volumes`, volume removal, init scripts, or seeds.

Backend `DATABASE_URL` must select the restored laptop database through
`postgres:5432` using the preserved `vhhealth` login. The source deployment uses
that superuser connection and the separate `vhhealth_app` NOLOGIN role as its
`AUTH_TENANT_RLS_RUNTIME_ROLE` target. Do not invent a login, change role grants,
or replace the connection identity as part of relocation. Omit external
`DATABASE_READ_URL`. Boot remains production, `RUN_MIGRATIONS=false`, tenant RLS
enforced, and fail-open disabled. Migration checksum/tip, schema/encoding, RLS
and exposure-handler failures remain startup failures; no DDL or guard bypass
is introduced here.

Before activation, prove the restored login and role flags match the source,
the login can `SET LOCAL ROLE vhhealth_app`, the effective role is neither
SUPERUSER nor BYPASSRLS, and the existing boot posture passes. In a transaction
record `session_user`/`current_user`, perform the same role transition and tenant
GUC setup as `src/lib/prisma.js:714`, prove the intended tenant isolation, and
roll back. The role switch precedes `app.current_tenant_id` and lasts only for
the tenant-scoped transaction; unscoped work retains the connection role.
Do not claim that every query runs as `vhhealth_app`. Any later reduction of the
connection role's privilege is separate reviewed hardening, not a relocation fix.
Keep original encryption keys and all required KEK generations unchanged.
Missing keys or grants are blockers, not invitations to regenerate them.

Production rejects `TENANT_BASE_HOST=localhost`. Retain the reviewed real base
host and verify existing tenant-resolution settings against the restored tenant
identity. Do not enable default-tenant fallback merely to fix a login failure.
Backend/Admin JWT and API-key relationships and private CSRF configuration must
remain valid. The existing clinical privilege flags are not overridden here.

At this source revision, password login through the internal backend hostname
selects the existing default tenant in pre-authentication resolution, independently
of `ALLOW_DEFAULT_TENANT`. Admin has no `NEXT_PUBLIC_TENANT_ID` consumer. Confirm
that the intended existing account is reachable under that tenant; a non-default
tenant requires its existing hostname-routing contract, not a new UUID or grant.
SSO discovery on localhost selects platform scope and retains its external-provider
requirements. A readable platform account is not proof that its tenant-scoped
`last_login` update will pass RLS; verify authentication without changing ownership
or policies to make relocation succeed.

The actual source runtime has no Redis configuration; this stack preserves that
single-process posture rather than claiming Redis health. Redis URLs/Sentinels
are explicitly empty. Provide a new UID-1000-writable backend state directory for
logs, local storage and downtime files. Only owned writable state and `/tmp` are
writable; required old local assets must be inventoried/restored separately.
Admin's disposable Next cache is tmpfs, not a restored shared cache.

## Local Admin build and TLS

Build from source commit `a38055b8d2f3e2215ccc17338f6e199d0a063685`, using the existing
`apps/admin/Dockerfile`, with no application-source changes. Record the source
tree, Dockerfile/build inputs and final `--iidfile` image ID. Required build args:

```text
NEXT_PUBLIC_API_URL=https://localhost:8444
NEXT_PUBLIC_ALLOWED_ORIGIN=https://localhost:8445
NEXT_PUBLIC_SENTRY_DSN=
NEXT_PUBLIC_SENTRY_ENVIRONMENT=local-laptop
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0
NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0
NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE=0
SENTRY_ORG=
SENTRY_PROJECT=
SENTRY_UPLOAD_SOURCE_MAPS=false
```

Do not supply a Sentry auth secret; telemetry must remain disabled. Runtime
`BACKEND_URL=http://backend:5000` is for server-to-server calls, not browser
navigation. Runtime public variables cannot repair a differently built bundle.
The coordinator must verify `LAPTOP_ADMIN_IMAGE_ID` is exactly `sha256:` followed
by 64 lowercase hexadecimal digits and matches the reviewed build receipt.

Supply private `localhost.crt` and `localhost.key` with a localhost SAN and
appropriate permissions for the qualified nginx image user. No certificate or
trust-store installation is performed by this configuration. Probes must use the
certificate chain and `localhost` hostname; do not use TLS verification bypasses.

Nginx overwrites forwarded scheme/client identity with `https`/`127.0.0.1`, clears
alternate forwarded identity headers, and pins upstream Host values. It does not
inject API keys, drop authorization/cookie/CSRF headers, or weaken upstream CSP.
The Admin response gets a second CSP restricting connections and resource/form
targets to the local deployment. It deliberately omits `default-src` and
`script-src`, preserving the existing nonce/hash script policies. Verify both CSP
headers, websocket authentication, secure cookies and CSRF rejection in the
ordinary browser smoke test. CSP is not universal browser-network containment;
do not assume container egress controls cover the user's browser or extensions.

## Activation and evidence

The coordinator owns resource checks, Docker image qualification, initial DB-only
rehearsal, backup/restore, final cutover and invocation. Use explicit `--project-name
vhhealth-laptop`, `--env-file` and `--file infra/local/laptop/compose.yaml` arguments;
do not run an unreviewed override. No live Docker command is run by the static test.

After old writers/public entrypoints are fenced and final restore is verified,
start the one normal runtime under the `runtime` profile. Jobs can claim queues,
write delivery attempts, consume retries, expire records and change local data.
Document that continuation and retain startup logs; it is not duplicate execution
while the old copy is offline, and it is not evidence of external delivery.
Provider credentials are withheld, SMS uses its existing truthful logger posture,
and external network-dependent features remain unavailable. Stored integration
credentials still exist in the database, so network denial remains necessary.
Do not clear queues, rewrite receipts, automatically redrive failures, or claim
provider success to obtain a passing smoke test.

Stop on failed containment, provenance, TLS, migration/RLS or health checks. A
failed container does not restart automatically. Subsequent retries and rollback
must account for mutations already made to the laptop copy, and must not resume
the old writers while the new instance remains active.

Static contract verification only:

```powershell
& 'D:/Dev/Tools/node-26.5.0/node.exe' --test scripts/laptop-runtime-contract.test.mjs
```
