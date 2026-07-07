# Drug-KB Edition Import Runbook

This runbook is for operator-supplied or VH-authored drug knowledge-base editions. It is substrate guidance only: do not commit licensed exports, restricted government tables, copied source text, or clinical drug-content packages unless the owner has explicitly approved that storage model and every row is original VH text with provenance.

## Package Shape

Each edition ships as the seven neutral CSVs already accepted by `apps/backend/scripts/drug-kb-import.mjs`:

- `monographs.csv`
- `interactions.csv`
- `allergy-groups.csv`
- `cross-reactivity.csv`
- `condition-cautions.csv`
- `dose-ranges.csv`
- `iv-compatibility.csv`

Future indigenous editions use one immutable `drug_kb_sources` row per edition. Use a concrete source key such as `vh_indigenous_2026q3` with `source_family='vh_indigenous'`, a human version label in `version`, and `license_note='internal provenance/citations'`. Rollback is re-activating a prior accepted edition row, not overwriting a source in place.

## Required Provenance

Every content row must carry:

- `provenance` JSON with `content_basis`, `license_decision_id`, source/reviewer rationale, and edition metadata.
- `source_refs` JSON array naming reviewed source registry IDs and license status.
- `license_status`, `review_status`, author, clinical reviewer, pharmacy reviewer, and approval columns.

Run structural lint before import:

```bash
node apps/backend/scripts/drug-kb-lint.mjs \
  --manifest apps/backend/src/tests/fixtures/drug-kb/synthetic-indigenous-v1/manifest.json
```

The lint checks schema, references, license/review status, and provenance completeness. It does not judge clinical correctness.

## Import

Import each dataset against the target `DATABASE_URL`. Indigenous candidate editions should land inactive until acceptance is recorded:

```bash
node apps/backend/scripts/drug-kb-import.mjs \
  --source vh_indigenous_2026q3 \
  --source-family vh_indigenous \
  --version 2026.Q3 \
  --vendor "VH Health" \
  --license-note "internal provenance/citations" \
  --source-license-status hospital_owned \
  --edition-status candidate \
  --priority 500 \
  --inactive \
  --dataset monographs \
  --csv /secure/operator/drug-kb/vh_indigenous_2026q3/monographs.csv
```

Repeat for all seven datasets. The aushadhi brand-to-composition seed path is the artifact directory consumed by `apps/backend/scripts/import-drug-reference.mjs`; the expected artifact is `dist/<date>/drugs.jsonl`. Use that composition/match output only as the monograph and alias coverage seed, not as clinical safety authority.

## Acceptance And Activation

Run the acceptance battery and record its snapshot before activation:

```bash
node apps/backend/scripts/drug-kb-acceptance.mjs \
  --source vh_indigenous_2026q3 \
  --record-source vh_indigenous_2026q3
```

The source-family activation guard requires `metadata.acceptance_snapshot` before an active `vh_indigenous` edition can be saved.

Activate the accepted edition:

```sql
WITH accepted_source AS (
  SELECT '<accepted_source_key>'::text AS source_key
)
UPDATE drug_kb_sources
   SET is_active = TRUE,
       edition_status = 'accepted',
       activated_at = NOW(),
       updated_at = NOW()
 WHERE source_key = (SELECT source_key FROM accepted_source)
   AND source_family = 'vh_indigenous'
   AND metadata ? 'acceptance_snapshot';
```

Deactivate the starter only after the accepted edition passes and the owner-approved coverage gate is met. Record the same acceptance snapshot on the starter row as deactivation evidence:

```sql
WITH accepted_source AS (
  SELECT '<accepted_source_key>'::text AS source_key
)
UPDATE drug_kb_sources
   SET is_active = FALSE,
       deactivated_at = NOW(),
       metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
          '{starter_deactivation_snapshot}',
          (SELECT metadata->'acceptance_snapshot'
             FROM drug_kb_sources
            WHERE source_key = (SELECT source_key FROM accepted_source)),
          TRUE
        ),
       updated_at = NOW()
 WHERE source_key = 'vh_starter_set';
```

## Review Diff

Before release approval, compare the candidate against the currently active edition:

```bash
node apps/backend/scripts/drug-kb-edition-diff.mjs \
  --from vh_starter_set \
  --to vh_indigenous_2026q3
```

The diff reports added, removed, and changed structural rows for reviewer workflow. It does not score clinical appropriateness.
