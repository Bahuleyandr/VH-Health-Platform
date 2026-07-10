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

> **▶ BUILD-COMPLETE MILESTONE (2026-07-09, main 671ad85cc).** Every authored build prompt in the library is DELIVERED and on main. Waves A/B COMPLETE; NL-5/6/7 complete; NL-8 P1-P5; NL-9 P1-P3; NL-10 B1-B3; NL-11 S1-S11; NL-12 S1-S9. Wave E (NL-13/14) DESIGN specs merged — build prompts NOT yet authored (next coordinator deliverable via section 11). Remaining work: (a) Wave E prompt authoring + build, (b) OPERATOR track per docs/GO_LIVE_RUNBOOK.md, (c) indigenous drug-KB content authoring (spec #463). No build backlog remains.


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
| NL-13..NL-14 (Wave E, quaternary depth) | Defined in roadmap §5-E (2026-07-07) — design kickoffs ready; see the one-month plan for sequencing |

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
- **A FRESH roll worktree needs `npm install` before any proof.** `git worktree add` checks out source but not node_modules; the seeder/ci-setup then die with `ERR_MODULE_NOT_FOUND ('pg'/'bcrypt')`. A REUSED worktree (already installed once) can skip it. The 'regen-only' chain variant that omits install is only safe on a reused worktree (#530 roll failed on a fresh one, 2026-07-09).
- **Chains hard-abort before push.** The QA PG (127.0.0.1:55432) can be down or die mid-chain;
  a chain that pushes anyway ships a half-regenerated roll (schema.prisma missing the branch's
  own models — cost two bad pushes on 2026-07-08). Every roll chain prechecks
  `psql .../postgres -c "SELECT 1"` and must abort BEFORE `git commit`/`git push` unless
  ci-setup-db, the seeder proof (`"failed": []`), `prisma db pull`, and `openapi:check` all
  passed. Restart: `pg_ctl -D D:/Dev/Tools/vhhealth-test-postgres-data -o "-p 55432 -h 127.0.0.1" -l <log> start`.
- **Branch-delete only after `gh pr view N --json state` == `MERGED`.** Deleting the head
  branch of an unmerged PR auto-closes it (#488 incident; recovered by push-back + reopen).
- **`--force-with-lease` needs the colon form** `--force-with-lease=refs/heads/<b>:<sha>`;
  the comma form silently degrades to a plain push (rejected as non-fast-forward).
- **Coordinator MAY squash a delivered PR branch** (`reset --soft <base>` + one commit +
  lease push) to clear secret-scan RANGE false positives: the range scan walks every PR
  commit, so a follow-up rename never cleans history (#499). We squash-merge anyway —
  intra-PR history is disposable. Only after the worker session is stood down.
- **Known-transient CI failures — rerun, do not debug:** (a) Melos workspace "Failed to
  download .../flutter//engine_stamp.json" (double-slash 404; Flutter bootstrap flake, hit
  #497 and #500 on 2026-07-08); (b) smoke route-crawl "Test timeout ... net::ERR_ABORTED /
  frame was detached" on routes the PR does not touch (dev-server collapse on a loaded
  runner, hit #512); (c) runner ENETUNREACH/ETIMEDOUT to Azure/Microsoft endpoints.
  `gh run rerun <run-id> --failed` then re-arm the gate.
- **Design kickoffs self-gate on their OUTPUT artifact.** Before launching any design/docs
  prompt, check `git ls-tree github/main:docs/superpowers/specs` for its deliverable — a
  kickoff run twice produces a duplicate spec (#509 vs #463). Every design prompt must open
  with a STOP-IF-DONE gate on its own output path, and the coordinator checks §9 status
  before handing out a kickoff line.
- **"Suite failed to run" ≠ regression.** A `Cannot find module` load failure in a worker or
  coordinator tree means STALE node_modules (deps merged since the last install — e.g.
  @node-saml after Wave A). `npm install` and re-run before escalating; a real main
  regression shows a test ASSERTION failure on a fresh install (billing-v2 false alarm, 2026-07-08).
- **Gates recheck `mergeable`.** Green checks do NOT imply mergeable — a roll against a
  stale local github/main leaves the branch CONFLICTING despite green CI (#503). The gate
  merges only on zero-non-green AND `mergeable == MERGEABLE`; fetch main with an explicit
  refspec (`git fetch github +refs/heads/main:refs/remotes/github/main`) right before rolling.

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
| 401–402 | NL-5 P4 pediatric packs | **on main** (#512 — NL-5 BUILD-COMPLETE) |
| 403 | N6-8 dental UI (if needed) | launched 2026-07-07 (round 3) |
| 404–407 | N6-3 donor processing | launched 2026-07-07 (round 3; start gate self-blocks until N6-2 on main) |
| 408–410 | NL-5 P2 + indigenous-KB substrate | launched 2026-07-07 (round 4) |
| 411–412 | N6-10 infusion chairs | launched 2026-07-07 (round 4) |
| 413–414 | N6-12 mortuary | launched 2026-07-07 (round 4) |
| 415–417 | N6-7 ophthalmology | launched 2026-07-07 (round 5) |
| 418–420 | N6-9 dialysis completion | launched 2026-07-07 (round 5) |
| 421–423 | N6-13 CSSD | launched 2026-07-07 (round 5) |
| 424–426 | NL11-S1 migration toolkit P1 | launched 2026-07-07 (Wave C/D round 1) |
| 427–428 | NL11-S2 developer portal P1 | launched 2026-07-07 (Wave C/D round 1) |
| 429–431 | NL8-P1 kiosk self-check-in | launched 2026-07-07 (Wave C/D round 1) |
| — | NL12-S4 SLSA + NL12-S5 Kyverno gate | launched 2026-07-07 — ZERO-MIGRATION slices (no block; any migration need = STOP and ask coordinator) |
| 432 | NL10-B1 Metabase module (build; deploy HELD) | launched 2026-07-08 (round 7) |
| 433–434 | NL11-S3 entitlements P1 | launched 2026-07-08 (round 7) |
| 435–438 | NL9-P1 consent-safe campaigns | **on main** (#500) |
| 439 | NL12-S1 NABH export (shipped via #505 with ZERO migrations) | unused gap — do not reuse |
| 440–442 | N6-11 physio/rehab | **on main** (#503) |
| 443–445 | NL11-S9 migration toolkit P2 | **on main** (#497) |
| 446–447 | NL-7 P4 pilot hardening (RTLS half stays owner-gated) | launched 2026-07-08 (round 8) |
| 448–449 | NL12-S2 SIEM export seam | **on main** (#501) |
| — | NL12-S3 500-bed load pack | **on main** (#499, zero-migration) |
| — | NL12-S7 DR replica | **on main** (#515, zero-migration) |
| — | NL12-S9 zero-trust | **on main** (#529, zero-migration) |
| — | NL12-S6 accessibility | **on main** (#531, zero-migration) |
| — | NL11-S10 engine mini-design gate | **on main** (#513, design-only) |
| 450 | NL8-P2 PHI-free queue displays (#502 used only 450) | **on main** (#502); 451 unused gap, do not reuse |
| 439 | NL12-S1 NABH (delivered #494 with ZERO migrations) | unused — documented gap, do not reuse |
| 451 | NL8-P2 (delivered #502 using only 450) | unused — documented gap, do not reuse |
| 452–453 | NL9-P2 NPS analytics | **on main** (#510) |
| 454–456 | NL8-P3 porter/transport | **on main** (#511) |
| 457–458 | NL9-P3 teleconsult follow-ups | launched 2026-07-08 (round 10 tranches) |
| 459–460 | NL8-P5 census/LOS | launched 2026-07-08 (round 10 tranches) |
| 461–463 | NL11-S08 SMART-on-FHIR writes P1 | **on main** (#523) |
| 464 | NL12-S8 cert cockpit | **on main** (#522) |
| 465 | NL10-B2 catalog embeds (deploy HELD) | **on main** (#525) |
| 466 | NL10-B3 digest/benchmarks (deploy HELD) | **on main** (#524) |
| 467 | NL11-S04 design tokens P1 | **on main** (#521) |
| 468 | NL11-S05 white-label P1 (#527 used 468 only) | **on main** (#527); 469 unused gap, do not reuse |
| 470 | NL11-S06 demo tenant P1 (migration-free) | **on main** (#526); 470 unused gap, do not reuse |
| 471–472 | NL11-S07 manuals/LMS P1 | **on main** (#530) |
| 473–474 | N6-14 linen (WAVE B COMPLETE) | **on main** (#518) |
| 475–477 | NL11-S11 interface engine P1 (gate S10 **on main** #513) | launched 2026-07-08 (round 10) |
| 478–481 | NL8-P4 scheduling optimization | **on main** (#528) |
| **Wave E — NL-13/NL-14 (authored 2026-07-09, prompts in build-prompts/; launch per readiness)** | | |
| 482–488 | NL13-P1 cath-lab workflow | authored; ROUND-1 launch-ready |
| 489–494 | NL13-P3 oncology staging/CTCAE/tumor-board | authored; ROUND-1 launch-ready |
| 495–502 | NL14-P1 ICU flowsheet depth | authored; ROUND-1 launch-ready (NL-7 P1 on main) |
| 503–507 | NL13-P2 stroke pathway | authored; round-2 |
| 508–512 | NL13-P4 nuclear-med/radiotherapy | authored; round-2 (after P3 oncology) |
| 513–517 | NL14-P2 code-blue/resuscitation | authored; round-2 (after ICU P1 data model) |
| 518–523 | NL14-P2 ED triage/trauma/MLC | authored; round-2 |
| 524–528 | NL14 ambulance/pre-hospital | authored; round-3 (manual-first) |
| 529–535 | NL14-P3 NICU/PICU | authored; round-3 (extends ICU P1) |
| 536–541 | NL14-P3 burns/TBSA | authored; round-3 (NL-5 content studio on main) |
| 542–545 | NL13-P5 CTVS/perfusion seam | authored; round-3 (minimal seam) |
| 546–554 | NL13-P6 transplant program (6 organs, live+deceased) | GATE CLEARED 2026-07-09; authored + launch-ready |
| 555+ | UNASSIGNED — next contiguous block (record in the launching docs PR) | — |

Gaps below 368 (358, 360, 362–365) are released reservations — do not reuse; continue from the top.
Each queued prompt carries its migration COUNT estimate; the number block is stamped at launch.

## 6. Worker rules (enforced by every prompt; summary for the coordinator)

Fresh worktree off `github/main` · copy `apps/backend/.env` from the main checkout ·
`npm --prefix apps/backend install` (+ admin / `dart pub get` as the prompt says) ·
run the prompt's start gate before anything · use only the assigned migration block ·
all §3 gates green · PR with a build ledger (scope, invariants held, migs used, exact test
commands + pass counts, deferrals) · **STOP after the PR** — the coordinator merges.

## 7. Decision log

- **2026-07-09 — NL13-P6 transplant scope (owner).** Organ scope = **Heart, Liver, Lung, Kidney, small bowel, multivisceral**; donor scope = **both living and deceased**. This clears the spec's hard pre-implementation gate (organ + donor scope). Block **546–554** assigned; NL13-P6 prompt un-gated + launch-ready. Robust-default sub-decisions (standing "most robust/future-proof" directive): transplant privilege keys SEEDED + enforced (credentialing-gated like chemo, N6-5 pattern); NOTTO export format/API, committee quorum values, and allocation boundaries remain OPERATOR-supplied — substrate builds inert + fail-closed, never encoding NOTTO allocation rules from model memory; `transplant_programs.organ` enum carries the six categories with multivisceral as a combined-organ program.

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

**LOCKED (Wave C/D, 2026-07-07 — owner: "best, most robust, future-proof"):** every spec recommendation adopted. NL-8: token-only displays; kiosk = QR+OTP primary with per-department supervised-tablet toggle; displays behind existing ingress; stale forecasts hidden. NL-9: patient_consents = single consent source (narrow new types); dedicated NPS table; admin/quality vs care-team approval split; Twilio stays; **RPM pilot cohort = HYPERTENSION** (BP-kit; post-discharge fast-follow). NL-10: Metabase first; BI never reads OLTP; vh_metabase no-BYPASSRLS marts-only; phase-1 internal-only; no native SQL; patient_uid hidden; digest in-app/push; benchmarks internal + cell thresholds. NL-11: phased-hybrid white-label; minimal internal LMS; SMART default-deny w/ super-admin production gating; **interface engine = PEER to NL-7 in v1** (mini-design gate before build); CSV-demographics-first toolkit; entitlements never hard-block urgent care. NL-12: inert evidence-building only; every external ceremony stays operator-gated (ADR-003 posture). Build prompts: `nl8-p*`, `nl9-p*`, `nl10-b*`, `nl11-s*`, `nl12-s*` in build-prompts/ (33 files; blocks assigned at launch).

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
| `wave-e-nl13-kickoff.md` | NL-13 quaternary suites **survey+design** | Wave B substantially landed ✓ | READY (design) |
| `wave-e-nl14-kickoff.md` | NL-14 critical-care/ED depth **survey+design** | same | READY (design) |
| `golive-readiness-kickoff.md` | `docs/GO_LIVE_RUNBOOK.md` — sequenced activation runbook | Week-3 of the month plan (or on demand) | READY (design) |
| `indigenous-drugkb-kickoff.md` | indigenous drug-KB program design spec | — | **MERGED** #463 |
| `nl13-p1-cath-lab.md` | cath-lab cases/readiness/procedure/dose/orders/device-links | NL-13 spec on main | authored; ROUND-1 (482–488) |
| `nl13-p2-stroke.md` | code-stroke activation, NIHSS, thrombolysis, pathway SLA | NL-13 spec on main | authored; round-2 (503–507) |
| `nl13-p3-oncology-staging.md` | TNM/AJCC staging, CTCAE toxicity, tumor board | NL-13 spec on main | authored; ROUND-1 (489–494) |
| `nl13-p4-nuclear-med-radiotherapy.md` | radiotherapy referrals/plans/fractions, nuc-med orders (coordination-only) | NL-13 spec + P3 | authored; round-2 (508–512) |
| `nl13-p5-ctvs-perfusion.md` | minimal CTVS/perfusion record seam | NL-13 spec on main | authored; round-3 (542–545) |
| `nl13-p6-transplant.md` | transplant program: candidates/waitlist/committee/NOTTO export | gate CLEARED (6 organs, live+deceased) | authored; launch-ready (546–554) |
| `nl14-p1-icu-flowsheet.md` | ICU chart depth, ventilation/weaning, line/tube/drain → N6-6 denominators | NL-14 spec + NL-7 P1 ✓ | authored; ROUND-1 (495–502) |
| `nl14-p2-code-blue-resus.md` | durable resuscitation_events + append-only timeline | NL-14 spec + ICU P1 | authored; round-2 (513–517) |
| `nl14-p2-ed-triage-trauma-mlc.md` | tenant triage-scale policy, trauma activation, surveys, MLC gate | NL-14 spec on main | authored; round-2 (518–523) |
| `nl14-p2p3-ambulance-prehospital.md` | pre-hospital handover (manual-first), acceptance signatures | NL-14 spec on main | authored; round-3 (524–528) |
| `nl14-p3-nicu-picu.md` | NICU/PICU feeds-fluids, neonatal scoring, phototherapy (extends ICU P1) | NL-14 spec + ICU P1 + NL-5 peds ✓ | authored; round-3 (529–535) |
| `nl14-p3-burns.md` | burn chart, TBSA region map, content-governed fluid worksheet | NL-14 spec + NL-5 content studio ✓ | authored; round-3 (536–541) |

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

## 11. Prompt-Authoring Guide — turning a merged spec into build prompts (successor procedure)

When a design spec merges, the coordinator authors its build prompts. This is the ONLY
recurring authoring act in the pipeline; execute it mechanically:

1. **Slice by the spec's own phased plan / slice table.** One prompt per phase/slice.
2. **Copy an existing prompt as the skeleton** (`nl6-05-credentialing.md` for single-batch
   backend+admin; `nl7-p1-device-gateway.md` for multi-surface) and fill exactly: title ·
   spec pointer (file + §) · start gate (`git grep` for the prerequisite ON MAIN —
   mount-path literals live in app.js, not routes/) · workspace block (worktree + branch
   names) · scope bullets (COPY the spec's deliverables, cite its line refs — do not
   re-design) · migration COUNT from the spec with numbers left as <ASSIGN> · tests (the
   spec's test strategy verbatim) · deliverable contract (branch, PR title, build ledger,
   STOP after PR, never force-push after the PR opens) · kickoff line.
3. **Parallel-safety:** list each prompt's touched surfaces. Overlap ONLY in
   schema.prisma/openapi.json = parallel-safe (the train regenerates); overlapping service
   files = sequence them.
4. **Sizing:** S ≤1.5k LOC · M 1.5–4k · L 4k+. Split L unless the spec argues cohesion.
5. **Registry:** land prompts via a docs PR that ALSO assigns each launched prompt's
   contiguous migration block in §5. Never assign numbers in chat alone.
6. **Launch:** paste each kickoff line into a fresh worker session with the block filled in.
7. **Verify + merge per §4** as PRs land; refresh §5/§8/§9 in the next docs PR.

Every step is CLI- or paste-executable — a human coordinator can run the entire loop.

## 12. One-month plan (and its successors)

The current calendar: `docs/superpowers/plans/2026-07-07-one-month-execution-plan.md` —
week-by-week launches, owner decisions, operator actions, dependency map, and exit criteria
through 2026-08-10 (covers Wave C/D build-out, Wave E design+start, the go-live-readiness
rehearsal). At month end, draft the next month's plan from the §9 remainder into a new
dated file in the same directory — that review is itself a docs PR.
