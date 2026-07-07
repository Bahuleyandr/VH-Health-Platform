# BUILD: NL-5 P2 — Drug-KB procurement seams (code only; content = owner)

**Spec:** `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md` §2 + §Phased Plan P2. Read it fully, plus `_worker-common.md` beside this file (all its rules apply).
**Gate note:** the vendor transform skeleton is buildable only AFTER the owner picks a KB vendor (playbook §7 Open Decision 1). Everything else in this prompt proceeds now.

## Start gate
```
git fetch github
git grep -q "Licensed Drug KB / DDI" github/main -- docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl5-p2`, branch `feat/nl5-p2-drugkb-seams` (per `_worker-common.md`). Backend only.

## Scope (spec §2.2 — and NOTHING from §2.1's content side)
1. **Source precedence** (1 migration, number assigned at launch): `drug_kb_sources.priority INTEGER NOT NULL DEFAULT 100`; `loadKb()` (`drugKnowledgeBaseService.js:134–171`) dedupes per dataset key (interaction pair a<b, dose (drug,route,population), caution (drug,icd10_prefix), allergy group, IV pair) keeping the highest-priority row. Preserves the documented starter-cutover drill while making the overlap window deterministic.
2. **Acceptance harness** `apps/backend/scripts/drug-kb-acceptance.mjs`: fixed clinical scenario battery (known contraindicated pair, pediatric overdose, CKD NSAID, penicillin cross-reactivity, IV ceftriaxone+Ringer's-lactate) run through `evaluateDrugKb` against the active sources; emits a snapshot; document the starter-deactivation step recording that snapshot into `drug_kb_sources.metadata` (mirror the mig-351 `acceptance_snapshot` pattern).
3. **Vendor transform contract**: a doc (`apps/backend/docs/RUNBOOKS/drug-kb-import.md`) defining vendor-export → the seven neutral CSVs `drug-kb-import.mjs` already accepts; plus ONE fixture-tested transform SKELETON for the chosen vendor **only if the playbook decision log names one** — otherwise ship the doc + synthetic "licensed-shaped" fixture and stop there.
4. **Admin visibility**: surface existing `drugKbStatus()` (sources/counts/`starter_only`) read-only on the admin clinical-AI/governance page. No new mutation surface (imports stay CLI).
5. **Author NO drug content.** Zero new interaction/dose/allergy rows. The ~90-row `vh_starter_set` stays as-is.

## Tests (deep-test tier)
Two active sources with conflicting severities → higher-priority wins; `drugKbStatus.starter_only` intact; acceptance battery green against a synthetic licensed-shaped fixture source; cutover drill — starter deactivated ⇒ findings switch `kb_source`, floor checks 1–7 byte-identical before/after (extend `drug-kb.deep.test.js` + `cpoe-cds-fail-closed.deep.test.js`).

## Deliverable
PR `NL-5 P2: drug-KB source precedence + acceptance harness` with build ledger. Migrations: **1** (from your assigned block). Stop after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl5-p2-drugkb-seams.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
