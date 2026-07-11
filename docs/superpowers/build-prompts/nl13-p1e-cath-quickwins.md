# BUILD: NL-13 P1e — Cath quick wins: live readiness evidence (crossmatch + e-sign consent), pre/post-cath order sets, post-PCI follow-up loops

You are implementing **NL-13 P1e (Cath workflow quick wins)** for the VH Health Platform — a light integration slice that wires the merged cath P1 readiness checklist (migs 482–488) to LIVE evidence from three existing rails. This is a **reuse slice**: almost no new tables; you consume existing modules read-only. Read `_worker-common.md`, `apps/backend/CLAUDE.md`, and `apps/backend/src/services/clinical/cathLabService.js` FIRST.

**SEQUENCING: launch AFTER NL13-P1b (cath reporting) is MERGED to main** — extends the same cathLabService + staff cath workbench. The start gate enforces this. May run in parallel with P1d/P1f (coordinator resolves workbench-file overlaps at roll).

## Start gate (run before anything)
```
git fetch github
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^55[5-7]_"   # P1b MERGED
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^48[2-8]_"   # cath P1 on main
```
Exit 0 → proceed. Exit 1 → STOP and report (P1b must land first).

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1e"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1e-cath-quickwins github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get
```

## Environment & isolation (MANDATORY)
- Shared-checkout ban; scratch-DB schema-regen law; openapi generate/check/sync-core; staff strings all five locales; dart-format-check before push; phi/schema-drift checks.
- **Your reserved migration numbers: 567–568** (use ONLY if a mapping/config table is genuinely needed; this slice should need at most one). Siblings: P1b 555–557, P1c 558–562, P1d 563–566, P1f 569–571.
- Proxy-allowlist + routePolicy law for any new admin family.
- **Locate each integration seam by grep on YOUR worktree before writing code** (blood-bank crossmatch service, e-signature/consent artifact rails from NL-4, content-studio order-set content from NL-5, follow-up loop rails from NL9-P3). If a named rail does not exist on main, STOP and report — do NOT build a substitute.

## Scope (deliver all — reuse, never fork)
1. **Live blood-readiness evidence** — the cath case readiness checklist's blood item auto-attaches evidence from the blood bank rails: live crossmatch/reservation status for the patient (grep `crossmatch` under `apps/backend/src`). READ-ONLY consumption — no writes to blood-bank tables. No crossmatch row → the readiness item stays manual exactly as today (NEVER fabricate or infer readiness).
2. **Consent readiness via e-signature** — when a signed consent artifact (NL-4 e-signature rails) of an owner-mapped consent template exists for the encounter, the consent readiness item shows `evidence: signed_consent` + artifact link. The template mapping is an **owner-decision inert slot** (per-tenant setting, mig-351 pattern — use mig **567** only if no existing settings surface fits); unmapped → manual item unchanged.
3. **Pre/post-cath order sets** — surface owner-published order-set content (NL-5 content studio; NO clinical content from model memory) in the staff cath workbench: "Apply pre-cath order set" / "Apply post-cath order set" actions that stage orders through the EXISTING CPOE rails (no new ordering path, standard CPOE validation/signing applies). No published set for the slot → buttons hidden (inert).
4. **Post-PCI follow-up loops** — on cath procedure-log completion, emit the completion fact to the NL9-P3 follow-up loop rails so owner-configured loop templates (e.g. post-PCI review, DAPT review — owner authors content) can trigger. Configuration-only seam: mig **568** ONLY if a procedure-type→loop-template mapping table is required and no generic trigger mapping exists. Inert until the owner publishes a template.
5. **Staff workbench** — readiness items render their live evidence chips (crossmatch status, signed-consent link); order-set buttons; strings all five locales.
6. **Audit** — evidence attachment/refresh and order-set application emit audit events through the existing helpers (order writes already ride CPOE's canonical path — do not double-write timeline events).

## Tests
- Unit: evidence resolution (crossmatch present/absent; consent mapped+signed / mapped+unsigned / unmapped); order-set staging goes through CPOE (assert no direct order-table writes); completion-fact emission; every inert path (no config → no buttons, no loops, no fabricated evidence).
- Deep (real DB): case → crossmatch row appears → readiness evidence live; signed consent artifact → consent evidence; apply order set → CPOE orders staged; complete procedure → loop trigger row; RLS both directions.
- Staff widget: evidence chips, button visibility matrix.
- Regression: cath P1/P1b suites green; blood-bank, e-sign, content-studio, NL9-P3 suites untouched and green.

## Deliverable
Branch `feat/nl13-p1e-cath-quickwins`, PR titled `NL-13 P1e: cath quick wins (live readiness evidence, order sets, follow-up loops)`. Build ledger. ALL checks green. **STOP after the PR**; one scope = one PR; no force-push after open.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1e-cath-quickwins.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 567–568 (use only if genuinely needed). STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
