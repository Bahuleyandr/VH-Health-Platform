# C2.2 C-D13 shipped SPKI-pin inventory and trust packet

**Evidence baseline:** `github/main` at
`ed5167385d44853b4f0adae497a62c92418340de`
**Captured:** 2026-07-30 Asia/Calcutta
**Purpose:** signable security-owner input for C-D13 / C0.4
**Decision status:** no trust option selected

## 1. Executive result

No production SPKI hash can be attributed to a repository tag or release
artifact in the inspected VH Health release channels.

The only located installed Staff binary is version `1.0.1+2`. Its packaged
`app.so` predates the repository's certificate-pinning implementation and
contains the production API origin but no `sha256/...` pin literal. Its
effective shipped SPKI acceptance set is therefore **empty (pinning inactive)**.

The repository's tagged-release inventory is empty. The current release
workflows are parameterized to receive Staff/Patient pin variables, but no
release workflow run or release artifact was found and the connected GitHub
repository variables do not contain either pin variable. The tenant build
helper and two local Windows build/update paths omit production pin inputs, so
artifacts produced through those paths are unpinned by construction.

This is not evidence that no binary was ever copied or built outside the
inspected repository, release services, or installed workstation. Security and
release owners must identify any manually distributed APK, AAB, or Windows
bundle before signing C-D13.

## 2. Evidence scope

Inspected channels:

- local and `github` tags for `VH-Health-Platform`;
- GitHub releases and Staff/Patient release-workflow runs;
- connected GitHub repository variables;
- Forgejo monorepo tags/releases and release workflow definitions;
- archived GitHub repositories `VHhealth-staff`, `VH-health`, and
  `vhhealth-core`;
- all-history literal searches for `CERT_PIN_HASHES`, `sha256/`, and the
  certificate-pinner introduction;
- current GitHub and Forgejo Staff/Patient release workflows;
- `scripts/build-tenant-client.sh`;
- both local Staff Windows build/update scripts; and
- the installed Staff application under `D:\Dev\Tools\VH Health Staff`.

Evidence does not include:

- an enterprise MDM or Play Console inventory;
- files on other workstations or phones;
- private/manual release storage not linked from this repository;
- build logs already expired from a CI service; or
- pins injected through an unrecorded local command.

## 3. Shipped-release ledger

| Channel or release | Evidence | Pin set attributable to shipped artifact | Disposition |
|---|---|---|---|
| Monorepo local tags | `git tag --list` returned zero tags | None | No tagged artifact |
| Monorepo GitHub tags | `git ls-remote --tags github` returned zero tag refs | None | No tagged artifact |
| Monorepo GitHub releases | No release records located | None | No released artifact |
| GitHub Staff release workflow | Workflow exists; no run/release located | None | Not shipped through this channel |
| GitHub Patient release workflow | Workflow exists; no run/release located | None | Not shipped through this channel |
| Forgejo monorepo tags/releases | No tag/release records located in the inspected API result | None | No tagged artifact |
| Archived split repositories | No release records located for Staff, Patient, or core | None | No released artifact |
| Installed Staff Windows app | Version `1.0.1+2`; hashes below; packaged 2026-06-09 before pinning landed 2026-06-11 | Empty; pinning inactive | Known installed pilot |
| Tenant client helper | Script never passes `PRODUCTION=true` or `CERT_PIN_HASHES` | Empty; pinning inactive | Artifact inventory unknown |
| Local Staff update script | Passes only base URL to release build | Empty; pinning inactive | Known build path |
| Staff Windows update-package script | Passes only base URL to release build | Empty; pinning inactive | Known build path |

### Installed Staff binary receipt

| Field | Value |
|---|---|
| Executable | `D:\Dev\Tools\VH Health Staff\vhhealth_staff.exe` |
| File/Product version | `1.0.1+2` |
| Executable SHA-256 | `C032BE662C5B75E0E7FF0E7682553C982B766965338DC60B98E2FBBC622D3E43` |
| Dart AOT library | `D:\Dev\Tools\VH Health Staff\data\app.so` |
| AOT SHA-256 | `2E7B2A00A186B91356E02170FE85B6D911104F2EEBA71EF8DFBC7B2E8D44ADCF` |
| AOT timestamp | 2026-06-09 22:22:33 local |
| Production origin found | `https://api.vhhealth.app/api/v1` |
| `sha256/...` pin literal found | none |
| Pinning implementation landed | commit `60ee09aef6471886a36d2891e3f5840a925f21d3`, 2026-06-11 07:33:30 +05:30 |
| Effective pin set | empty / inactive |

Binary literal scanning is supporting evidence, not a general proof that Dart
AOT preserves every constant. The pre-pinning package timestamp and version
history are the primary attribution.

## 4. Current build definitions

### 4.1 Repository release workflows

The current workflows pass one undifferentiated comma-separated set:

- GitHub Staff: `STAFF_CERT_PIN_HASHES` becomes
  `--dart-define=CERT_PIN_HASHES=...` for Android and Windows;
- GitHub Patient: `PATIENT_CERT_PIN_HASHES` becomes the same define for Android;
- Forgejo Staff: the same Staff variable for Android;
- Forgejo Patient: the same Patient variable for Android.

The workflows validate only that the variable is non-empty. They do not prove
two unique pins, distinguish current from next, distinguish public from
internal, or attach a pin manifest to an artifact. The connected GitHub
repository variable list contains `VH_BASE_URL` but not
`STAFF_CERT_PIN_HASHES` or `PATIENT_CERT_PIN_HASHES`.

### 4.2 Tenant and Windows paths

`scripts/build-tenant-client.sh` passes tenant slug, tenant ID, base URL, API
key, and optional branding. It omits both `PRODUCTION=true` and
`CERT_PIN_HASHES`, and has done so for its recorded history.

`scripts/update-local-staff-windows-app.ps1` and
`scripts/build-staff-windows-update.ps1` build a Windows release with the base
URL but omit both production mode and the pin set.

### 4.3 Literal source history

No production SPKI hash was found committed in the client or release
configuration history. One hash-like literal appears in certificate-pinner test
material introduced with the pinning implementation. It is a test fixture and
must not be treated as a shipped or approved production trust anchor.

## 5. Current client trust semantics

`packages/vhhealth_core/lib/config/security_config.dart` reads one
`CERT_PIN_HASHES` string and splits it into one list.
`packages/vhhealth_core/lib/services/certificate_pinner.dart` normalizes that
list and accepts a server certificate if its SPKI matches **any** member.

Consequences:

- there is no public/internal pin boundary;
- there is no host-to-pin binding;
- there is no tenant-to-pin binding;
- “current” and “next” are operational labels only, not runtime roles;
- one accepted pin currently produces a warning rather than a production
  configuration failure; and
- the custom `SecurityContext(withTrustedRoots: false)` makes the supplied SPKI
  set the effective trust-anchor set when pinning is enabled.

## 6. C-D13 options — security owner must decide

### Option A — same host with a flat public/internal union

The client keeps `api.vhhealth.app` / `<slug>-api.vhhealth.app` and the existing
flat set. The set contains the approved current and next public keys plus the
approved current and next internal keys.

Exact consequences:

- current client origin, tenant routing, token/cookie behavior, WebSockets, and
  idempotency assumptions remain unchanged;
- rotation can overlap without an immediate client lockout;
- every accepted key authenticates the same hostname on either route;
- compromise of any accepted public or internal key crosses the route boundary
  for every client carrying that union;
- an internal key left in an older client remains valid for the public hostname
  from that client's perspective, and the reverse is also true;
- removing a key safely requires release/device coverage evidence; and
- the union can contain four or more pins during simultaneous public/internal
  rotation.

This is the C-D13 union-pin risk. C2.2 does not accept it on the owner's behalf.

### Option B — same host with one controlled key lineage on both routes

The public and internal endpoints present certificates for the same hostnames
whose SPKI key lineage is deliberately shared, so the client's flat current/next
set does not union independent trust domains.

Exact consequences:

- the same-origin client model remains;
- one key compromise affects both routes by design;
- the operator must be able to provision and rotate the same approved key
  lineage at the public edge and the internal ingress;
- the current Cloudflare-managed edge certificate/private key is not exported
  to this repository or the hospital and cannot simply be copied to the
  internal ingress;
- feasibility depends on an owner-approved certificate product/operating model
  and private-key custody; and
- rotation still requires a current/next client overlap.

C2.2 does not assert that the current Cloudflare plan supports this option.

### Option C — separate LAN hostname and separate trust boundary

The internal route uses a different hostname and a distinct approved pin set.

Exact consequences:

- public/internal key compromise can be isolated by host;
- the present one-origin client and one-flat-set model must change;
- clients need an explicit endpoint state machine and route-specific pin
  selection;
- JWT/audience, cookies, CORS, WebSockets, tenant Host routing, retries, and
  mutation idempotency require new review and proof;
- offline replay must prove it cannot send one mutation to two origins; and
- split-horizon same-host activation is replaced, not merely configured.

This is outside C2.2 implementation unless the coordinator re-plans the slice
after the owner decision.

### Rejected implicit option — disable pinning

Removing production pinning or relying silently on platform CA trust changes
the trust model and defeats the stated C-D13 decision. It is not an authorized
C2.2 option.

## 7. Required signatures and remaining evidence

No owner-input value below is filled by engineering.

| Sign-off field | Value |
|---|---|
| Selected option | OWNER INPUT |
| Accepted public/internal union consequence, if Option A | OWNER INPUT |
| Certificate/key custody model, if Option B | OWNER INPUT |
| Endpoint state-machine follow-up, if Option C | OWNER INPUT |
| Approved current/next SPKI inventory | OWNER INPUT — no hashes in this packet |
| Manual/MDM/Play-distributed artifact inventory completed | OWNER INPUT |
| Security owner/name/date/reference | OWNER INPUT |
| Infrastructure/network owner/name/date/reference | OWNER INPUT |
| Product/release owner/name/date/reference | OWNER INPUT |
| Privacy owner/name/date/reference | OWNER INPUT |

Until these fields are signed, C2.2 may implement only inert templates,
readiness, and flat-set rotation support. Private DNS and internal certificate
activation remain blocked.
