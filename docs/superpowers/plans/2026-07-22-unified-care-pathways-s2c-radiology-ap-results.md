# Unified Care Pathways S2c Radiology/AP Result Loop — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-22-unified-care-pathways-s2c-radiology-ap-results-design.md`

**Base:** `28791c4019600f24caa689623c66ce4d60dd1985`

**Branch:** `feat/care-pathways-s2c-radiology-ap-results`

**Migration:** `591_radiology_ap_diagnostic_generations.sql`

## Scope guard

Connect signed Radiology/AP reports and addenda to the existing immutable generation, pathway,
critical-acknowledgement and doctor-action rails. Keep all tenant modes unchanged.

Do not infer clinical meaning, choose timings/recipients/visibility, backfill legacy reports, add a new
workflow engine, change Stroke/STEMI or OBGyn, activate a tenant, migrate production, deploy or notify.

## Tasks

1. Add RED migration/service tests for structured source evidence, append-only versions, source FKs,
   RLS, exact replay and classification boundaries.
2. Add migration 591 and regenerate Prisma schema from a fresh migration build.
3. Add explicit structured classification/significance validation shared by Radiology/AP adapters.
4. Add the typed Radiology/AP immutable generation adapters and minimal-PHI outbox publication.
5. Make Radiology sign-off atomic with generation creation; replace blob mutation with a structured
   append-only addendum ledger.
6. Make AP sign-off/addenda atomic with generation creation and preserve the existing source ledger.
7. Materialize generation-specific critical acknowledgement task/SLA only in `active`, with exact named
   ownership and no fallback.
8. Require that acknowledgement evidence before a critical Radiology/AP doctor action can close;
   supersede predecessor acknowledgement work on a corrected generation.
9. Extend reconciliation and inbox enrichment for the new typed sources.
10. Add Radiology staff sign-off/addendum classification controls and focused model/widget tests.
11. Run migration, backend focused/deep/journey, raw-params, OpenAPI/Prisma/schema, Flutter focused,
    lint and authoritative sharded gates; leave activation and deployment untouched.
