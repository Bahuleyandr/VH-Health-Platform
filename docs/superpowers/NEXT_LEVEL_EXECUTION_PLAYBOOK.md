# Next-Level Program — Execution Playbook (coordinator handbook)

**Last updated:** 2026-07-07 at main `117a5b7b` (round 1 CLOSED: #450/#452/#453/#456 all merged, PASS zero-corrections; round 2b launched). Operator: LOINC 2.82 imported to QA (97,314 concepts, batches 14–15).
**Purpose:** make the NL-1..NL-12 pipeline survivable across model/agent changes. Everything a
coordinator needs — state, loop, drills, verification method, migration registry, decision log,
and the full build-prompt library — lives in this file and `docs/superpowers/build-prompts/`.
Nothing load-bearing lives only in one agent's session memory.

**Takeover:** give any capable agent (Codex, Opus, Claude, anything with repo + `gh` access):

> Read `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md` and act as the program coordinator.
> Bring the In-Flight Tracker up to date first (`gh pr list`, `git branch -r`, migration ls),
> then continue the loop from wherever it actually stands — trust the repo over this document.

---

## 1. Program map and status

Roadmap: `docs/NEXT_LEVEL_ROADMAP.md` (§5 program definitions, §6 wave sequencing, §7 do-not-build,
§8 execution conventions, §9 status board). Waves: **A** NL-1..4 (trust/rails/table-stakes) ·
**B** NL-5..7 (clinical content + physical hospital) · **C** NL-8..10 (flow/engagement/BI) ·
**D** NL-11..12 (productization/assurance, partly parallel to B/C).

| Program | Status @ 2026-07-07 |
|---|---|
| NL-1 identity | **BUILD-COMPLETE 14/14** — P4 SAML verified+merged PR #452 (`4e864c16`, mig 368, 2026-07-07). Remaining = operator (IdP pilot tenant) |
| NL-2 NHCX | BUILD-COMPLETE (inert/mock-first; operator gate = sandbox enrolment) |
| NL-3 teleconsult | BUILD-COMPLETE (recording off; operator gate = LiveKit media edge + deploy) |
| NL-4 basics | SHIPPED (reschedule, consent signatures mig 356, EMPI hardening) |
| NL-5 terminology/content | Spec MERGED. **P1 MERGED** (PR #453 `cdd477fa`, migs 369–370, PASS zero-corrections). **P3 LAUNCHED** (round 2); P2/P4 prompts ready |
| NL-6 departmental | Plan MERGED. **N6-1 MERGED** (PR #450 `d4b33514`, migs 375–377, PASS zero-corrections). **N6-4 + N6-5 LAUNCHED** (round 2); rest ready (donor slices owner-gated) |
| NL-7 device gateway | Spec MERGED. **P1 MERGED** (PR #456 `117a5b7b`, migs 371–373 [374 unused], PASS zero-corrections — gateway service, registry, associations, alarm policy). **ROUND 1 CLOSED.** P2 + P3 LAUNCHED (round 2b) |
| NL-8..NL-10 (Wave C) | Not started — kickoff design prompts ready in the library |
| NL-11..NL-12 (Wave D) | Not started — kickoff prompts ready; NL-12 heavily operator-track |

## 2. The pipeline loop

1. **Design**: for a design-first program, a worker session produces a grounded spec
   (`docs/superpowers/specs/…`) as a docs-only PR. Grounded = every claim cites `path:line`
   read from the repo, never the roadmap's one-liners (the NL-6 survey proved roadmap
   "absent" rows stale — migs 286–296 had already shipped six departments' backends).
2. **Verify (coordinator)**: content-verify the spec PR — see §4. Fix small factual errors
   on-branch; merge; sync both remotes.
3. **Decisions**: put the spec's Owner Decisions to the owner. Defaults: adopt every spec
   recommendation unless the owner overrides (§7 records the standing posture).
4. **Build prompts**: launch workers from `docs/superpowers/build-prompts/` (§9 index).
   Assign migration blocks from §5 at launch. Parallel-safe sets are listed per prompt.
5. **Verify + merge-train (coordinator)**: as worker PRs land — content-verify against the
   spec (§4), fix-on-branch if small, roll (regen), CI, squash-merge, sync, prune (§6).
6. Repeat. Wave C/D start by running step 1 with their kickoff prompts.

## 3. Ground rules (non-negotiable, learned the hard way)

- **Shared-checkout ban.** `D:\Dev\Projects\VH Health\VH-Health-Platform` is the coordinator's
  read-only window. Workers (and any coordinator write) use fresh worktrees
  (`git -C <main> worktree add <dir> -b <branch> github/main`). PR #427 carried 2,919 foreign
  lines because two sessions shared one checkout. Read-only agents can still silently switch
  its branch — re-verify `git branch --show-current` before trusting it.
- **Remotes:** `github` (github.com/Bahuleyandr/VH-Health-Platform) + `origin` (Forgejo,
  tailnet). Sync pair is exactly these two. After every merge:
  `git fetch github main && git push origin refs/remotes/github/main:refs/heads/main`.
- **Deploy is HELD** until the operator track opens. Everything lands inert/flagged;
  k8s manifests land unreferenced by the root kustomization.
- **Migrations**: raw SQL in `apps/backend/src/migrations/NNN_*.sql` is source of truth;
  after applying run `npx prisma db pull` and commit `schema.prisma` with the `.sql`.
  Numbers come ONLY from the §5 registry — workers never ls-and-take.
- **PHI tables**: mig-356 RLS boilerplate (tenant_id NOT NULL w/ GUC default, ENABLE+FORCE
  RLS, tenant_isolation policy); inserts pass explicit tenant_id (the GUC-default literal trap).
- **Canonical timeline invariant** (`docs/CANONICAL_CLINICAL_TIMELINE.md`): every successful
  patient-facing clinical write = detail row + `clinical_timeline_events` +
  `clinical_audit_events` in one transaction. Non-patient subjects (donors, staff credentials,
  machine QA) use audit/register trails instead — never fake a patient event.
- **Gates**: backend = chunked `node apps/backend/scripts/run-ci-jest.mjs` (needs Postgres
  :5433); any route change = `openapi:generate` + `openapi:check` (+ `melos codegen` when
  Flutter consumes it); admin = `npm run type-check` inside apps/admin (not raw tsc);
  staff-app strings = all five `intl_*.arb` (i18n guard enforces); raw SQL =
  `lint:raw-params` (spread args; `::type` casts inside jsonb builders).
- **`gh pr checks --watch` exits 1 spuriously — always re-query.** GHA on this repo works
  (billing resolved); `gh run watch --exit-status` also lies.

## 4. Coordinator verification method (specs AND build PRs)

1. **Scope-cleanliness first**: `gh pr view N --json files,additions,deletions` — only the
   expected files (the #427 check).
2. **Content-verify grounded claims**: sample the load-bearing `path:line` citations and every
   "X is absent/has no Y" claim with direct greps — positive claims usually hold; negative
   claims are where agents err. Precedent hit-rate: NL-5 13/13 exact; NL-7 25/26 (bcrypt→sha256
   fixed); NL-6 all real incl. two defect discoveries, 2 spec errors fixed.
3. **Invariant check** against §3 + the spec's own Binding Invariants section.
4. **Fix-on-branch (small factual errors)**: never via the shared checkout. Server-side:
   fetch file (`git show github/<branch>:<path>` to scratch), edit, then
   `gh api -X PUT repos/Bahuleyandr/VH-Health-Platform/contents/<path>` with a JSON body
   file passed via `--input` (inline base64 args exceed the arg-list limit). Get the blob
   `sha` from a GET on the same endpoint first.
5. **Merge**: `gh pr merge N --squash -R Bahuleyandr/VH-Health-Platform` from OUTSIDE any
   checkout of the repo (never `--delete-branch` from inside one — it switches branches).
   Delete the remote branch separately; sync Forgejo; prune.
6. **Merge-train roll** (when multiple build PRs land): expect `openapi.json` and
   `schema.prisma` conflicts — resolve by REGENERATING, never hand-merging: fresh-DB
   migrations + `prisma db pull` for schema; `openapi:generate` for the json;
   `dart pub get` for `pubspec.lock`. Verify regenerated == committed before merging the next.

## 5. Migration number registry (the only allocation authority)

| Block | Owner | Status |
|---|---|---|
| …–367 | shipped through NL-1 P3 SCIM | on main |
| 368 | NL-1 P4 SAML | in flight |
| 369–370 | NL-5 P1 | **on main** (#453) |
| 371–373 | NL-7 P1 | **on main** (#456); 374 unused — documented gap, do not reuse |
| 375–377 | N6-1 | **on main** (#450) |
| 378–380 | N6-5 credentialing | launched 2026-07-07 (round 2) |
| 381–382 | NL-5 P3 content studio | launched 2026-07-07 (round 2) |
| 383–386 | N6-4 histopath | launched 2026-07-07 (round 2) |
| 387–390 | N6-2 donor intake | launched 2026-07-07 (gate resolved: blood centre) |
| 391–393 | NL-7 P2 cold-chain | launched 2026-07-07 (round 2b, gate open: P1 on main) |
| 394–396 | NL-7 P3 CMMS | launched 2026-07-07 (round 2b, gate open: P1 on main) |
| 397–400 | N6-6 infection depth | launched 2026-07-07 (round 3) |
| 401–402 | NL-5 P4 pediatric packs | launched 2026-07-07 (round 3) |
| 403 | N6-8 dental UI (if needed) | launched 2026-07-07 (round 3) |
| 404–407 | N6-3 donor processing | launched 2026-07-07 (round 3; start gate self-blocks until N6-2 on main) |
| 408–410 | NL-5 P2 + indigenous-KB substrate | launched 2026-07-07 (round 4) |
| 411–412 | N6-10 infusion chairs | launched 2026-07-07 (round 4) |
| 413–414 | N6-12 mortuary | launched 2026-07-07 (round 4) |
| 415+ | UNASSIGNED — coordinator assigns the next contiguous block at prompt launch and records it here (update this table in the same PR that launches, or the next docs PR) | — |

Gaps below 368 (358, 360, 362–365) are released reservations — do not reuse; continue from the top.
Each queued prompt carries its migration COUNT estimate; the number block is stamped at launch.

## 6. Worker rules (enforced by every prompt; summary for the coordinator)

Fresh worktree off `github/main` · copy `apps/backend/.env` from the main checkout ·
`npm --prefix apps/backend install` (+ admin / `dart pub get` as the prompt says) ·
run the prompt's start gate before anything · use only the assigned migration block ·
all §3 gates green · PR with a build ledger (scope, invariants held, migs used, exact test
commands + pass counts, deferrals) · **STOP after the PR** — the coordinator merges.

## 7. Decision log

**LOCKED (Wave A, 2026-07-06):** Keycloak-first; no admin JIT ever, no staff JIT until SCIM;
SUPER_ADMIN local TOTP always; NHCX inert/mock-first until sandbox; LiveKit + embedded TURN,
recording OFF, TELE = queue badge.

**ADOPTED DEFAULTS (Wave B, 2026-07-07 — every spec recommendation stands unless the owner
overrides):** embedded-Postgres terminology (no Snowstorm/sidecar; revisit triggers in NL-5
§1.2) · production-prescribing tenants need a licensed drug KB or written risk acceptance ·
two-person med-set approval, no self-approval · IAP packs operator-supplied pending
redistribution confirmation · re-import on release / minimum annually · NL-6 slice order as
tabled (§6 of the plan) · generic 1–4 peer-review scale @ 2% sampling (no RADPEER licensing) ·
privilege catalog seed list as suggested · optical dispensing OUT · donor↔patient separate
subjects · in-cluster gateway (no dedicated edge node) · alarm defaults 10/30-min suppression,
2-of-3 artifact filter, 5-min charting interval, governance-committee ownership · CMMS
auto-creates work orders from device faults (with open-WO dedupe) · RTLS = contract only until
a vendor pilot is scheduled.

**OPEN — owner action required (none block currently-launched work):**
1. ~~Drug-KB vendor~~ **RESOLVED 2026-07-07: INDIGENOUS** — no vendor (lock-in refused; roadmap §7 override recorded there). Content = evidence-gated in-house program: versioned `drug_kb_sources` editions, clinical-governance authoring, acceptance-battery release gate, aushadhi dataset as brand/composition seed. Needs its own design spec before content authoring starts (queue a kickoff prompt when capacity frees). NL-5 P2 re-scoped accordingly (vendor transform dropped).
2. ~~Blood centre vs storage centre~~ **RESOLVED 2026-07-07: FULL BLOOD CENTRE** (target model; licensing scope accepted) — N6-2/N6-3 build as specced. Register formats (Decision 3) still needed before N6-3 exports lose the "format pending" flag.
3. Statutory register formats — source the real current forms (blood-bank set, dialyzer reuse,
   IDSP/IHIP); until then slices ship exports flagged "format pending".
4. Monitor vendor/fleet + device-VLAN & firewall rules with hospital IT (gates NL-7 pilot
   bring-up, not build). Cold-chain procurement rule: local-push-capable sensors only.
5. NRCeS / LOINC / WHO-ICD (cloud vs self-hosted; recommend self-hosted) / WHOCC ATC
   enrolment owners + dates.
6. A clinician to replace the `DAYCARE_OPHTHALMOLOGY_V1` placeholder text (mig 230).
7. Peer-review sampling rate + alarm-policy parameter ownership formally assigned to the
   clinical governance committee.

**Operator-track board (pre-existing):** NHCX sandbox enrolment (long pole) · LiveKit media
edge + deploy · IdP pilot tenant · cluster activation items from earlier programs.

## 8. In-flight tracker (update on takeover)

- **NL-1 P4 SAML** — DONE (verified+merged #452 `4e864c16`). Historical: branch `feat/nl1-p4-saml` (Codex worktree
  `D:/Dev/_codex/worktrees/VH-Health-Platform-nl1-p4-saml`), mig 368. Verify the PR per NL-1
  spec `specs/2026-07-05-nl1-enterprise-identity-design.md` §12 P4: both signing modes accepted
  and unsigned rejected; audience/recipient/ACS mismatch rejected; replay cache works
  multi-replica; tenant A/B metadata mix-up rejected; `jwtMiddleware` still rejects SAML
  artifacts (VH JWTs only); encrypted-assertion support where configured; migration slot 368;
  patient surface untouched. Then roll → CI → squash-merge → sync.
- **NL-5 P1 / NL-7 P1 / N6-1** — launched 2026-07-07 (branch names + reservations in §5;
  prompt copies in `build-prompts/`). Verify each against its spec section + ledger.

## 9. Build-prompt library index (`docs/superpowers/build-prompts/`)

`_worker-common.md` holds the shared mechanics; every prompt references it.
Launch protocol: assign a migration block (§5), paste the kickoff line (bottom of each prompt)
into a fresh worker session. Keep ≤3–4 workers concurrent; any same-wave prompts marked
parallel-safe may overlap.

| File | Builds | Gate | Status |
|---|---|---|---|
| `nl5-p1-terminology-releases.md` | release versioning, tenant settings, ICD-11 flip | spec on main | **MERGED** #453 |
| `nl5-p2-drugkb-seams.md` | source priority, acceptance harness, admin status **+ indigenous substrate (provenance, editions, lint/diff)** | spec + indigenous-KB spec on main | **LAUNCHED** (migs 408–410) |
| `nl5-p3-content-studio.md` | order-set lifecycle, import format, studio UI | spec on main | **MERGED** #461 |
| `nl5-p4-pediatric-packs.md` | growth LMS table + IAP, immunization packs | spec on main | **LAUNCHED** (migs 401–402) |
| `nl7-p1-device-gateway.md` | MLLP gateway, registry, association, alarm policy | spec on main | **MERGED** #456 |
| `nl7-p2-cold-chain.md` | cold-chain tables, excursion engine, board | NL-7 P1 merged ✓ | **LAUNCHED** (migs 391–393) |
| `nl7-p3-cmms.md` | work orders, schedules, calibration certs | NL-7 P1 merged ✓ | **LAUNCHED** (migs 394–396) |
| `nl7-p4-rtls-hardening.md` | RTLS seam (gated) + pilot hardening | P1–P3 merged + Decision 4 / RTLS pilot | GATED |
| `nl6-01-radiology-reporting.md` | templates, peer review, TAT, timeline fix | plan on main | **MERGED** #450 |
| `nl6-02-donor-intake.md` | donors, screening, deferrals, collection | gate RESOLVED: blood centre ✓ | **MERGED** #457 |
| `nl6-03-donor-processing.md` | TTI, components, traceability, registers | N6-2 imminent; registers ship "format pending" until Decision 3 | **LAUNCHED** (migs 404–407) |
| `nl6-04-histopath.md` | AP cases/blocks/slides/reports | N6-1 merged ✓ | **MERGED** #460 (coordinator fixed Decimal wire leak) |
| `nl6-05-credentialing.md` | privilege catalog, approvals, expiry alerts | plan on main | **MERGED** #458 (after coordinator roll — QA-DB contamination fix) |
| `nl6-06-infection-depth.md` | isolation orders, HAI, outbreaks, hand hygiene | N6-5 merged ✓ | **LAUNCHED** (migs 397–400) |
| `nl6-07-ophthalmology.md` | encounter link, biometry, cataract bundle, UI | plan on main | READY |
| `nl6-08-dental-ui.md` | odontogram UI, seeds, billing linkage | plan on main | **LAUNCHED** (mig 403 if needed) |
| `nl6-09-dialysis-completion.md` | reuse register, machine QA, billing hook | plan on main (register format note) | READY |
| `nl6-10-infusion-chairs.md` | chairs + bookings on chemo cycles | plan on main | **LAUNCHED** (migs 411–412) |
| `nl6-11-physio.md` | referral→plan→sessions greenfield | plan on main | READY |
| `nl6-12-mortuary.md` | slots + custody chain on death records | plan on main | **LAUNCHED** (migs 413–414) |
| `nl6-13-cssd.md` | instrument sets, sterilization loads | plan on main (N6-5 soft-first) | READY |
| `nl6-14-linen.md` | par-stock + laundry cycles | plan on main; do LAST | READY |
| `wave-c-nl8-kickoff.md` | NL-8 patient-flow **design spec** | Wave B build mostly landed | READY (design) |
| `wave-c-nl9-kickoff.md` | NL-9 engagement/CRM **design spec** | same | READY (design) |
| `wave-c-nl10-kickoff.md` | NL-10 embedded-BI **design spec** | same | READY (design) |
| `wave-d-nl11-kickoff.md` | NL-11 productization **survey + slice plan** | may start parallel to B/C | READY (design) |
| `wave-d-nl12-kickoff.md` | NL-12 assurance **plan** (heavily operator) | same | READY (design) |

Wave C/D kickoffs produce SPECS, not code — after each spec merges, run loop steps 2–4 to
generate that program's build prompts (model them on the NL-5/6/7 ones here).

## 10. Grounded platform facts every coordinator must know (verified 2026-07-07)

- `api_keys` hashing = **prefixed sha256 + `crypto.timingSafeEqual`** (`apiClientService.js`),
  not bcrypt. Device-registry credentials copy this pattern.
- `feature_flags` (`featureFlagService.js`) is **not tenant-scoped** — per-tenant toggles use
  the mig-351 `composition_search_settings` pattern (per-tenant cache, fail-closed).
- `notificationOutbox` retries: `retry_count < 3`, 5-min spacing, 2-min drain cron.
- `checkVitalAnomalies` (`vitalSignMonitor.js`) has **no dedupe** and pushes CRITICAL alerts to
  `recorded_by` — NL-7 P1 adds device-path suppression + retargets device-source notifications.
- Radiology emits **zero canonical timeline events** today and folds findings/impression into
  one text column (`radiologyService.js:400–406`) — N6-1 fixes both.
- `hasActivePrivilege` has exactly ONE consumer (chemo, `chemoService.js:571`,
  `REQUIRE_ADMIN_PRIVILEGE()` env flag). Theatre checks site-mark STATE, not privileges.
- `PATHOLOGIST_SIGN_ROLES` includes ADMIN/LAB_INCHARGE; `RADIOLOGY_REPORT_SIGN_ROLES` is
  `[RADIOLOGIST]` only. AP reports need a new `AP_REPORT_SIGN_ROLES = [PATHOLOGIST]`.
- No MLLP/TCP listener exists anywhere; HL7 is HTTP-only (`/api/v1/hl7/receive`, HMAC
  per-tenant). Canonical vitals table = `vitals_chart` (`patient_vitals` is the legacy path).
- Cluster ingress = Cloudflare Tunnel → ingress-nginx, ZERO inbound ports; LAN devices reach
  the backend only via the NL-7 gateway design (NodePort on cluster VLAN).
- Start-gate authoring: mount-path literals live in `apps/backend/src/app.js`, NOT under
  `src/routes/` — gate on both (`git grep X -- apps/backend/src/app.js && git grep Y --
  apps/backend/src/routes`). A gate that greps only routes/ false-negatives.
- Terminology + drug-KB content tables are GLOBAL (no tenant_id/RLS — mig 275/307/277 stance);
  never commit licensed content (SNOMED RF2, LOINC, vendor KB, IAP tables pending Decision 6).
