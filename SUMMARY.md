# Weekly Lint Sweep — 2026-05-11

**Chain step that failed:** `eslint` (first step).  
`lint:raw-params` and `secrets:scan` were **not reached** — the `&&` chain short-circuits on the eslint exit code.

**Total problems: 29 (2 errors, 27 warnings)**  
`--max-warnings=0` means every warning is also a gate failure.

---

## Errors (block merge regardless of warning count)

### `no-control-regex` — unexpected `\x00` in regex
| File | Line | Snippet |
|---|---|---|
| `apps/backend/src/services/emr/vitalsChartService.js` | 88:53 | control character `\x00` inside a regular expression literal |

**Triage note:** This regex contains a literal null-byte (`\x00`). Likely unintentional; could be a copy-paste artefact. Verify intent before removing — if the regex is meant to strip null bytes, use `\0` or a Buffer approach instead.

### `no-useless-escape` — unnecessary `\/` escape
| File | Line | Snippet |
|---|---|---|
| `apps/backend/src/utils/responseHelper.js` | 26:21 | `\/` inside a string or regex where `/` needs no escaping |

**Triage note:** Mechanical fix (drop the backslash), but touching `responseHelper.js` affects every response path — worth a human eye.

---

## Warnings (29 total; all are gate failures under `--max-warnings=0`)

### `import/no-named-as-default-member` (14 occurrences)
All in `apps/backend/src/routes/ipd/ipdSupportRoutes.js`.  
The file imports `ipdSupportService` as a default import and then accesses named-export members off it. ESLint suggests using named imports instead.

| Line | Named export accessed |
|---|---|
| 37:27 | `collectAdvanceDeposit` |
| 55:7  | `listAdmissionDeposits` |
| 56:7  | `getAdmissionDepositBalance` |
| 67:26 | `refundAdvanceDeposit` |
| 85:26 | `listAdmissionPasses` |
| 96:24 | `issueReplacementAttendantPass` |
| 114:24 | `revokeAttendantPass` |
| 129:26 | `createWardIndent` |
| 144:27 | `listWardIndents` |
| 157:26 | `getWardIndent` |
| 167:26 | `approveWardIndent` |
| 180:26 | `rejectWardIndent` |
| 194:26 | `issueWardIndent` |
| 207:26 | `receiveWardIndent` |

**Triage note:** Switching to named imports is safe and idiomatic, but touches the entire import block of a route file — human review recommended.

---

### `no-unused-vars` (13 occurrences across 8 files)

| File | Line | Symbol | Kind |
|---|---|---|---|
| `apps/backend/src/routes/ipd/ipdSupportRoutes.js` | 13:8 | `logger` | imported var, never used |
| `apps/backend/src/services/billing/billingService.js` | 25:7 | `VALID_CLAIM_STAGES` | assigned but never used |
| `apps/backend/src/services/clinical/growthPercentileService.js` | 120:23 | `metric` | function arg, never used |
| `apps/backend/src/services/emr/admissionService.js` | 15:8 | `billingService` | imported var, never used |
| `apps/backend/src/services/emr/vitalsChartService.js` | (see errors above) | — | — |
| `apps/backend/src/services/investigation/investigationService.js` | 589:16 | `e` | caught error, never used |
| `apps/backend/src/services/investigation/investigationService.js` | 640:16 | `e` | caught error, never used |
| `apps/backend/src/services/ipd/ipdSupportService.js` | 11:8 | `logger` | imported var, never used |
| `apps/backend/src/services/ipd/ipdSupportService.js` | 47:35 | `admissionId` | function arg, never used |
| `apps/backend/src/services/ipd/ipdSupportService.js` | 47:48 | `passIndex` | function arg, never used |
| `apps/backend/src/services/ipd/ipdSupportService.js` | 299:12 | `pass` | assigned but never used |
| `apps/backend/src/services/lab/labResultsService.js` | 385:44 | `tenantId` | function arg, never used |
| `apps/backend/src/services/maternity/maternityService.js` | 389:53 | `tenantId` | function arg, never used |
| `apps/backend/src/services/portal/patientPortalService.js` | 124:46 | `tenantId` | function arg, never used |

**Triage note:** Prefix unused identifiers with `_` (e.g. `_logger`, `_tenantId`) to silence the rule without deleting potentially-needed scaffolding, or remove them if confirmed dead code.

---

## Status of remaining chain steps

| Step | Status |
|---|---|
| `eslint --max-warnings=0` | **FAILED** (29 problems) |
| `lint:raw-params` | **NOT RUN** |
| `secrets:scan` | **NOT RUN** |

`lint:raw-params` and `secrets:scan` must be run and pass before this branch can be considered clean.
