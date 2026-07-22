# Unified Care Pathways S2d — Patient Radiology/AP Result Release

**Date:** 2026-07-22

**Grounding revision:** `c015c731bf12cb24f2258a4553bacf7dfdfb1887`

**Migration:** `592_structured_diagnostic_result_release.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## Outcome and boundary

S2d gives each immutable, clinician-signed Radiology or Anatomical Pathology generation its own patient-release state. The patient portal can list and read only the current generation when the shared release predicate proves it eligible. A correction or addendum creates a successor generation and a fresh release state; it never inherits the predecessor's hold or explicit-release evidence.

This slice reuses the configured portal result-release delay. It does not choose a new clinical time, send a patient or guardian notification, backfill historical reports, flip a pathway mode, deploy, or migrate a live database. Notification recipients and wording remain governance-gated.

## Authoritative release rule

A current structured diagnostic generation is patient-visible only when all of the following are true:

1. it has a matching `diagnostic_result_release_states` row for the same tenant, patient and immutable generation;
2. it is not on hold;
3. it was explicitly released or the existing configured release delay has elapsed; and
4. if its signed classification is `critical`, `abnormal`, or `indeterminate`, the generation has a signed `doctor_disposition` action.

The fourth rule enforces the approved D5 decision. For critical results, the existing action service already rejects doctor disposition until the generation-specific acknowledgement receipt has stopped its SLA, so a visible critical report necessarily has both acknowledgement and doctor-action evidence. Normal results need no doctor task and retain automatic release/closure plus the existing discretionary doctor-reopen path.

## Mutation safety

Hold, lift-hold and explicit early release:

- derive the human actor from authentication before any existence or idempotent return;
- run inside the tenant transaction;
- lock the release row and compare `state_version` before mutation;
- reject superseded generations;
- require a reason for a hold;
- append canonical timeline and audit evidence atomically; and
- publish normal release eligibility only after the release state and canonical evidence have been written in the same transaction.

Once any result is patient-visible, it cannot be newly hidden because the owner has not approved a patient-release reversal policy. Doctor re-review remains available without withdrawing patient-visible evidence.

## Patient and staff projections

The patient API returns list metadata and a detail projection only for the authenticated patient or an authorized results proxy. Radiology detail includes signed report text and signed addenda up to the current generation. AP detail includes diagnosis text and signed addenda; gross description, microscopy, synoptic fields, malignancy flags, internal classification evidence and working notes are not projected.

The patient app adds one localized Imaging and Pathology Reports surface. The staff Radiology view and the existing Anatomical Pathology worklist show release state and permit hold/lift/early-release actions. Both hide early release for actionable classifications until doctor disposition exists. No new notification/deep-link type is inferred; only the exact portal list route is allowlisted.

## Evidence and rollout

Migration 592 is forward-only and has no backfill. Existing generations therefore fail closed until registered through a deliberate later backfill plan. Activation remains evidence-gated by the Diagnostics reconciliation and rollout program; this slice does not change tenant mode.

Required proof includes fresh migration build, schema drift, RLS/tenant contracts, 818-table seed coverage, actor-before-disclosure, CAS and doctor-action gates, Radiology/AP deep suites, order-to-action journey coverage, patient projection/widget tests, staff API/widget tests, OpenAPI drift, lint and Flutter analysis.
