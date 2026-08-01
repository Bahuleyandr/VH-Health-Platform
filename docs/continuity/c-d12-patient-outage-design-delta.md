# C-D12 patient app and portal outage behavior — client design delta

**Status:** Step 1 approved; Step 2 cleared on 2026-08-02 subject to the dated
ledger amendment in section 1A
**Scope:** `apps/patient`, one named additive model field in
`packages/vhhealth_core`, and the exact additive public-config backend ledger in
section 1A
**Branch:** `feat/continuity-c-d12-patient-outage`
**Baseline:** `github/main` and `origin/main` at
`a45b2c98faf216b12a71a177589e8351794c3ec3` (2026-08-02 01:30:29 +05:30)
**Release behavior:** ordinary patient-client behavior, default-ON, with no
continuity activation or facility-activation coupling
**Merge state:** never merge from this lane
**Declared overlap:** zero with every current or queued lane; the only proposed
shared-core edit is the additive `CachedApiResponse.cachedAt` field named in
section 11. The concurrent C6.1-C/AZ lane uses backend lab services, while this
lane uses only the public app-config files named in section 1A.

## 1. Outcome and authority

This delta implements the countersigned C-D12 decision as a display and refusal
policy for the existing patient Flutter client. During a hospital API outage an
already authenticated patient may see only data that the current app already
persisted after a successful release response. Every such view carries a
prominent, exact device-cache timestamp. Hospital-facing mutations are not
captured or queued. High-risk actions are blocked with the one approved outage
message and resume only after stable authenticated readiness returns.

The binding authority is the C-D12 record in
`docs/continuity/c0-4-owner-decision-dossier.md:259-274`, countersigned on
2026-08-02. Its message-maintenance boundary also incorporates:

- C-D6's one-use, signed incident-packet ownership at
  `docs/continuity/c0-4-owner-decision-dossier.md:116-132`; and
- C-D10's printed phone tree, role contact sheet, and packet print cycle at
  `docs/continuity/c0-4-owner-decision-dossier.md:210-230`.

The older `activation-readiness-tracker.md` row still describes C-D12 as open.
That row is stale relative to the later countersigned dossier and is not an
authority to weaken or gate this behavior. This lane does not edit the tracker.

No implementation begins until the coordinator clears this delta, the message
source in section 8, and the exact file ledger in section 11.

## 1A. 2026-08-02 coordinator amendment — operational-copy transport

The coordinator cleared Step 2, accepted the patient readiness adapter and all
other contracts in this delta, and recorded that the earlier relay instruction
requiring update without an app release was a coordinator-side tightening of
section 8. The following narrow amendment is authorized and was recorded before
implementation.

### Approved bundled wording

The owner approved this exact English outage message on 2026-08-02. It is the
bundled English floor and is translated through the normal five-language
patient i18n path:

> Hospital systems are temporarily unavailable. The information shown here was
> saved earlier — check the 'last updated' time on each page. New bookings,
> cancellations, and medical requests are paused until service is restored. For
> urgent needs, please contact the hospital directly at [facility contact
> number]. In an emergency, call your local emergency number or come straight
> to the Emergency Department.

The C-D12 dossier record itself is not edited. Its countersigned wording remains
the policy authority; this amendment changes transport only.

### Payload ceiling and policy fence

The existing public `GET /api/v1/config` response gains one optional additive
`outage_communication` object. That object contains exactly:

- `revision`: a positive integer;
- `messages`: exactly `en`, `hi`, `ta`, `te`, and `ml`, each carrying the
  approved operational copy in that language; and
- `facility_contact_number`: the print-cycle facility contact value.

No other key is accepted or emitted inside the object. In particular, it may
not carry a feature gate, security control, authentication or authorization
input, clinical rule, retention/freshness rule, patient identifier or data,
staff data, tenant policy, facility-activation state, signed-policy material,
or executable action. It is operational copy, not a policy channel. The signed
C4 policy-delivery adapter remains the only policy transport; this endpoint may
never become a second policy-delivery path.

The endpoint remains public, additive, and non-PHI. The operator update path is
the existing environment/configuration mechanism that already supplies
`/api/v1/config`; there is no admin UI, CMS, database row, migration, or new
write endpoint. Strict server parsing rejects extra object/message keys,
missing locales, invalid revisions, empty/oversized text, and invalid contact
values. An absent or invalid operator value omits `outage_communication` while
preserving the existing version-gate response.

### Isolated last-validated snapshot

The patient client validates the same exact shape and persists the last valid
operator record in a dedicated non-PHI SharedPreferences keyspace. The snapshot
is separate from `ApiCacheManager`, `RecordCacheManager`, downloaded PHI files,
the mutation queue, secure patient storage, and every patient/clinical cache.
It is bound to the configured API base URL and tenant cache namespace, survives
logout and app restart by construction, and contains no personal value.

A fetched record replaces the snapshot only when its revision is strictly
higher. Equal, lower, malformed, cross-source, over-ceiling, or incomplete
records cannot replace it. If no valid snapshot exists, the app renders the
bundled five-language default with the literal `[facility contact number]`
placeholder. A failed fetch never deletes or re-dates a valid snapshot.

This isolated operational-copy snapshot is the only exception to section 2's
“no new cache” wording. That prohibition remains absolute for patient data,
clinical data, API response caches, files, readiness state, mutations, policy,
and every other message or endpoint.

### Additive backend/config ledger

The authorized backend/config files are exactly:

- `apps/backend/src/routes/configRoutes.js`;
- `apps/backend/src/utils/validateEnv.js`;
- `apps/backend/.env.example`;
- `apps/backend/src/tests/unit/configRoutes.test.js`;
- `apps/backend/src/tests/unit/configEnv.test.js`;
- `apps/backend/scripts/openapi/schemas/config.mjs`;
- generated `apps/backend/src/docs/openapi.json`; and
- synchronized `packages/vhhealth_core/swagger/openapi.json`.

The patient ledger additionally gains
`apps/patient/lib/core/outage/patient_outage_config.dart`, its focused tests,
and an additive integration point in
`apps/patient/lib/core/services/minimum_version_gate_service.dart`, which
already fetches the public config at boot. The compiled JSON asset and validator
proposed in sections 8 and 11.4 are superseded; bundled defaults live in ARB,
while runtime operator copy comes only from the bounded public config object.
Accordingly, the old asset-validator receipt in section 12.4 is replaced by the
bounded server/client config-validation receipt recorded there. The coordinator
confirmations requested in section 13 were supplied on 2026-08-02; its former
pre-clearance closing condition no longer applies.

Expected overlap with AZ/C6.1-C is zero: this lane touches public config and AZ
touches lab services. Whichever lane lands second must rebase on current main
and rerun its focused suites, OpenAPI drift checks, and applicable full gates.

## 2. Fixed boundaries and non-goals

This is a patient-client behavior change, not a new continuity capability.

1. No patient input is captured for later hospital submission while outage
   mode is active.
2. No endpoint, response, file, message, readiness result, or mutation is added
   to a cache. Online operation may continue refreshing only the exact caches
   that already exist today.
3. No queued patient mutation is created or replayed.
4. No staff-app file or behavior changes.
5. No backend, database, migration, ingress, DNS, incident-packet generator, or
   CMS is added.
6. No feature flag, tenant flag, facility activation, C4 action policy, or
   continuity activation state gates the behavior.
7. No offline sign-in, guest disclosure of cached PHI, or cross-user cache
   access is added. Cached PHI remains available only to the current hydrated,
   authenticated patient session and retains the existing logout wipe.
8. A green build does not publish, deploy, activate, or merge anything.

The default-ON framing follows directly from C-D12: honestly labeling existing
device data and refusing writes when the hospital API cannot accept them is a
normal safety property. It does not create an offline clinical workflow. The
coordinator must confirm this framing at Step 1 clearance. No technical fact
found in the current client requires a gate.

## 3. Verified current state

### 3.1 The patient app does not currently consume C2.2 readiness

The shared C2.2 contract and strict parser already exist. The production
`ClientReadinessService` also requires `AuthService.getStaffId`
(`packages/vhhealth_core/lib/services/client_readiness_service.dart:16-40`) and
returns not-ready when the staff identity is absent
(`packages/vhhealth_core/lib/services/client_readiness_service.dart:80-96`).
No patient file imports or calls that service. A patient session therefore
cannot use the production singleton as written.

The patient app currently starts `ConnectivityService` and treats a positive
DNS lookup as online. The shared service polls the configured API host every
ten seconds using `InternetAddress.lookup`
(`packages/vhhealth_core/lib/services/connectivity_service.dart:8-58`). That is
transport evidence only; it is not backend, database, policy, tenant, or route
readiness.

The patient bootstrap also replays its mutation queue whenever this DNS signal
returns (`apps/patient/lib/main.dart:184-194`). The queue itself can serialize
arbitrary `POST`, `PUT`, `PATCH`, and `DELETE` work
(`apps/patient/lib/core/offline/mutation_queue.dart:19-145`). A full code search
found no production call to `enqueueOrExecute`; only the reconnect replay is
live. Step 2 removes replay and the queue API. It does not silently submit or
delete any legacy encrypted blob. Existing logout storage deletion remains the
only cleanup path.

### 3.2 Existing response caches

`ApiClient.cachedGet` is the only general JSON response-cache entry point. It
uses the encrypted `ApiCacheManager` envelope and a 15-minute freshness hint,
but retains older data for fallback. The envelope already writes an exact
device `cachedAt` timestamp (`apps/patient/lib/core/offline/api_cache_manager.dart:175-221`).
The current response wrapper discards that timestamp and exposes only an
English relative stale label (`packages/vhhealth_core/lib/models/api_response.dart:118-140`).

The current cached-read behavior has three C-D12 gaps:

- a cache younger than 15 minutes returns with no stale/updated label and
  starts a background live refresh;
- an ordinary HTTP 503 is returned as an error instead of falling back to an
  existing cache; and
- `_withFailureReference` reconstructs a failed response without preserving
  its typed `code` (`apps/patient/lib/core/services/api_client.dart:238-255`).

The exact JSON response caches already present are:

| Patient view | Existing cache key or endpoint template | Timestamp source in Step 2 |
|---|---|---|
| Dashboard appointments | `/appointments/uid/{firebaseUid}` | Existing `ApiCacheManager.cachedAt` |
| Dashboard command centre | `/portal/command-center` | Existing `ApiCacheManager.cachedAt` |
| Notifications | `/notifications/my` | Existing `ApiCacheManager.cachedAt` |
| Diagnostic results list and detail | `/portal/diagnostic-results`, `/portal/diagnostic-results/{id}` | Existing `ApiCacheManager.cachedAt` |
| Referrals | `/portal/referrals` | Existing `ApiCacheManager.cachedAt` |
| Lab results list, detail, and trend | `/portal/lab-results`, `/portal/lab-results/{id}`, `/portal/lab-results/trends` plus existing query key | Existing `ApiCacheManager.cachedAt` |
| Discharge summaries list and detail | `/portal/discharge-summaries`, `/portal/discharge-summaries/{id}` | Existing `ApiCacheManager.cachedAt` |
| Consultation notes list and detail | `/portal/clinical-notes`, `/portal/clinical-notes/{id}` | Existing `ApiCacheManager.cachedAt` |
| Proxy/record-access grants | `/portal/proxy/grants` | Existing `ApiCacheManager.cachedAt` |
| Maternity timeline | `/portal/maternity/timeline` | Existing `ApiCacheManager.cachedAt` |
| Maternity packages | `/portal/maternity/packages` | Existing `ApiCacheManager.cachedAt` |
| Maternity ANC advice | `/portal/maternity/anc-advice` plus existing locale/trimester query key | Existing `ApiCacheManager.cachedAt` |
| Health-record manifest | `records_manifest_{phone}` | Existing `ApiCacheManager.cachedAt`, currently discarded by `RecordCacheManager` |

No other `ApiClient.cachedGet` or direct `ApiCacheManager.save` production call
exists in `apps/patient/lib`.

### 3.3 Existing downloaded-file and local-only storage

`CacheFileUtils` already stores encrypted downloaded PHI bytes under
`vhhealth_cache`. Existing callers cover investigation results, discharge
summary PDFs, lab-order PDFs, TPA documents, and health-record documents. Step
2 may expose the existing file's local modification time as “downloaded on this
device” and reopen it only when the current cached view already knows its file
key. It does not create an index, prefetch a file, redownload during an outage,
or infer a server clinical-update time.

Opaque `cached_network_image` storage is not a governed C-D12 cache: it has no
patient-view release contract or honest timestamp and is excluded.

Theme, language, font/accent, biometric preference, local notification state,
and the encrypted period tracker also persist locally today. They are not
hospital response caches. Their treatment is classified in section 7.

## 4. Patient readiness adapter and outage state

Step 2 adds a patient-owned adapter that reuses, without weakening, these C2.2
components:

- `ClientReadinessConfig.path`, endpoint identity, contract version, policy
  schema version, and clock-skew limit;
- the strict `ClientReadiness.fromJson` field/state parser; and
- the two matching successes separated by at least one second before opening.

It does not call or modify the staff-oriented `ClientReadinessService`
singleton. The adapter authenticates with the existing patient JWT and validates
tenant, endpoint, contract, route kind, database state, policy schema, and
server time. It captures an opaque in-memory session fingerprint and tenant
before the first probe and rechecks both before accepting the second. No JWT,
phone number, Firebase UID, or patient identifier is logged or persisted.

The state machine is:

| State | Reads | Hospital mutations | Exit |
|---|---|---|---|
| `signedOut` | No cached PHI | Auth may attempt online; no offline auth | Successful normal backend login |
| `checking` | Existing cache only, labelled “checking service” with exact device timestamp | Blocked fail-closed | Stable ready or a qualifying outage result |
| `available` | Current online/cache-first behavior | Allowed online | Qualifying failure closes immediately |
| `outage` | Existing cache only, always prominently timestamped | Blocked; never queued | Two strict matching readiness successes at least one second apart |

`rateLimited` is recorded as an outage reason, not a fifth permission state.
The adapter honours C2.2 `Retry-After` and cannot reopen while suppression is
active.

## 5. Detection, recovery, and anti-flap rules

### 5.1 Probe triggers

One single-flight readiness probe may run at a time. A probe is triggered by:

1. authenticated app startup after session hydration;
2. foreground resume;
3. `ConnectivityService` changing from unavailable to available;
4. the patient's explicit retry action;
5. a qualifying transport failure after the shared HTTP client's own retry
   budget is exhausted; or
6. an ordinary backend 503 as described below.

While in outage, automatic recovery probes use 5, 15, 30, then 60-second
intervals and remain capped at 60 seconds. A valid `Retry-After` overrides that
schedule. Backgrounding cancels the timer; foregrounding starts a fresh probe.
The backoff resets only after stable readiness reopens the client.

### 5.2 What closes the client

The transition to `outage` is fail-closed and uses these exact rules:

- A strict authenticated readiness response with `ready: false`, including
  `endpoint_unverified`, `database_unavailable`, `policy_unavailable`, or
  `policy_incompatible`, closes immediately.
- A missing, malformed, cross-tenant, wrong-endpoint, wrong-contract,
  wrong-route, incompatible-policy, excessive-clock-skew, or otherwise invalid
  readiness response closes immediately.
- DNS unavailability closes immediately because no hospital API path exists.
- `SocketException`, connect/TLS failure, `TimeoutException`, or the shared
  HTTP client's terminal network failure does not make every feature failure
  authoritative by itself. It triggers a readiness probe; failure of that
  probe closes the client. If DNS is already unavailable, the preceding rule
  applies without another wait.
- An ordinary endpoint 503 carrying a strict C2.2 readiness object in its typed
  details closes immediately after parsing that object.
- Any other ordinary endpoint 503 triggers a readiness probe and does not
  directly close the client. This prevents feature-specific conditions such as
  a disabled integration from masquerading as a hospital outage. If readiness
  remains valid, the client stays `available` and the feature shows its normal
  typed error.
- A 401 follows the existing session-expiry/logout path. It becomes
  `signedOut`, not `outage`.
- An ordinary 429 remains a feature rate limit. A readiness 429 closes or keeps
  the client closed and honours `Retry-After`.

`ApiClient` must preserve `ApiResponse.code` when adding a display reference so
these distinctions survive the patient facade.

### 5.3 What reopens it

Only two strict, matching, authenticated readiness successes separated by at
least one second reopen the client. The JWT fingerprint and tenant must remain
unchanged across both probes. A failure between successes resets the sequence.
No DNS event, successful feature GET, WebSocket reconnection, cached response,
elapsed timer, app restart, or manual button can bypass this rule.

The second success is the single transition point. Mutation controls and the
transport gate reopen together, preventing a UI/network race. Any later
qualifying failure closes on the rules above; reopening again requires the full
two-success sequence.

## 6. Cache-only presentation contract

When state is `checking` or `outage`, `cachedGet` becomes a cache-only read:

1. it loads the pre-existing key;
2. it never starts a background refresh;
3. it never writes, extends, touches, or re-dates the cache;
4. it returns the exact stored `cachedAt`; and
5. it returns a localized cache-unavailable result when the key is absent or
   malformed.

If an ordinary request causes the transition into outage, the caller performs
one cache-only reread of the same existing key. It does not save the failure.
Direct live GET surfaces that have never been cached become unavailable; they
may not retain and present ungoverned in-memory data as an outage cache.

Every cached view displays the outage banner and an exact localized timestamp,
even when the cache is younger than 15 minutes. The copy says “saved on this
device” or “downloaded on this device,” not “the hospital updated this record,”
because `cachedAt` and file modification time are client observation times.
Relative ages may be secondary text only. If an exact timestamp cannot be
read, the associated cached content is not shown.

The dossier provides no maximum display age. Step 2 therefore does not invent
one: an old but valid existing cache remains visible with its exact age. Cache
corruption, authentication loss, user/acting-as namespace mismatch, or logout
still refuses display under current protections.

A patient-global outage panel appears above every authenticated route, not only
the nine screens that currently instantiate `OfflineBanner`. Each cached list
and detail view additionally carries its own timestamp so navigation or a
screenshot cannot detach data from its age.

## 7. Complete mutation inventory and policy

The authoritative transport rule is default-deny: while `checking` or
`outage`, every hospital-facing `POST`, `PUT`, `PATCH`, `DELETE`, and multipart
request is refused before network I/O. The registry below drives action-specific
presentation, but a new/unregistered mutating path is still blocked. Nothing is
queued and no optimistic state may be committed on a blocked result.

### 7.1 C-D12 high-risk actions — blocked

| Domain | Patient action and current endpoint template(s) |
|---|---|
| Appointments | Book `POST /appointments/book`; cancel `DELETE /appointments/{id}`; reschedule `PATCH /appointments/{id}/reschedule` |
| Clinical questions and messages | Symptom triage `POST /chatbot/triage`; Ask a Doubt/general clinical feedback `POST /feedback`; create/reply `POST /portal/messages`, `POST /portal/messages/{id}/reply`; teleconsult fallback `POST /portal/messages/appointment/{appointmentId}/teleconsult-fallback`; extraction help request `POST /portal/messages` |
| Pharmacy and prescriptions | Place order `multipart /pharmacy-orders/orders/place`; refill `POST /prescriptions/{id}/refill`; order from prescription `POST /prescriptions/{id}/order-pharmacy` |
| Investigations and records | Upload then create `multipart /upload` + `POST /investigations`; book `multipart /investigations/bookings/create`; upload/delete/extract patient records at `multipart /appointments/patient/records/upload`, `DELETE /appointments/patient/records/{id}`, and `POST /appointments/patient/records/{id}/extraction/process` |
| Vitals and maternity | Manual/automatic vitals `POST /health/patient/vitals`; daily check-in `POST /gamification/checkin`; fetal kicks `POST /portal/maternity/fetal-kicks`; supplement reminder `PATCH /portal/maternity/supplements/{id}/reminder` |
| Medication reminders | Create `POST /reminders/medication`; update/toggle `PUT /reminders/medication/{id}`; delete `DELETE /reminders/medication/{id}`. The local scheduler is not changed unless the server mutation succeeds. |
| Teleconsult | Consent `POST /portal/teleconsult/teleconsultations/{id}/consent`; token/join `POST /portal/teleconsult/teleconsultations/{id}/token`; fallback message as above |
| Health sync and steps | Health-platform vitals `POST /health/patient/vitals`; steps sync `POST /steps/health-sync`; profile `PUT /steps/profile`; session start/stop `POST /steps/session/start`, `POST /steps/session/stop` |
| ABDM and consent | Register/verify ABHA `POST /abdm/register-abha`, `POST /abdm/verify-abha`; grant/deny/revoke consent `POST /abdm/consents/{id}/grant`, `/deny`, `/revoke` |
| Proxy access | Create grant `POST` or multipart `/portal/proxy/grants`; revoke `POST /portal/proxy/grants/{id}/revoke` |
| Identity and account | Add/delete family member `POST /users/family-members`, `DELETE /users/family-members/{id}`; link/unlink dependent `POST /users/dependents/link`, `DELETE /users/dependents/{id}`; profile `PUT /users/{phone}`; profile completion `POST /auth/firebase/complete-profile`; account deletion `DELETE /users/me/account` |
| Billing | Request payment link `POST /portal/bills/{invoiceId}/payment-link` |
| SOS | Trigger `POST /sos/`; cancel `POST /sos/cancel/{alertId}`. The blocked UI must say the hospital alert was not sent and use the same approved outage contact to direct the patient to telephone help immediately. |

These actions are high-risk in outage handling because they change clinical,
identity, consent, financial, access, or emergency state and the current
patient client has no approved offline acceptance, reconciliation, or delivery
proof.

### 7.2 Other remote mutations — also blocked, not mislabelled local

| Domain | Current endpoint template(s) | Reason |
|---|---|---|
| Notification acknowledgement | `PATCH /notifications/{id}/read`, `PATCH /notifications/my/mark-all-read` | Server state would diverge; keep the cached state unchanged. |
| Message read receipt | `POST /portal/messages/{id}/read` | Opening cached content must not imply server acknowledgement. |
| Quick rating | `POST /feedback/quick-rating` | Low clinical severity but still a hospital mutation; do not queue it. |
| Gamification | `POST /gamification/milestones/{id}/claim` | Server award state; do not simulate locally. |
| Device/session maintenance | `POST /devices/register`, `/heartbeat`, `/update-token`, `/unregister`; `POST /auth/firebase/update-fcm-token`, `/revoke-session` | Automatic remote writes are suppressed and never presented as accepted. |

Logout remains available. Realtime disconnect, local notification cancellation,
credential removal, API/file-cache wipe, staged-file purge, period-data wipe,
and in-memory identity clearing run locally even when remote unregister/revoke
cannot run.

Firebase OTP verification/sign-in and the normal backend login
`POST /auth/firebase/firebase-login` are authentication, not offline patient
capture. A signed-out client cannot call authenticated readiness or reveal a
prior cache. It may attempt normal online authentication, but a backend failure
leaves it signed out. The raw debug patient-login path remains debug-only and
confers no outage behavior.

### 7.3 Harmless-local actions — allowed

“Harmless-local” means no claim is sent to or made about hospital state. It
does not mean the data lacks privacy sensitivity.

- change language, theme mode, font size, accent/dynamic colour, biometric
  preference, or the appointment-to-calendar preference;
- change in-memory search, filter, sort, tab, expansion, and navigation state;
- add/edit/delete encrypted period-tracker entries, which are device-only and
  have no backend submission path;
- view an existing governed cache or open an already encrypted downloaded file
  through the existing decrypted staging path;
- dismiss the outage panel for the current route without suppressing its
  persistent status indicator; and
- log out and wipe local patient data.

Form drafts for blocked actions may exist only in widget memory while the
screen is open. They are not persisted, queued, described as submitted, or
automatically sent after recovery.

## 8. One approved support/communication message

The current repository contains references to C-D6 packets and the C-D10 phone
tree but no patient outage message source or packet-material artifact. This
delta therefore does not invent approved wording or contact details.

Step 2 uses exactly one structured message record:

- bundled, owner-approved fallback strings in all five patient ARBs;
- an operator-maintained, versioned JSON asset under
  `apps/patient/assets/config/patient_outage_message.json` containing one
  semantic message in `en`, `hi`, `ta`, `te`, and `ml`, the contact label and
  URI, `packetRevision`, `reviewedAt`, and approval reference;
- strict startup parsing with size, field, locale, contact-URI, and timestamp
  validation; and
- per-locale fallback to the bundled approved ARB value if the asset is absent
  or invalid. No locale silently falls back to operator English copy.

The asset is compiled into the signed client. It is not fetched or cached at
runtime, so it remains available during the outage it describes and introduces
no CMS. An operator update is an ordinary reviewed patient-client release, not
a live remote edit.

The packet owner must refresh this asset from the same approved source used for
the C-D6 packet/phone-tree print cycle. The build validator emits the asset
revision and SHA-256 receipt; release clearance compares both with the packet
print receipt. The repository currently has no packet source against which code
can automate that comparison, so a matching operator receipt is a release
input, not an engineering inference.

The coordinator must supply or identify the exact approved default copy,
translations, contact action, and packet revision before Step 2 adds the asset.
The coordinator must also confirm that build-time operator updates satisfy
C-D12. If the owner requires post-install/runtime message changes, that is a
separate availability and cache design; it cannot be smuggled into this
no-new-cache client delta.

The same message is rendered in the global outage panel and every blocked
action dialog. Action-specific localized prefixes may state that booking,
cancellation, a medical request, payment, or SOS was not sent, but they do not
create a second operator message or alternate contact source.

## 9. Internationalization and accessibility

Every new static string is added to `intl_en.arb`, `intl_hi.arb`, `intl_ta.arb`,
`intl_te.arb`, and `intl_ml.arb`, then regenerated. This includes state labels,
exact timestamp labels, cache-unavailable copy, retry text, mutation-not-sent
prefixes, contact button semantics, SOS telephone direction, and screen-reader
announcements. No new hardcoded English is permitted.

Timestamps use the active patient locale and explicit local timezone. The
banner exposes state changes through accessible live-region semantics without
reannouncing on every countdown/backoff tick. Colour is not the only outage
indicator, the contact action has a descriptive semantic label, and large-text
layout is covered by widget tests.

## 10. Failure behavior

- No cache: show the global message and a localized “not available on this
  device” state; never show a spinner indefinitely or stale in-memory content.
- Corrupt cache or timestamp: refuse that view and preserve current logging
  redaction.
- Message asset invalid: render the bundled approved locale fallback and log a
  non-PHI configuration diagnostic.
- Contact launch failure: keep the phone/contact value visible and selectable;
  do not claim the call was placed.
- Readiness parse/identity/clock failure: remain in outage and display the same
  user message; technical reason stays in redacted diagnostics.
- Recovery during a form: re-enable submission only after stable readiness;
  never auto-submit the form.
- Outage during a request: do not retry a mutation as an offline action. The
  ordinary HTTP request may have an ambiguous server outcome, so the UI says
  “could not confirm” and directs the patient to the approved contact rather
  than asserting failure or retrying automatically.

## 11. Exact Step 2 file ledger

This ledger is proposed only; Step 1 edits none of these files.

### 11.1 Shared core — one additive file, named

| File | Delta |
|---|---|
| `packages/vhhealth_core/lib/models/api_response.dart` | Add optional `DateTime? CachedApiResponse.cachedAt`. Existing constructor callers remain source-compatible; no Staff behavior changes. A current search found no Staff consumer of `CachedApiResponse`. |

No shared readiness service, connectivity service, queue, Staff widget, export,
or configuration file changes.

### 11.2 Patient core

| File | Delta |
|---|---|
| `apps/patient/lib/core/outage/patient_outage_controller.dart` | New patient readiness adapter, state machine, probe single-flight/backoff, session/tenant stability, and test seams. |
| `apps/patient/lib/core/outage/patient_mutation_policy.dart` | New method/path inventory and default-deny block classification. |
| `apps/patient/lib/core/outage/patient_outage_message.dart` | New strict bundled-asset loader and locale/contact selection. |
| `apps/patient/lib/core/widgets/patient_outage_scope.dart` | New app-wide panel, blocked-action event handling, retry, accessibility, and localized rendering. |
| `apps/patient/lib/core/widgets/offline_banner.dart` | Replace DNS/English stale semantics with outage state and exact localized device timestamp. |
| `apps/patient/lib/core/services/api_client.dart` | Preserve typed codes, observe reads/503s, gate every mutating wrapper before I/O, and make outage reads cache-only with `cachedAt`. |
| `apps/patient/lib/core/services/health_sync_service.dart` | Refuse sync before source reads/watermark changes while outage/checking; never advance a sync marker on a blocked result. |
| `apps/patient/lib/core/offline/api_cache_manager.dart` | Return the existing exact timestamp without changing key, format, TTL, save set, or retention. |
| `apps/patient/lib/core/offline/record_cache_manager.dart` | Return existing manifest data with its existing `cachedAt`. |
| `apps/patient/lib/core/utils/cache_file_utils.dart` | Add read-only cached-file timestamp lookup; no new save or index behavior. |
| `apps/patient/lib/main.dart` | Own controller lifecycle/provider, wrap the authenticated app, remove queue replay, and suppress outage health sync. |
| `apps/patient/lib/core/offline/mutation_queue.dart` | Delete the unused enqueue/replay API. No migration reads, sends, or deletes a legacy secure-storage blob. |
| `apps/patient/pubspec.yaml` | Bundle the approved message asset only. |

### 11.3 Existing cached-view timestamp propagation

| Area | Files |
|---|---|
| Dashboard | `features/dashboard/providers/dashboard_provider.dart`, `features/dashboard/screens/dashboard_screen.dart` |
| Notifications | `features/notifications/screens/notifications_screen.dart` |
| Health-record manifest | `features/your_health/screens/your_health_screen.dart` |
| Consultation notes list/detail | `features/your_health/services/consultation_notes_repository.dart`, `features/your_health/widgets/consultation_notes_tab.dart` |
| Diagnostic results list/detail | `features/portal/services/structured_diagnostic_results_repository.dart`, `features/portal/screens/structured_diagnostic_results_screen.dart` |
| Referrals | `features/portal/services/patient_referrals_repository.dart`, `features/portal/screens/patient_referrals_screen.dart` |
| Lab list/detail/trend | `features/portal/services/lab_results_repository.dart`, `features/portal/screens/lab_results_screen.dart` |
| Discharge list/detail | `features/portal/services/discharge_summaries_repository.dart`, `features/portal/screens/discharge_summaries_screen.dart` |
| Proxy grants | `features/settings/models/record_access_grant.dart`, `features/settings/services/record_access_repository.dart`, `features/settings/screens/record_access_screen.dart` |
| Maternity | `features/maternity/models/anc_timeline.dart`, `features/maternity/services/maternity_repository.dart`, `features/maternity/screens/anc_timeline_screen.dart` |

Mutation feature files do not need scattered network guards: the `ApiClient`
gate is authoritative and the app-wide scope supplies the clear message. A
small number of action widgets may be edited only if a test proves they commit
optimistic local state before success; those additions require a ledger update
before implementation rather than an unreviewed expansion.

### 11.4 Message, i18n, and tests

| Files | Delta |
|---|---|
| `apps/patient/assets/config/patient_outage_message.json` | Add only after coordinator supplies the approved one-message record. |
| `apps/patient/lib/l10n/intl_{en,hi,ta,te,ml}.arb` and generated localization outputs | Add all new strings and regenerate. |
| `apps/patient/tool/validate_patient_outage_message.dart` | Validate schema, locales, size, contact URI, review metadata; print revision and SHA-256 receipt without message contents. |
| `apps/patient/test/core/outage/*_test.dart` | State, signal, anti-flap, identity, 503, rate-limit, message, mutation, no-network, and source-bypass tests. |
| Existing/new cache and widget tests under `apps/patient/test` | Exact timestamps, no new keys/writes, detail/list UI, accessibility, logout, no queue replay, optimistic-state refusal, and all five locales. |
| `packages/vhhealth_core/test/models/api_response_test.dart` | Additive `cachedAt` compatibility coverage. |

## 12. Step 2 verification and receipts

Implementation clearance requires all of the following evidence from the exact
lane SHA. These are build-time gates; they are not claimed by this doc-only
commit.

1. Workspace resolution and canonical Melos matrix:
   `dart pub get`, `melos bootstrap`, `melos run format`, `melos run codegen`,
   `melos run analyze`, and `melos run test`.
2. Focused patient suite:
   `flutter test` from `apps/patient`, including outage/cache/mutation/widget
   tests and the existing patient suite.
3. Localization:
   `melos run gen-l10n` followed by
   `node apps/patient/scripts/i18n-verify.mjs`, with all five locales and no new
   hardcoded outage copy.
4. Operational-copy receipt: focused backend and patient config tests prove the
   exact five-language shape, policy fence, facility contact validation,
   higher-revision replacement, source isolation, restart persistence, and ARB
   fallback. `openapi:check` and core-spec drift checks prove the additive wire
   contract.
5. Patient mobile builds on the repository's current release platform:
   Android debug APK plus release APK and AAB using non-secret receipt-safe
   configuration equivalent to `.github/workflows/release-patient.yml`.
6. Patient web/portal compile check:
   `flutter build web --release` from `apps/patient`. The repository has no
   current patient-web release workflow, so this proves compilation only and
   makes no deployment/support claim.
7. Static inventory checks proving no new `ApiClient.cachedGet`,
   `ApiCacheManager.save`, queue-enqueue, direct mutating `http` bypass, Staff
   edit, backend edit, or migration was introduced outside the cleared ledger.
8. Git receipts: clean worktree, exact baseline and implementation SHAs, scoped
   diff, branch push, and CI links/status. Never merge.

## 13. Coordinator clearance record — fulfilled 2026-08-02

The coordinator recorded these four explicit confirmations:

1. C-D12 is implemented default-ON as ordinary patient-client safety behavior,
   with no facility/continuity activation coupling.
2. The patient adapter may reuse the C2.2 contract/parser while replacing only
   the staff-identity prerequisite with stable authenticated patient-session
   and tenant checks.
3. The operator message is build-time updateable, versioned with the C-D6
   packet print cycle, and falls back to owner-approved bundled translations;
   runtime remote update is out of scope.
4. The exact approved message, translations, contact URI, packet revision, and
   approval reference are supplied before Step 2.

Those confirmations cleared Step 2 subject to the section 1A amendment.
