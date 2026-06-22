# Codex Handoff — VH Health Platform remaining work

Transient working doc (2026-06-22). Delete after cross-check. The durable list of
remaining work is [`ROADMAP.md`](ROADMAP.md); this file is the agent-executable
slice of it.

---

## 0. READ FIRST — what a coding agent can and cannot do here

`ROADMAP.md` looks large, but **most of it is `[OPERATOR]` / `[EXTERNAL]` /
`[PROCUREMENT]` work that no coding agent can perform** — sealing a DB role on a
live cluster, running a DR restore drill, ABDM/NABH/DPDP certification, buying a
GPU, rotating secrets on a live cluster. **Do NOT attempt those (Part B).** If you
"fix" them you are hallucinating progress.

**Equally important: this repo already has a LOT built.** Multiple prior audits
over-counted "gaps" by grepping for a guessed name and missing the real service
file. Three items the roadmap listed as undone are already present in code
(credentialing, NABH indicators, FHIR write POSTs). **So your FIRST move on any
non-trivial task is RECON: find the existing implementation and EXTEND/gap-fill —
do not rebuild.** When in doubt, read before you write.

Your scope:
- **Part A** = do it (genuine, bounded code).
- **Part B** = do NOT touch (operator/external/procurement).
- **Part C** = propose a design + failing tests for human review; do NOT
  autonomously ship (clinical-governance / big-integration / procurement-blocked).

---

## 1. Repo orientation

Monorepo. Read the authoritative in-repo docs before coding:
[root `CLAUDE.md`](../CLAUDE.md) and **[`apps/backend/CLAUDE.md`](../apps/backend/CLAUDE.md)**
(the §"Phase 0.5 conventions" + "Security Checklist" sections are load-bearing).

| Path | Stack |
| --- | --- |
| `apps/backend` | Node 22, Express 5, PostgreSQL 17, Prisma (`$queryRaw*`), Jest |
| `apps/admin` | Next.js 16, React 19, TypeScript |
| `apps/patient`, `apps/staff` | Flutter 3.41 |
| `packages/vhhealth_core` | shared Dart |

`main` is green on GitHub CI (Backend CI + Smoke E2E + Canonical CI). Don't break it.

---

## 2. How to RUN & VERIFY (mandatory — do not declare done on "looks right")

**Bring up a Postgres** for backend tests (QA cluster, db `vhhealth_test` @ `127.0.0.1:55432`):
```
node apps/backend/scripts/qa-cluster-up.mjs
```
**Backend tests — use the CHUNKED runner** (single-process `npm test` OOMs; connect as a superuser/`postgres`):
```
node apps/backend/scripts/run-ci-jest.mjs           # all chunks
# a single file while iterating:
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/vhhealth_test NODE_ENV=test JWT_SECRET=x API_KEY=x \
  node --experimental-vm-modules apps/backend/node_modules/jest/bin/jest.js --runInBand <pattern>
```
**Backend lint + contracts:**
```
npm --prefix apps/backend run lint            # includes lint:raw-params
npm --prefix apps/backend run swagger:validate
npm --prefix apps/backend run check:schema-drift   # after any migration
```
**Admin:**
```
npm --prefix apps/admin run lint && npm --prefix apps/admin test && npm --prefix apps/admin run build
```
**TZ trap:** the QA DB session TZ is `Asia/Calcutta` (IST); CI Postgres is UTC.
Any `::timestamptz` / `CURRENT_DATE` / `AT TIME ZONE` logic can pass in one TZ and
fail in the other. Verify tz-sensitive SQL by simulation at a fixed instant
(`SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date`), not just by running the test on
this box.

---

## 3. HARD conventions (violating these breaks CI or prod — non-negotiable)

- **Raw SQL params are SPREAD, never an array:** `prisma.$queryRawUnsafe(sql, ...params)`.
- **A bare `$N` reused in two contexts needs an explicit `::type` cast** or Postgres
  throws `42P08 inconsistent types deduced for parameter $N`. Example that bit us:
  `SET status = $2 ... WHERE $2 = 'approved'` → must be `$2::text` at *every* use.
  Params inside `jsonb_build_object/array(...)` also need `::type`. `npm run lint:raw-params` catches some, not all.
- **`ON CONFLICT` must target the CURRENT unique.** Multi-tenancy made many uniques
  composite `(tenant_id, X)` — a stale `ON CONFLICT (X)` throws `42P10`. Check the
  live constraint before writing an upsert.
- **Migrations are raw SQL + source of truth:** add `apps/backend/src/migrations/NNN_*.sql`
  (tracker-driven, applied once). After a migration that touches a Prisma-modelled
  table, regenerate `prisma/schema.prisma` via `npx prisma db pull` and run
  `check:schema-drift`. The two commit together.
- **Tenant RLS:** wrap tenant-scoped reads/writes in `setTenant`/`setTenantTx`
  (`src/lib/prisma.js`). Plain `$queryRaw*` bypasses RLS by design. PHI inserts must
  carry an explicit `tenant_id` where the column default is GUC-reading.
- **Canonical clinical timeline invariant:** every successful patient-facing clinical
  write persists the detail row **plus** one `clinical_timeline_events` row **plus**
  one `clinical_audit_events` row **in the same transaction** (see
  [`docs/CANONICAL_CLINICAL_TIMELINE.md`](CANONICAL_CLINICAL_TIMELINE.md)). PHI routes
  need `phiAccessLogger()`.
- **Response/error/format:** `success(res, data, msg)` / `error(res, msg, code)`;
  throw `AppError` (not raw `Error`); role helpers from `roleHelpers.js` (no inline
  role arrays); never `SELECT *`; never return `err.message` to clients; Winston
  `logger.*` (no `console.log`); `prismaReadOnly` for analytics/exports.
- **Tests:** new backend tests go in `src/tests/*-deep.test.js` (integration, real DB)
  and assert EXACTLY (no `[200,500]`). Gate on `process.env.DATABASE_URL`.
- **`gh run watch --exit-status` lies** (exits 0 on failures) — use `gh run view`.

---

## 4. Git rules

Branch off `main`. Two remotes: `github` (GitHub) + `origin` (Forgejo) — pushes go
to **both**. **Do NOT push or merge unless the human says so** — run the local gates,
leave a clear per-task PR description, and stop. Never push to the 5 archived source
repos. (No-op note: a plain push to `main` does not auto-deploy — ArgoCD pins
digests; only tags publish images.)

---

## PART A — CODE to do (verified-genuine; ROI order)

### A1 — Close the `text/*` upload MIME-spoof gap  *(small, security)*
- **File:** `apps/backend/src/config/uploadConfig.js:17` — `allowedMimeTypes`
  includes `'text/plain', 'text/csv', 'text/rtf'`. Magic-byte validation lives in
  `validateFileContent()` (`src/middleware/uploadMiddleware.js`).
- **Risk:** an HTML payload uploaded as `text/csv`/`text/plain` → stored XSS when
  served/rendered.
- **Do:** first grep who actually uploads `text/*` (if nobody, just drop them from
  the allowlist). If some feature needs CSV/text upload, add a sniff in
  `validateFileContent` that rejects `text/*` bodies whose leading bytes look like
  HTML/script (`<!doctype`, `<html`, `<script`, `<svg`, leading `<`), and ensure
  responses set a non-renderable content disposition.
- **DoD:** a `*-deep.test.js` proving an HTML-bodied `.csv`/`.txt` is rejected;
  existing upload tests still green; `npm --prefix apps/backend run lint` clean.

### A2 — Remove `'unsafe-eval'` from the admin CSP  *(small, security)*
- **File:** `apps/admin/src/middleware.ts:201` (`script-src ... 'unsafe-eval'`),
  comment at `:193` says it's "pending the Sentry/workbox eval removal".
- **Do:** determine what still requires eval (Sentry replay / workbox). Reconfigure
  it to not need eval (e.g. Sentry without the eval-using integration, or a build
  that precompiles), then drop `'unsafe-eval'`. If a dependency genuinely needs it,
  document precisely which and why, and prefer a scoped nonce/hash over a blanket
  allowance.
- **DoD:** `npm --prefix apps/admin run build` passes; admin app loads with no CSP
  eval violation in the console; note any Sentry/workbox config change in the PR.

---

## PART A′ — RECON-THEN-GAP-FILL (these PARTIALLY EXIST — do NOT rebuild)

The roadmap framed these as missing; they are not. **Open the existing file, map its
current coverage against the bullet, and implement only the genuine delta with
tests.** If coverage is already complete, say so and close the item — don't invent
work.

### A3 — FHIR R4 **write** coverage
- **Exists:** `apps/backend/src/routes/fhir/fhirRoutes.js` already has `router.post`
  handlers at lines ~1019/1068/1124; `services/fhir/fhirAdapter.js`;
  `fhir-server.deep.test.js`; SMART scope enforcement.
- **Recon:** list exactly which resources have create/update today
  (`grep -n "router\.\(post\|put\|patch\)" fhirRoutes.js` + read each). The roadmap
  target is write support for **Patient, Observation, Encounter, MedicationRequest**.
- **Gap-fill only the missing ones**, mapping FHIR→internal via `fhirAdapter`,
  enforcing SMART **write** scopes + tenant RLS + the canonical-timeline+audit
  invariant + `phiAccessLogger`, validating with the existing FHIR validator. Update
  swagger + the conformance statement.
- **DoD:** per added resource: deep tests for happy-path, scope-denied, validation-fail,
  and tenant-scoped isolation.

### A4 — NABH quality-indicator pack
- **Exists:** `apps/backend/src/services/quality/nabhIndicatorService.js` (+ piecemeal
  indicators across `aiOutcomeScoreboardService`, `nursingAssessmentService`, etc.).
- **Recon:** what indicators does `nabhIndicatorService` already compute/expose? The
  roadmap target is a *consolidated* exporter of the NABH indicator set.
- **Gap-fill:** assemble any missing indicators into the consolidated pack/endpoint
  (read-mostly; use `prismaReadOnly`; no new PHI exposure).
- **DoD:** endpoint/report + deep test with seeded data; lint clean.

### A5 — Provider credentialing & privileging
- **Exists:** `apps/backend/src/services/staff/credentialingService.js`.
- **Recon:** what does it cover (registration numbers? privileges? expiry alerts)?
- **Gap-fill** the missing pieces (likely privilege scoping and expiry alerting —
  reuse the escalation/notification pattern: `resultsInboxService` +
  `escalationEngineService` + `withJobLock` cron). Any new tables → raw-SQL migration
  + `prisma db pull` + `check:schema-drift`.
- **DoD:** migration (if any) + service/routes + deep tests; drift check clean.

---

## PART B — OUT OF SCOPE (operator / external / procurement — you CANNOT do these)

Do not attempt, do not "stub", do not claim done. These are humans-against-a-live-system:
- Seal the non-superuser/`NOBYPASSRLS` DB role + flip RLS enforcement live; PreSync
  migration Job; Kyverno Audit→Enforce; timed DR restore drill; monitoring/alerting
  activation; verify first R2 backup; downtime LAN-mirror volume. (`GO_LIVE_ACTIVATION_CHECKLIST.md`)
- Rotate provider secrets on the live cluster; purge operator-machine artifacts;
  rotation calendar. (`SECURITY_HARDENING_CHECKLIST.md`)
- ABDM M1/M2/M3 certification, external pen test, NABH assessment, DPDP audit,
  CERT-In tabletop. (external engagements)
- GPU node, commercial drug-KB license, label/barcode printers + analyzer drivers,
  eSign provider. (procurement)
- CERT-In **180-day** log retention: this is an infra change (Loki retention / an
  archive/SIEM tier), an operator action — not app code.

---

## PART C — propose-only (clinical-governance / big-integration / procurement-blocked)

Do NOT autonomously ship. If you work these, produce a design doc + failing tests +
a PR description for human review:
- The ~21 unbuilt single-module **AI wrappers** + AI productionization. Clinical-AI
  modules ship `enabled=false`, route through two-person approval + eval/drift/bias
  gates, and are decision-support-only. A coding agent must not enable or ship a
  clinical AI module unsupervised. (`archive/AI_FEATURE_GAP_BACKLOG.md`)
- **Live HL7v2 interface engine** (Mirth-class ADT/ORM/ORU to external hospital
  systems) — large integration; parser/generator substrate exists.
- **eSign/DSC signing stack** — blocked on the procurement of a provider (Part B);
  the tamper-evident hash chain (`documentIntegrityService`, mig 324) is already done.

---

## Definition of done (every Part A / A′ task)

1. The matching local gate passes: backend → `run-ci-jest.mjs` (or the targeted file)
   **+** `lint` **+** `check:schema-drift` if a migration; admin → `build` + `lint` + `test`.
2. New behavior has a deep/integration test that asserts exactly.
3. Convention-clean: `::type` casts on reused raw params, composite `ON CONFLICT`,
   RLS + timeline + audit on clinical writes, no `SELECT *`, no `err.message` to
   clients, parameterized queries, `phiAccessLogger` on PHI routes.
4. Branch off `main`; **do not push/merge**; leave a per-task PR description listing
   files changed, the gate output, and any follow-ups.

## How we will cross-check here

Per task: re-run the same local gate; read the diff specifically for the §3
convention violations (42P08 casts, `ON CONFLICT` targets, RLS/timeline/audit on
clinical writes, tz-sensitive SQL, `err.message` leaks); confirm the deep tests
assert exactly; then run the GitHub CI (Smoke E2E + Backend CI + Canonical) before
any merge.
