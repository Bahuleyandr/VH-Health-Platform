# NL-11 Productization - Survey-Grounded Gap Inventory and Slice Plan

**Date:** 2026-07-07
**Status:** Survey + slice sequencing for owner sign-off; design/survey only - no code
**Branch:** `docs/nl11-productization-plan`
**Scope:** NL-11 Productization, across backend productization seams plus admin, patient, and staff clients

This plan follows the NL-6 pattern: survey first, name the gaps, then sequence small enough slices that implementation can land without mixing product shells, integrations, licensing, training, and migration risk in one build train.

## 1. Non-Goals and Program Boundaries

This PR is documentation only. It does not add code, routes, migrations, generated assets, seed data, UI, tests, deployment config, or migration-number reservations.

NL-11 owns the "buyable product shell" in the roadmap: shared design system and component parity across the three clients, white-label theming, license/entitlement packaging on the per-tenant module substrate, legacy-HIS migration toolkit, demo-tenant generator, manuals/tours/LMS, developer portal activation for `api_clients`, public SMART endpoints, FHIR R4 writes, and a Mirth-class HL7 interface engine (`docs/NEXT_LEVEL_ROADMAP.md:224`-`docs/NEXT_LEVEL_ROADMAP.md:229`).

Sibling-program boundaries:

- **NL-7 owns device transport, not the general interface engine.** NL-7 terminates device-native transports, authenticates devices, handles store-and-forward, associates devices to patients, and forwards into existing backend HTTP ingestion surfaces (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:51`). NL-11 owns system-to-system integration, channel UI, mapping/filter/transform pipelines, message routing, legacy HIS/LIS/PACS feeds, and migration importers (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:53`). NL-7 explicitly must not build channel UI, arbitrary transforms, ADT/ORM routing, or importer tooling (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:59`).
- **NL-10 owns embedded BI.** NL-10 is the self-serve analytics and embedded Metabase/Superset program (`docs/NEXT_LEVEL_ROADMAP.md:220`). NL-11 may expose package/entitlement status and demo data, but BI embedding remains out of scope.
- **NL-12 owns assurance and certification.** NL-12 owns ISO 27001/SOC 2, pen-test remediation, HA/DR/scale proof, and formal certification posture (`docs/NEXT_LEVEL_ROADMAP.md:231`). NL-11 can generate training evidence and integration audit trails, but it does not claim cert completion.
- **Deployment remains held.** The roadmap says every change should go through GitHub PR checks and deployment is explicit, later, and smoke-gated (`docs/NEXT_LEVEL_ROADMAP.md:286`-`docs/NEXT_LEVEL_ROADMAP.md:293`). This design PR stops at the PR.

## 2. Headline Survey Findings

1. **NL-11 is correctly framed as productization, not feature discovery.** The roadmap says VH Health beats local products on clinical depth/offline/AI freshness, but loses to incumbents on references, ecosystems, proof at scale, and enterprise shell (`docs/NEXT_LEVEL_ROADMAP.md:42`-`docs/NEXT_LEVEL_ROADMAP.md:46`). The wedge is explicit: nobody in the price class has this clinical core, but nobody buys a core without the shell (`docs/NEXT_LEVEL_ROADMAP.md:48`-`docs/NEXT_LEVEL_ROADMAP.md:49`).
2. **The highest-sales-value gap is the legacy-HIS migration toolkit.** The roadmap names legacy-HIS data migration as the single biggest sales blocker (`docs/NEXT_LEVEL_ROADMAP.md:86`) and specifies CSV/HL7 importers, patient/encounter/billing openers, validation reports, and rehearsal mode (`docs/NEXT_LEVEL_ROADMAP.md:224`-`docs/NEXT_LEVEL_ROADMAP.md:227`).
3. **Substrates exist, but they are not product surfaces yet.** There are `api_clients` and `api_keys` models with tenant, scopes, IP allowlists, status, and rate-limit profile (`apps/backend/prisma/schema.prisma:702`-`apps/backend/prisma/schema.prisma:724`, `apps/backend/prisma/schema.prisma:728`-`apps/backend/prisma/schema.prisma:749`), plus service rules that return plaintext keys exactly once and never bypass JWT/RBAC (`apps/backend/src/services/auth/apiClientService.js:2`-`apps/backend/src/services/auth/apiClientService.js:15`). There is no buyer-facing developer portal, app directory, or public onboarding journey.
4. **FHIR writes are no longer wholly new, but public SMART/FHIR productization is still open.** FHIR routes already enforce write roles (`apps/backend/src/routes/fhir/fhirRoutes.js:177`) and include write handlers for Condition, Observation, and AllergyIntolerance (`apps/backend/src/routes/fhir/fhirRoutes.js:1022`, `apps/backend/src/routes/fhir/fhirRoutes.js:1071`, `apps/backend/src/routes/fhir/fhirRoutes.js:1127`). However, the current FHIR mount is restricted to clinical staff roles (`apps/backend/src/app.js:806`-`apps/backend/src/app.js:823`), and the route comments state that a pure SMART token cannot currently reach end to end without a mount-level SMART path (`apps/backend/src/routes/fhir/fhirRoutes.js:255`). NL-11 should therefore frame the delta as public SMART endpoint exposure, registration policy, broadened write coverage, and conformance hardening, not "first FHIR write."
5. **The HL7 base is useful, but it is not a Mirth-class interface engine.** The backend already has an HTTP HL7 bridge (`apps/backend/src/routes/hl7/hl7Routes.js:2`) with HMAC tenant resolution (`apps/backend/src/routes/hl7/hl7Routes.js:47`-`apps/backend/src/routes/hl7/hl7Routes.js:56`), ADT/ORM/ORU handling (`apps/backend/src/routes/hl7/hl7Routes.js:175`-`apps/backend/src/routes/hl7/hl7Routes.js:333`), outbound feed routes (`apps/backend/src/app.js:937`-`apps/backend/src/app.js:938`), parser/generator helpers (`apps/backend/src/services/hl7/hl7Parser.js:57`-`apps/backend/src/services/hl7/hl7Parser.js:178`), and per-tenant interop secrets (`apps/backend/src/migrations/338_tenant_interop_secrets.sql:3`-`apps/backend/src/migrations/338_tenant_interop_secrets.sql:17`). It lacks generic channel configuration, transform DSL, connector workers, mapping/replay UI, and migration rehearsal semantics.
6. **The design system is visibly split across clients.** Patient re-exports the core theme (`apps/patient/lib/core/theme/theme_colors.dart:1`), the core Flutter theme only lets tenant primary color influence the seed while legacy accents remain brand constants (`packages/vhhealth_core/lib/theme/app_theme.dart:11`-`packages/vhhealth_core/lib/theme/app_theme.dart:17`), staff has its own compile-time brand colors (`apps/staff/lib/core/theme/app_theme.dart:27`-`apps/staff/lib/core/theme/app_theme.dart:34`), and admin has separate CSS tokens plus a runtime tenant branding context (`apps/admin/src/app/globals.css:84`-`apps/admin/src/app/globals.css:116`, `apps/admin/src/contexts/TenantContext.tsx:1`-`apps/admin/src/contexts/TenantContext.tsx:39`).
7. **Demo and training assets exist as fragments, not as a productized adoption system.** The scripts index describes operator/state-changing seed scripts, dry-run rules, and local/test guards (`docs/SCRIPTS_INDEX.md:3`-`docs/SCRIPTS_INDEX.md:17`, `docs/SCRIPTS_INDEX.md:37`-`docs/SCRIPTS_INDEX.md:49`, `docs/SCRIPTS_INDEX.md:54`). NABH compliance still calls out missing staff confidentiality training records (`docs/compliance/B7.2-NABH.md:203`), matching the roadmap's missing manuals, training mode, in-app tours, and admin LMS (`docs/NEXT_LEVEL_ROADMAP.md:87`).

## 3. Per-Workstream Survey

### 3.1 Shared Design System and Component Parity

**Exists.** The shared Dart package has tenant build constants for slug, id, base URL, and primary color (`packages/vhhealth_core/lib/config/tenant_config.dart:3`-`packages/vhhealth_core/lib/config/tenant_config.dart:30`). Patient re-exports core theme colors (`apps/patient/lib/core/theme/theme_colors.dart:1`). Admin has a CSS token layer and can apply `--tenant-primary` from tenant branding (`apps/admin/src/app/globals.css:84`-`apps/admin/src/app/globals.css:116`, `apps/admin/src/contexts/TenantContext.tsx:27`-`apps/admin/src/contexts/TenantContext.tsx:39`).

**Gaps.** There is no single source of truth for tokens across Flutter and Next.js. Core Flutter still has brand constants mixed into text fields, borders, and accents even when the seed color is tenant-driven (`packages/vhhealth_core/lib/theme/app_theme.dart:131`-`packages/vhhealth_core/lib/theme/app_theme.dart:185`). Staff owns a separate token vocabulary and seeds from `primaryBlue`, not the tenant seam (`apps/staff/lib/core/theme/app_theme.dart:190`-`apps/staff/lib/core/theme/app_theme.dart:195`). Admin has runtime branding, but CSS defaults are still VH teal and not generated from a shared token contract.

**Scope sketch.** Create a design-token contract before component rewrites: semantic color roles, spacing, radii, typography, elevation, icon sizing, status colors, density, and motion. Generate or manually map the same contract to admin CSS variables, core Flutter `ThemeExtension`s, and staff theme adapters. Add a parity checklist for high-traffic components: navigation shell, forms, tables/lists, clinical status chips, alerts, empty states, auth surfaces, and printable clinical/admin documents.

**Migrations.** None required for P1. Later runtime token storage can reuse tenant `settings.branding` if owner chooses full runtime branding.

**Tests.** Admin unit tests around tenant CSS variables, Storybook or screenshot fixtures if available, Flutter analyze plus golden/component snapshots for patient/staff token parity, and accessibility assertions on contrast and focus.

### 3.2 White-Label Theming

**Exists.** Flutter builds can be stamped with `VH_TENANT_SLUG`, `VH_TENANT_ID`, and `VH_TENANT_PRIMARY` (`packages/vhhealth_core/lib/config/tenant_config.dart:3`-`packages/vhhealth_core/lib/config/tenant_config.dart:30`). Admin dashboard chrome already reads tenant branding name and logo from tenant context with default fallback (`apps/admin/src/app/(with-auth)/dashboard/layout.tsx:81`-`apps/admin/src/app/(with-auth)/dashboard/layout.tsx:85`). Backend tenant context intentionally returns only public branding and identity, not PHI or secrets (`apps/backend/src/routes/admin/tenantContextRoutes.js:4`-`apps/backend/src/routes/admin/tenantContextRoutes.js:10`, `apps/backend/src/routes/admin/tenantContextRoutes.js:34`-`apps/backend/src/routes/admin/tenantContextRoutes.js:40`).

**Gaps.** Mobile is mostly compile-time branded, admin is runtime branded, and staff is not yet tenant branded. There is no declared brand-kit depth: app name, app icon, splash screen, legal footer, email/SMS sender, support email, help center copy, reports/PDF letterhead, login domain, and store listing assets are not all covered.

**Scope sketch.** P1 should define a brand-kit schema, validation rules, asset constraints, fallback policy, and build/runtime split. P2 applies it to admin chrome, generated documents, outbound communications, and Flutter app stamping. P3 hardens multi-tenant hosted domains and app-store/customer-specific build operations.

**Migrations.** Prefer no new table in the first implementation if `tenants.settings.branding` remains enough. Add a dedicated `tenant_brand_assets` table only when versioned assets, approvals, or audit history become necessary.

**Tests.** Tenant-context API tests, CSS variable tests, Flutter stamped-build smoke, asset validation tests, and screenshots across default tenant plus one branded tenant.

### 3.3 License and Entitlement Packaging

**Exists.** The clinical-AI substrate already has a global module catalog and per-tenant module switches (`apps/backend/prisma/schema.prisma:2730`-`apps/backend/prisma/schema.prisma:2746`, `apps/backend/prisma/schema.prisma:3745`-`apps/backend/prisma/schema.prisma:3763`). The roadmap calls out per-tenant module flags as existing substrate while license/entitlement enforcement is missing (`docs/NEXT_LEVEL_ROADMAP.md:89`). There are also feature-settings patterns elsewhere, such as composition-search settings, terminology settings, and content-studio settings, that can be mirrored for tenant-scoped enablement (`apps/backend/src/migrations/351_composition_search_settings.sql:4`-`apps/backend/src/migrations/351_composition_search_settings.sql:25`, `apps/backend/src/migrations/370_tenant_terminology_settings.sql:11`-`apps/backend/src/migrations/370_tenant_terminology_settings.sql:35`, `apps/backend/src/migrations/382_content_studio_settings.sql:10`-`apps/backend/src/migrations/382_content_studio_settings.sql:23`).

**Gaps.** Module flags are technical controls, not SKUs. There is no commercial package catalog, package-to-feature mapping, route/nav enforcement contract, audit trail for entitlement decisions, grace/expiry behavior, metering, or operational playbook for support/sales.

**Scope sketch.** Introduce product packages as a layer above module flags: package catalog, feature keys, route/nav checks, API checks, mobile capability manifest, admin entitlement board, audit records, expiry/grace rules, and a migration path that maps current clinical-AI module settings into package-visible capabilities without breaking existing tenants.

**Migrations.** Likely `product_packages`, `product_package_features`, `tenant_entitlements`, and `entitlement_audit_events`. Keep clinical-AI `clinical_ai_tenant_modules` as the module-runtime control, not the commercial source of truth.

**Tests.** Tenant-isolation tests, route-deny tests, nav-hide tests, mobile capability-manifest tests, package downgrade tests, and "must not block emergency care" tests for clinical workflows where entitlement enforcement must be informational or admin-only.

### 3.4 Legacy-HIS Migration Toolkit

**Exists.** There are pieces to reuse: HL7 ADT/ORM/ORU receive/generate paths (`apps/backend/src/routes/hl7/hl7Routes.js:122`-`apps/backend/src/routes/hl7/hl7Routes.js:176`, `apps/backend/src/routes/hl7/hl7Routes.js:225`-`apps/backend/src/routes/hl7/hl7Routes.js:333`, `apps/backend/src/routes/hl7/hl7Routes.js:349`-`apps/backend/src/routes/hl7/hl7Routes.js:436`), patient identifiers (`apps/backend/src/routes/admin/patientIdentifierRoutes.js:4`-`apps/backend/src/routes/admin/patientIdentifierRoutes.js:11`), dedupe/merge workflow routes (`apps/backend/src/routes/admin/patientMergeRoutes.js:2`-`apps/backend/src/routes/admin/patientMergeRoutes.js:17`), user bulk import (`apps/backend/src/routes/user/userRoutes.js:24`), and opening-balance cutover script precedent (`docs/SCRIPTS_INDEX.md:13`).

**Gaps.** There is no productized migration workspace: no import job model, source-file storage contract, mapping profiles, rehearsal mode, validation report, duplicate/merge review queue tied to import batches, patient/encounter/billing opener UX, rollback/commit semantics, or buyer-facing confidence report. The roadmap explicitly wants CSV/HL7 importers, patient/encounter/billing openers, validation reports, and rehearsal mode (`docs/NEXT_LEVEL_ROADMAP.md:224`-`docs/NEXT_LEVEL_ROADMAP.md:227`).

**Scope sketch.** Make this the value spine. P1 builds a CSV-first rehearsal workspace: upload, profile, map, validate, preview, dedupe, and produce an executive validation report without writing authoritative clinical rows. P2 commits patient demographics, identifiers, encounters/admissions, and opening AR balances with idempotency keys. P3 adds HL7 ADT import batches and field-mapping profiles. P4 adds billing detail and document references after samples exist.

**Migrations.** Likely `migration_import_jobs`, `migration_source_files`, `migration_mapping_profiles`, `migration_import_records`, `migration_validation_findings`, `migration_commit_batches`, and batch links to patient identifiers/merge decisions. Billing opener work may add ledger/import-source columns instead of a new ledger table.

**Tests.** CSV fixture tests, HL7 fixture tests, dry-run/no-write tests, idempotent replay tests, tenant-isolation tests, patient-merge conflict tests, opening-balance totals tests, PHI redaction in reports/logs, and rehearsal-to-commit invariants.

### 3.5 Demo-Tenant Generator

**Exists.** Tenant onboarding is idempotent and supports dry-run (`docs/SCRIPTS_INDEX.md:11`). Seed scripts cover local staff accounts, sprint fixtures, departments/doctors, current beds, comprehensive local data, and clinical-AI preflight reviewers (`docs/SCRIPTS_INDEX.md:41`-`docs/SCRIPTS_INDEX.md:49`). The local hands-on hospital fixture creates realistic notes, vitals, discharge, and tagged data (`scripts/seed-local-hands-on-hospital-data.mjs:2`-`scripts/seed-local-hands-on-hospital-data.mjs:39`, `scripts/seed-local-hands-on-hospital-data.mjs:986`-`scripts/seed-local-hands-on-hospital-data.mjs:1048`).

**Gaps.** The roadmap says seed scripts exist but are not productized (`docs/NEXT_LEVEL_ROADMAP.md:150`). Current scripts are operator/test tools guarded against non-local misuse, not a deterministic "make me a demo hospital" product surface with scenario packs, run ledger, buyer personas, reset/rebuild safety, and sales-story coverage.

**Scope sketch.** Build a scenario-pack orchestrator: hospital profile, departments, staff personas, patients, encounters, lab/radiology/billing/insurance/OT/maternity/ED paths, optional AI review queues, tours that point at the generated cases, and a human-readable demo ledger. Keep the default pack synthetic-only and non-PHI.

**Migrations.** None for a CLI-only P1 if the run ledger is artifact-only. Add `demo_tenant_runs` and `demo_tenant_scenario_items` if admin UI/reset history is in scope.

**Tests.** Local-only guard tests, deterministic seed replay tests, smoke login for generated users, cross-client journey smoke, teardown/reset tests, and no-real-PHI content checks.

### 3.6 User Manuals, In-App Tours, and LMS

**Exists.** The repository has operator docs and compliance evidence docs. Admin also has clinical-AI training/synthetic panels as domain-specific teaching aids (`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/SyntheticCaseGeneratorPanel.tsx:154`, `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/TrainingSimulationCoachPanel.tsx:159`).

**Gaps.** Roadmap states end-user manuals, training mode, in-app tours, and admin LMS are missing (`docs/NEXT_LEVEL_ROADMAP.md:87`). NABH compliance specifically says staff confidentiality training records are not captured in the platform and are required before assessment (`docs/compliance/B7.2-NABH.md:203`, `docs/compliance/B7.2-NABH.md:220`).

**Scope sketch.** P1 should be a lightweight adoption system: role-based manuals, help-center taxonomy, tour registry, tour completion events, and a training evidence ledger. P2 can add quiz/attestation, assignment rules, export packets for compliance, and LMS integration hooks. Keep "training mode" separate from synthetic demo data until the owner chooses whether training should use demo tenants, mocked tenants, or production tenant sandbox mode.

**Migrations.** Likely `learning_modules`, `learning_assignments`, `learning_completions`, `tour_definitions`, and `tour_events` if built internally. If buying LMS, VH only needs integration mapping and training evidence ledger.

**Tests.** Role visibility, completion write, evidence export, tour resume/skip, no-PHI training content, accessibility, and mobile/offline behavior if tours touch Flutter.

### 3.7 Developer Portal, API Clients, Public SMART, and FHIR Writes

**Exists.** API clients and keys have models, service logic, and admin routes (`apps/backend/prisma/schema.prisma:702`-`apps/backend/prisma/schema.prisma:749`, `apps/backend/src/services/auth/apiClientService.js:114`-`apps/backend/src/services/auth/apiClientService.js:254`, `apps/backend/src/routes/admin/mfaApiClientsRoutes.js:132`-`apps/backend/src/routes/admin/mfaApiClientsRoutes.js:198`, `apps/backend/src/routes/admin/index.js:148`). SMART has an app registry, authorization-code grant with PKCE, tokens, refresh rotation, scope parsing, token verification, and token revocation (`apps/backend/src/services/smartFhir/smartOAuthService.js:5`-`apps/backend/src/services/smartFhir/smartOAuthService.js:23`, `apps/backend/src/services/smartFhir/smartOAuthService.js:48`-`apps/backend/src/services/smartFhir/smartOAuthService.js:68`, `apps/backend/src/services/smartFhir/smartOAuthService.js:187`-`apps/backend/src/services/smartFhir/smartOAuthService.js:245`, `apps/backend/src/services/smartFhir/smartOAuthService.js:542`-`apps/backend/src/services/smartFhir/smartOAuthService.js:600`). FHIR conformance has a reusable CI job with strict golden validation (`.github/workflows/_reusable-backend-fhir.yml:16`-`.github/workflows/_reusable-backend-fhir.yml:20`, `.github/workflows/_reusable-backend-fhir.yml:80`-`.github/workflows/_reusable-backend-fhir.yml:98`).

**Gaps.** Admin API-client routes are not a developer portal. Public SMART endpoints are documented as separate from admin helpers (`apps/backend/src/routes/admin/smartFhirRoutes.js:5`-`apps/backend/src/routes/admin/smartFhirRoutes.js:6`), while the current FHIR mount blocks pure SMART use end to end (`apps/backend/src/routes/fhir/fhirRoutes.js:255`). There is no registration policy, sandbox app approval, partner docs, sample apps, SDK/key lifecycle guide, per-scope explainers, app directory, or public discovery page.

**Scope sketch.** P1 productizes `api_clients`: admin/developer UI, key lifecycle, scope dictionary, OpenAPI download, examples, audit, and sandbox credentials. P2 exposes SMART discovery and OAuth endpoints publicly with exact redirect URI validation and tenant policy. P3 expands FHIR write coverage and conformance fixtures resource by resource.

**Migrations.** `api_clients` and SMART tables already exist. Likely add `developer_portal_apps`, `developer_portal_audit_events`, or metadata columns only if the existing models cannot hold approval state and docs-facing profile fields. Public SMART endpoint work may need no schema change.

**Tests.** API-key one-time plaintext tests, key revoke/rotation tests, IP/scope enforcement, SMART authorize/token/refresh/revoke tests, FHIR read/write scope tests, patient-context confinement, conformance golden bundles, OpenAPI generation, and public endpoint abuse/rate-limit tests.

### 3.8 HL7 Interface Engine

**Exists.** HL7 receive/generate and outbound feeds exist as concrete integration endpoints (`apps/backend/src/routes/hl7/hl7Routes.js:122`-`apps/backend/src/routes/hl7/hl7Routes.js:176`, `apps/backend/src/routes/hl7/hl7Routes.js:349`-`apps/backend/src/routes/hl7/hl7Routes.js:436`, `apps/backend/src/app.js:937`-`apps/backend/src/app.js:938`). The parser handles pipe-delimited HL7v2 messages and ACK generation (`apps/backend/src/services/hl7/hl7Parser.js:57`-`apps/backend/src/services/hl7/hl7Parser.js:178`). Per-tenant interop secrets give a secure tenant binding pattern (`apps/backend/src/migrations/338_tenant_interop_secrets.sql:3`-`apps/backend/src/migrations/338_tenant_interop_secrets.sql:17`).

**Gaps.** No TCP/MLLP listener exists anywhere today (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:33`). There is no engine data model, connector worker, channel editor, mapping language, transform sandbox, message store, replay/reprocess workflow, external-system registry, or operator dashboard. NL-7 left the subsume-vs-peer decision to NL-11 (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:58`).

**Scope sketch.** Add a mini-design gate before build. The engine should be a peer to NL-7 in v1: it handles system feeds and migration importers; NL-7 remains the dedicated device path. Both call backend HTTP surfaces. The gate must decide channel schema, connector types, message store, transform DSL/sandbox, replay semantics, PHI logging, delivery retry rules, deployment topology, and whether any MLLP listener can be safely operated on hospital networks.

**Migrations.** After mini-design: `interop_systems`, `interop_channels`, `interop_channel_versions`, `interop_messages`, `interop_message_attempts`, `interop_transform_tests`, and `interop_replay_batches`.

**Tests.** Parser fixtures, channel validation, transform tests, replay idempotency, per-tenant secret enforcement, retry/backoff, dead-letter handling, PHI-safe logs, and end-to-end ADT/ORM/ORU against rehearsal import jobs.

## 4. Cross-Cutting Defects Found During Survey

- **Roadmap wording is stale around FHIR writes.** The roadmap inherited item says FHIR R4 writes are absorbed into NL-11 (`docs/NEXT_LEVEL_ROADMAP.md:62`), but limited staff-gated FHIR writes are already present (`apps/backend/src/routes/fhir/fhirRoutes.js:1022`, `apps/backend/src/routes/fhir/fhirRoutes.js:1071`, `apps/backend/src/routes/fhir/fhirRoutes.js:1127`). Implementation tasks should target public SMART-scoped writes and broader resource coverage.
- **API-client product language is hidden under MFA-era plumbing.** API-client routes live in `mfaApiClientsRoutes.js` and are mounted at both `/mfa` and `/api-clients` (`apps/backend/src/routes/admin/mfaApiClientsRoutes.js:2`-`apps/backend/src/routes/admin/mfaApiClientsRoutes.js:4`, `apps/backend/src/routes/admin/index.js:148`). NL-11 should make the portal vocabulary explicit so partner integration is not presented as an MFA subfeature.
- **Design-token ownership is split.** Core/patient, staff, and admin each have separate brand/token mechanisms. Productization needs one declared source of truth before polishing individual screens.
- **Seed safety and demo productization are different jobs.** Existing seed scripts are guarded operator tools, and the scripts index correctly says to avoid production seed runs unless the script and change plan explicitly allow it (`docs/SCRIPTS_INDEX.md:54`). NL-11 must not simply expose seed scripts through admin.
- **Interface-engine scope can accidentally swallow NL-7.** NL-7 documented two future options: engine subsumes the gateway's MLLP listener, or gateway remains the device path and engine handles system feeds (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:58`). For v1, choose peer systems to avoid coupling bedside devices to legacy-HIS migration work.

## 5. Recommended Slice Order

Sizing: **S** means docs/schema-light/UI-light, **M** means one product surface plus backend enforcement, and **L** means multi-surface or integration-heavy work that needs dedicated staging data and implementation gates.

| # | Slice | Size | Sales value | Substrate readiness | Scope | Gate / tests |
|---|---|---:|---|---|---|---|
| 1 | **Migration Toolkit P1 - CSV rehearsal workspace** | L | Highest | Medium | Import jobs, source-file contract, CSV profiling, mapping, validation findings, rehearsal report, no-write preview for patient/encounter/opening AR files. | Dry-run no-write tests, CSV fixtures, tenant isolation, PHI-redacted reports, duplicate detection smoke. |
| 2 | **Developer Portal P1 - activate `api_clients` as product** | M | High | High | Admin/developer portal page, API-client/key lifecycle, scope dictionary, OpenAPI download, integration guide, audit trail, sandbox keys. | API-key issue/revoke/one-time plaintext tests, scope/IP tests, OpenAPI generation, docs link checks. |
| 3 | **Entitlement Packaging P1 - package catalog and enforcement contract** | M | High | Medium | SKU/package catalog, feature keys, tenant entitlements, route/nav/mobile capability checks, audit events, grace/expiry policy. | Route deny/allow tests, nav visibility, tenant isolation, emergency-care non-blocking assertions. |
| 4 | **Design Tokens P1 - shared token contract and parity harness** | M | Medium-high | Medium | Token inventory, semantic token source, admin CSS mapping, Flutter core/staff adapters, component parity checklist. | Admin CSS-variable tests, Flutter analyze/goldens, contrast/focus checks. |
| 5 | **White-Label P1 - brand-kit schema and admin/runtime surfaces** | M | High | Medium | Brand-kit depth, asset validation, admin chrome/docs/email branding, mobile stamping contract, default fallback policy. | Tenant-context tests, asset validation, default/branded screenshots, stamped-build smoke. |
| 6 | **Demo-Tenant Generator P1 - deterministic sales scenario pack** | M | High | High but fragmented | Scenario pack orchestrator, demo ledger, staff/persona/patient journeys, safe reset, generated-tour anchors. | Local-only guard, replay determinism, generated-login smoke, no-PHI content scan. |
| 7 | **Manuals/Tours/LMS P1 - adoption and evidence ledger** | M | Medium-high | Low-medium | Role manuals, help-center taxonomy, tour registry, completion events, minimal training evidence ledger for NABH. | Role visibility, completion write/export, tour resume/skip, accessibility, no-PHI training fixtures. |
| 8 | **Public SMART + FHIR Writes P1** | M-L | High | Medium-high | Public SMART discovery/authorize/token/revoke, registration policy, SMART-only FHIR mount, write-scope tests, resource-by-resource write plan. | SMART OAuth tests, patient-context confinement, FHIR golden fixtures, rate-limit/abuse tests. |
| 9 | **Migration Toolkit P2 - commit path and HL7 ADT importer** | L | Highest | Medium | Commit batch, idempotent patient/identifier/encounter writes, ADT batch importer, merge queue integration, acceptance report. | Commit idempotency, HL7 fixtures, merge conflicts, rollback/replay, opening balance totals. |
| 10 | **Interface Engine Mini-Design Gate** | S | High | Medium | Decide peer-vs-subsumed architecture, channel schema, connector worker, transform DSL/sandbox, message store, replay and deployment topology. | Design sign-off only; no implementation until owner accepts. |
| 11 | **Interface Engine P1 - channel runtime and monitoring** | L | High | Medium-low | Channel CRUD, message store, HTTP/MLLP/file connector subset, transform test harness, replay/dead-letter UI, outbound delivery worker. | E2E channel tests, retry/dead-letter, transform sandbox, PHI-safe logs, tenant-secret enforcement. |

Rationale:

- Start with migration toolkit because it is the named single biggest sales blocker and produces the strongest buyer-facing artifact: a rehearsal report that shows "your old data can safely enter VH Health."
- Developer portal comes second because `api_clients` and key mechanics already exist; a thin product layer unlocks partner/integration demos quickly.
- Entitlements should precede broad white-label/demo/manual work so navigation, docs, and generated tenants can tell the truth about what a tenant bought.
- Design tokens and white-label should land before tours/manuals, otherwise training screenshots and brand assets will churn.
- Public SMART/FHIR should follow the API-client portal and registration-policy decisions; it has meaningful security blast radius and should not be bundled with basic developer docs.
- The interface engine is intentionally later and behind its own mini-design gate. It is deep runtime infrastructure, and migration-toolkit P1/P2 will teach which mappings and reports matter before building a general channel engine.

## 6. Owner Decisions

1. **White-label depth.** Recommendation: choose a phased hybrid. Use runtime branding for admin, documents, support email, legal/footer, and help surfaces. Keep mobile app identity, icon, splash, tenant slug, and base URL as stamped builds for now, while token color stays `VH_TENANT_PRIMARY`. Revisit full runtime mobile branding only after token parity lands.
2. **LMS make-vs-buy.** Recommendation: buy or integrate with a hospital LMS for rich learning management if a customer already has one; build only the VH evidence ledger, tour completion, role manuals, and compliance export. If no LMS exists for target pilots, build a minimal internal LMS P1 and keep advanced course authoring out of NL-11.
3. **SMART app registration policy.** Recommendation: sandbox app registration can be tenant-admin initiated; production apps require platform-super-admin approval. Default-deny scopes, exact redirect URI matching, explicit public/confidential/service-app kinds, tenant-bound app IDs, audited production promotion, and no broad `system/*.write` without a signed integration contract.
4. **Interface engine subsume-vs-peer.** Recommendation: peer in v1. NL-7 stays the device transport path; NL-11 handles legacy HIS/LIS/PACS and migration feeds. Both call backend HTTP APIs and may share parser/security patterns. Revisit subsuming MLLP only after both device gateway and system-feed engine are stable in pilots.
5. **Migration source-format priorities.** Recommendation: prioritize CSV patient demographics, identifiers, encounters/admissions, and opening AR/billing balances first; HL7 ADT next; then billing charges/payments, ORM/ORU, documents, and vendor-specific exports after real sample files are obtained.
6. **Entitlement enforcement mode.** Recommendation: hard-block admin/developer/commercial features, but avoid hard-blocking urgent clinical care. For care-delivery routes, prefer visible package status, admin remediation, and audit unless the feature is purely optional/non-clinical.

## 7. Risks

- **Import blast radius.** Bad migration data can pollute the clinical record. Rehearsal mode, idempotency, validation reports, and explicit commit batches are mandatory.
- **PHI leakage in reports and demos.** Migration validation reports, demo tenants, and training content must treat PHI redaction as a first-class test surface.
- **Public SMART expands the attack surface.** Discovery, OAuth, token refresh, scope checks, app registration, rate limits, and patient-context confinement need security review before exposure.
- **Entitlement bugs can hurt care.** Product packages must distinguish commercial feature access from care-critical emergency flows.
- **Branding scope can sprawl.** White-label needs an explicit brand-kit matrix or every outbound artifact becomes a one-off.
- **Interface engine complexity can overtake productization.** Mirth-class engines are runtime platforms. The mini-design gate should be allowed to say "not yet" for MLLP, file/SFTP, or transform DSL features that are not needed for the first migration pilots.
- **Training content goes stale.** Manuals, tours, and LMS evidence need ownership, release cadence, and a way to flag stale screenshots/process steps.

## 8. Build Ledger for This PR

- Added this single docs-only NL-11 survey and slice plan.
- No code, generated files, database migrations, app assets, or deployment config were changed.
- No migration numbers are reserved by this PR.
- Expected validation: `git diff --check` only, because the change is a Markdown planning document.
