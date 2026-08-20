# Terminology & drug-KB enablement runbook

How to take the clinical terminology spine (ICD-10/11, SNOMED CT, LOINC, ATC),
per-surface diagnosis-coding enforcement, lab analyzer-code → LOINC mapping,
and the licensed drug knowledge base live. Every feature follows the same
fail-closed pattern as the rest of the platform (see
[`DARK_GATE_ENABLEMENT.md`](DARK_GATE_ENABLEMENT.md)):

```
effective = env kill switch  AND  tenant flag  AND  imported content
```

The third layer is the terminology twist: where a payment gateway needs a
provider-config row, these features need **imported content** — concepts,
mapping rows, or an active licensed KB source. With nothing flipped and
nothing imported, every surface behaves byte-identically to today: the staff
picker stays ICD-11, admin document fields stay free text, lab ingest stamps
nothing, prescriptions run the existing safety path.

All three layers are visible per tenant in the SUPER_ADMIN **Integrations &
Gates** console (`/dashboard/integration-gates`) as the
`terminology_coding` / `lab_loinc_mapping` / `drug_kb` gates, with the
blocking layer named ("provider config" there means content). Day-to-day
curation — code-system inventory, binding curation, tenant settings incl.
per-surface enforcement, drug-KB sources, lab code mappings — lives in the
ADMIN **Terminology & Knowledge** console (`/dashboard/terminology`).

**The repository ships no licensed content.** Every release file below is
downloaded by the operator under the facility's own license and imported via
CLI. Do not commit any of these files, and do not paste their rows into
fixtures — the test fixtures under `src/tests/fixtures/terminology/` are
tiny synthetic sets with fabricated codes, and must stay that way.

---

## 0. License acquisition (external, has lead time — start first)

| Content | Where | License reality |
|---|---|---|
| SNOMED CT | NRCeS (National Resource Centre for EHR Standards) national release — Indian affiliate license, free for Indian healthcare facilities | Register the facility with NRCeS; download the **RF2 Snapshot** zip. NOT redistributable. |
| LOINC | Regenstrief Institute — loinc.org account | Free license; download the release zip containing **`Loinc.csv`**. No redistribution. |
| ICD-11 | WHO ICD-API (icd.who.int/icdapi) | Register an API client for OAuth2 client-credentials (`WHO_ICD_CLIENT_ID`/`SECRET`). Also download the **SimpleTabulation** linearization export (TSV/XLSX→TSV) for offline import. |
| ICD-10 | Already federated | The legacy `icd10_codes` catalog is federated into `terminology_concepts` on day one (migration 275) — no download needed. |
| ATC | WHO Collaborating Centre (whocc.no) | Annual index release; import via the generic CSV path. |
| Drug KB (DDI/allergy/dose/IV) | Commercial procurement: FDB, Medi-Span, CIMS, or CDSCO-derived datasets | Proprietary. The vendor export is transformed owner-side ONCE into the neutral CSV contract of `drug-kb-import.mjs`, then imported repeatedly. Track `license_status` / expiry in `drug_kb_sources`. |

## 1. Terminology content import

All commands run from `apps/backend` with `DATABASE_URL` pointing at the
target environment (in-cluster: run from a maintenance pod or port-forward).
Every import stamps provenance (`terminology_import_batches`,
`terminology_code_systems.version/imported_at`) and supports `--dry-run`.

```bash
# SNOMED CT — NRCeS RF2 Snapshot (point at the Snapshot/Terminology dir
# containing sct2_Concept_Snapshot*.txt + sct2_Description_Snapshot*.txt):
node scripts/terminology-import.mjs --system SNOMED_CT \
  --rf2 /data/SnomedCT_India/Snapshot/Terminology --version IN-2026-07

# SNOMED → ICD-10 ExtendedMap refset (same release zip):
node scripts/terminology-import.mjs --system SNOMED_CT \
  --rf2-map /data/SnomedCT_India/Snapshot/Refset/Map/der2_iisssccRefset_ExtendedMapSnapshot_IN_20260701.txt \
  --version IN-2026-07

# LOINC — official Loinc.csv from the Regenstrief release zip:
node scripts/terminology-import.mjs --system LOINC \
  --loinc /data/Loinc_2.81/LoincTable/Loinc.csv --version 2.81

# ICD-11 — WHO SimpleTabulation export (ships with the WP1 importer flag;
# skips chapter/block rows, imports category rows, strips title dashes):
node scripts/terminology-import.mjs --system ICD11 \
  --icd11-tabulation /data/icd11-simpletabulation-2026.tsv --version 2026-01

# ATC — WHOCC index (generic CSV path: code,display[,category]):
node scripts/terminology-import.mjs --system ATC \
  --csv /data/atc-2026.csv --version 2026

# Add --full to sweep concepts missing from this release to inactive;
# add --dry-run first on every new file format.
```

WHO ICD-API (live ICD-11 search with local-cache fallback) is configured by
env — backend configmap + Sealed Secret, ArgoCD sync:

```
WHO_ICD_CLIENT_ID=…          # OAuth2 client credentials
WHO_ICD_CLIENT_SECRET=…
WHO_ICD_RELEASE_ID=2026-01   # optional pin
```

`who_icd_configured` in the Integrations & Gates env facts confirms presence
(values are never shown).

### Verification

```sql
SELECT system_key, version, concept_count, imported_at
  FROM terminology_code_systems ORDER BY system_key;
SELECT system_key, COUNT(*) FROM terminology_concepts
 WHERE status = 'active' GROUP BY system_key;
```

Then in the Terminology & Knowledge console: **Code systems** tab shows the
same counts; `GET /api/v1/terminology/search?system=SNOMED_CT&q=fever`
returns concepts.

## 2. Diagnosis-coding enforcement (death cert, claims, discharge)

Layers (fail-closed AND; ICD-10 content is present day-one):

| Layer | Setting | How |
|---|---|---|
| Env | `TERMINOLOGY_CODING_ENFORCEMENT=warn` (later `block`) | backend configmap + ArgoCD sync; `off` default |
| Tenant | `tenant_terminology_settings.coding_enforcement.<surface>` = `warn`/`block` per surface (`death_certificate`, `insurance_claim`, `discharge_summary`) | Terminology & Knowledge console → Tenant settings, or `PUT /api/v1/terminology/settings` |
| Content | active ICD-10 concepts | federated automatically (migration 275) |

Flip order per tenant: env to `warn` deployment-wide → one pilot tenant's
surfaces to `warn` → watch `terminology_audit_events` for warning volume →
tighten surface-by-surface to `block` only after the pilot's warning rate is
near zero. SNOMED pickers additionally require the tenant flag
`snomed_pickers_enabled` (same settings tab) AND imported RF2 content.

Rollback: set the surface back to `off` (instant, per tenant, per surface),
or env `TERMINOLOGY_CODING_ENFORCEMENT=off` to kill deployment-wide.

## 3. Lab analyzer-code → LOINC mapping

| Layer | Setting | How |
|---|---|---|
| Env | `LAB_LOINC_MAPPING_ENABLED=true` | backend configmap + ArgoCD sync |
| Tenant | `settings.labLoincMapping.enabled=true` | tenant-settings PATCH (SUPER_ADMIN) |
| Content | active rows in `lab_analyzer_code_mappings` (+ LOINC import for catalog bindings) | Terminology & Knowledge console → Lab mappings, or `POST /api/v1/lab/code-mappings` |

Enrichment is **fail-open at ingest**: an unmapped code never blocks a
result; it is counted and surfaced in the coverage report
(`GET /api/v1/lab/code-mappings/coverage`). Populate mappings from the
coverage report's unmapped-codes list, verifying each against the local
catalog's confirmed LOINC bindings (Bindings tab).

Verification: send/replay a test ORU with a local code that has an active
mapping → the `lab_results` row gains `loinc_code`; with the gate off or the
mapping absent, the row is byte-identical to before.

Rollback: flip the tenant flag off, or deactivate individual mapping rows.

## 4. Licensed drug KB + deterministic matching

```bash
# 1. Transform the vendor export (FDB / Medi-Span / CIMS) into the neutral
#    CSV datasets once, owner-side. Then import (repeatable):
node scripts/drug-kb-import.mjs --source cims_2026q2 --vendor CIMS \
  --version 2026.2 --dataset monographs --csv monographs.csv
node scripts/drug-kb-import.mjs --source cims_2026q2 --vendor CIMS \
  --version 2026.2 --dataset interactions --csv interactions.csv
# … repeat for allergy-groups, cross-reactivity, condition-cautions,
#   dose-ranges, iv-compatibility.

# 2. Formulary links (WP4 dataset; catalog_code_or_name,drug_key[,confidence]):
node scripts/drug-kb-import.mjs --source cims_2026q2 \
  --dataset catalog-links --csv catalog_links.csv

# 3. Review coverage, then activate the licensed source and retire the
#    starter set (WP4 subcommands replace the old raw-SQL step):
node scripts/drug-kb-import.mjs --report
node scripts/drug-kb-import.mjs --activate-source cims_2026q2
node scripts/drug-kb-import.mjs --deactivate-source vh_starter_set
```

| Layer | Setting | How |
|---|---|---|
| Env | `DRUG_KB_DETERMINISTIC_MATCHING=true` | backend configmap + ArgoCD sync |
| Tenant | `settings.drugKb.deterministicMatching=true` (and optionally `settings.drugKb.counterSaleAdvisory=true` for the OTC advisory) | tenant-settings PATCH (SUPER_ADMIN) |
| Content | an **active non-starter** source in `drug_kb_sources` (+ catalog links) | import + activation above |

Safety posture is unchanged by these flips: prescription/CPOE save stays
fail-closed through `validatePrescriptionSafety`; the KB engine itself stays
fail-open on KB absence; everything new (counter-sale advisory) is
advisory-only and never blocks a sale.

Verification: `GET /api/v1/drug-kb/status` shows the licensed source active
and `starter_only=false`; `GET /api/v1/drug-kb/coverage` shows the formulary
match rate; a `POST /api/v1/drug-kb/check` with two known-interacting
monograph keys returns the interaction finding. Watch
`drug_kb_sources.license_expires_at` — the console warns on expiry.

Rollback: `--deactivate-source <key>` restores the previous KB (the engine
re-resolves by priority), or flip the tenant flag off to fall back to the
name-substring path.

## 5. Gate-flip order (summary, per tenant)

1. Import content (section 1/3/4) — inert by itself.
2. Verify content via SQL + the Terminology & Knowledge console.
3. Flip the env switch (deployment-wide, still dark per tenant).
4. Flip the pilot tenant's flag; verify on that tenant.
5. Watch the Integrations & Gates console: the gate should read ON with no
   blocking layer; every other tenant still names `tenant_setting`.
6. Roll out tenant-by-tenant per the per-tenant rollout playbook.
