# Unified Care Pathways S2d — Implementation Plan

1. Add generation-scoped Radiology/AP patient-release state with tenant RLS, composite clinical foreign keys, immutable identity and versioned compare-and-set mutation.
2. Register a fresh release row atomically with every structured sign-off or addendum generation.
3. Extend the shared portal release decision so normal results follow the existing release delay/hold rule and actionable results additionally require signed doctor disposition.
4. Add authenticated staff hold/lift/early-release endpoints with canonical audit/timeline evidence and generic non-disclosing authorization failures.
5. Add patient list/detail APIs that return only the current eligible generation and only patient-safe report fields.
6. Add patient and staff application surfaces without adding notification recipients, clinical timings, historical backfill or activation.
7. Prove fresh migration, seed coverage, tenancy, actor order, CAS, clinical release gating, immutable amendment behavior, portal projections, OpenAPI, lint, analysis and focused journeys before opening the pull request.
