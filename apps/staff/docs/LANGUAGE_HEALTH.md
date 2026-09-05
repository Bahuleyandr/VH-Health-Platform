# Staff App - Language Health Report

_Last verified: 2026-09-02 (Malayalam technical-parity lane)._

## How to reproduce every number below

```bash
# The full informational report (this document's tables come from it)
node apps/staff/scripts/i18n-verify.mjs        # or: melos run i18n-health-staff

# Regenerate the exact Malayalam technical-placeholder review queue
melos run gen-staff-ml-parity

# The blocking half: structural key parity only, exits 1 on a gap
node apps/staff/scripts/i18n-verify.mjs --check  # or: melos run i18n-parity-check
```

Both read `apps/staff/lib/l10n/app_strings.dart`; Malayalam also composes the
deterministic `app_strings_ml_parity.g.dart` technical-placeholder map.
`--check` byte-compares that generated map with the English source and fails
if it is stale. If a number here disagrees with the script, the script is
right and this document is stale.

This report is the structural verification of the staff app i18n setup.
It answers "does every key resolve?" — **not** "is every translation
clinically approved?" Hindi, Tamil, and Telugu are structurally complete,
but a large part of each map is an AI first pass. Malayalam has full technical
key parity: 2,494 explicit entries plus 4,008 generated English-source
placeholders. A placeholder is not a Malayalam translation. Nothing in any
non-English locale has complete fluent clinical review, and all of it still
requires the relevant human approval before production rollout.

## Headline numbers (measured 2026-09-02)

| | en | hi | ta | te | ml |
|---|---:|---:|---:|---:|---:|
| Keys present | 6,505 | 6,502 | 6,502 | 6,502 | 6,502 |
| Coverage vs en | 100% | 100% | 100% | 100% | 100% technical parity |
| `// REVIEW:` flags | - | 501 | 954 | 955 | 18 + 4,008 generated placeholders |
| Length outliers | - | 0 | 8 | 1 | 2 |
| Identical English heuristic | - | 125 | 132 | 131 | 3,857 |

`en` declares 6,505 keys. Three signed-attestation keys are deliberately left
to the English fallback in every non-English locale (see "Declared English
fallback" below), so the translatable set is 6,502. These counts are emitted
directly by `node apps/staff/scripts/i18n-verify.mjs`; they are not a manual
estimate.

| | |
|---|---:|
| Getters declared on `AppStrings` | 2,558 |
| Getters called from `lib/` | 2,056 |
| Declared but never called | 502 |
| Orphan calls (would crash at runtime) | 0 |
| Files with hardcoded English (UI text heuristic) | 1 (`lib/main.dart`, 2 occurrences) |

---

## The 2026-08-25 parity fill

Between the 2026-06-10 verification and 2026-08-25 the locale maps drifted:
`en` grew with new modules while hi/ta/te did not, leaving **hi 461, ta 463,
te 463 keys behind**. Nothing failed, because `melos run i18n-health` was
informational only, so the gap shipped: nurses on a Tamil or Telugu device
saw part-English screens in ED trauma continuity, the clinical inbox, NEWS2
vitals banners, partograph entry, blood bank, radiology sign-off, biomedical
work orders, pharmacy counter sale, shift swaps, safety centre, and payroll
payslip passwords.

**460 keys per locale were filled on 2026-08-25** (458 for hi, which already
carried two `drug_chart.*` keys). The fill is an **AI first pass on the same
terms as the rest of these maps** — it is *not* a clinical approval and does
not change the review status of anything. It is marked in the source as a
block per locale:

```
// ── 2026-08-25 structural-parity fill (AI first pass) ────────────
```

and 196 (hi) / 198 (ta) / 198 (te) of the new entries carry
`// REVIEW: AI first-pass 2026-08-25 parity fill - confirm clinical wording
before production.` on the high-stakes ones: MAR hard stops, NEWS2 bands and
escalation guidance, WHO partograph alert/action lines, blood-bank component
and urgency, radiology classification and patient-release, ED closure /
recovery / MLC / mortuary evidence, controlled-dispensing witness copy
(Schedule H/H1/X), consent captured at the counter, session lock, sign-out
teardown failures, and payslip-password copy.

Four of the new entries are intentionally identical to English —
`vitals_chart.news2.title_prefix` ("NEWS2"), `maternity.stat.fhr` ("FHR"),
`reception_counter.tab.opd` ("OPD"), and `s4.lib.ambulance_tracking.eta`
("ETA {time}"). Only the last one is counted as a copy-paste finding by the
verifier (its `{time}` placeholder defeats the all-caps abbreviation filter);
the other three are filtered as intentionally-English.

**Not every filled key is on a live screen.** 56 of the 64
`reception_counter.*` keys are not reached from `lib/` at all — nothing calls
their getter (or, for `prior_admission_one` / `prior_admission_other`, the
`receptionCounterPriorAdmissions` helper that composes them) and nothing
looks them up. That counter surface was consolidated into the front-office
workbench; `/appointment-queue` now redirects to `/front-office`. Those keys
were already dead in `en`; translating them satisfies parity and changes
nothing a user sees. `s4.lib.shift_swap.on_call_title` is likewise
unreferenced. The other 403 keys are read by live screens.

## Declared English fallback

Five keys are deliberately **not** translated. The first three are each a
declaration a person signs, where the wording is the legal content of the
signature and must be the deploying hospital's approved text rather than a
machine first pass. They fall through to English at runtime, and the parity
gate skips exactly these five and prints them on every run:

| Key | Why |
|---|---|
| `clinical_inbox.action.attestation` | First-person attestation the clinician signs against a diagnostic result. |
| `ed_trauma.continuity.external_attestation` | States what an inter-facility handoff record asserts was confirmed. |
| `s4.lib.referrals.continue_ownership` | First-person declaration of continuing clinical ownership of a patient. |
| `continuity.unknown.allergy` | Continuity UNKNOWN marker, pinned English in all five locales by `test/i18n_guard_test.dart:37-46` so clinicians read the same marker whatever their language setting. |
| `continuity.unknown.code_status` | Same class as `continuity.unknown.allergy`, pinned by the same test. |

The last two differ in kind from the first three: they are **present** in
every locale map carrying the English text, not absent from it. Declaring
them records the decision and stops a reviewer "fixing" them; the only
visible effect on the gate is that the `[loc] N/M` line counts them out of
M while still counting them in N.

The list lives in `DELIBERATE_ENGLISH_FALLBACK` in
`apps/staff/scripts/i18n-verify.mjs`, with the reason next to each key. A key
listed there that no longer exists in `en` fails the gate, so the list cannot
outlive the strings it excuses. The bar for adding one is high: important-but-
descriptive clinical copy gets translated and marked `// REVIEW:` instead.

---

## The parity gate (blocking since 2026-08-25)

Structural key parity is now a **CI failure**, not a report line:

- `node apps/staff/scripts/i18n-verify.mjs --check` exits 1 when hi, ta, te,
  or ml is missing a key that `en` declares, or when the generated Malayalam
  placeholder map is stale.
- Wired into **both** halves of the Flutter tier, alongside the vital-bounds
  and staff-role contract drift checks — pure Node, before the SDK install,
  so it fails in seconds:
  - `.github/workflows/_reusable-flutter-workspace.yml` → step
    "Flutter i18n structural parity (hi/ta/te/ml vs en)"
  - `scripts/ci/flutter.mjs` → the Forgejo/local canonical half
- Any change under `apps/staff/` selects the Flutter stage, so touching
  `app_strings.dart` always runs it.

It is deliberately narrow. It compares key **sets** and generated bytes: it has
no opinion about translation quality, register, or length, and it never reads
a translated value. That is why it can block without ever being a judgement
call. Malayalam's generated placeholder map is gated rather than exempt. The
check also fails closed if it parses fewer than 1,000 `en` keys, so a future refactor of
`app_strings.dart` that breaks the scanner reports a broken scanner instead
of a cheerful zero.

The full `melos run i18n-health` report stays non-blocking on purpose — its
copy-paste, length-outlier, unused-getter, and hardcoded-English sections are
heuristics, and heuristics do not belong on a path that must not fail.

---

## What's verified

- **English, Hindi, Tamil, Telugu, and Malayalam are at 100% structural key
  parity** (6,502 translatable keys each). Malayalam reaches that technical
  state with 4,008 generated English-source review placeholders. The only
  implicit runtime fallbacks are the three signed attestations declared above.

- **No runtime crashes from orphan calls.** Every `s.foo` /
  `AppStrings.of(context).foo` reference resolves to a declared getter.

- **Length risks remain measurable.** The heuristic reports ta 8, te 1, ml 2,
  and hi 0 outliers; all require visual QA rather than structural judgement.

- **Fallback still works.** Any missing key in a non-English map falls
  through to English at runtime. Empty-string values are not supported —
  leave a key out of the map to fall through cleanly.

---

## Review queue

Tamil and Telugu were completed as an AI first pass on 2026-05-03; the
2026-08-25 parity fill is the same kind of pass for the modules that shipped
since. Hindi had a second-pass review on 2026-05-02, but the 2026-08-25
additions have not had it.

Before production rollout in Hindi/Tamil/Telugu/Malayalam-speaking staff
populations:

1. Validate all `// REVIEW:` strings with a fluent clinician or hospital
   operations translator. Start with the 2026-08-25 block in each locale map
   — it is the newest and the least reviewed.
2. Pay special attention to medication administration and MAR hard stops,
   NEWS2 and partograph escalation wording, blood bank, radiology
   sign-off and patient release, ED closure/recovery evidence, controlled
   dispensing (Schedule H/H1/X) witness copy, consent, discharge,
   emergency/code-blue, payroll, HR, incident, and grievance copy.
3. Replace the 4,008 entries listed in
   `app_strings_ml_parity.g.dart` with reviewed Malayalam values in the
   explicit `ml` map. Regeneration removes each replaced placeholder.
4. Decide whether the three declared English-fallback strings should stay
   English or receive hospital-approved translations. If translated, remove
   them from `DELIBERATE_ENGLISH_FALLBACK`.
5. Run `melos run i18n-parity-check` after edits (it must stay green) and
   `melos run i18n-health-staff` to re-measure the tables above.

---

## Remaining non-blocking cleanup

- **502 getters declared but never called.** See the caveat below — this
  headline overstates the safe-to-delete set.
- **Hardcoded English** is down to one file (`lib/main.dart`, 2 occurrences
  in the web-activation hold copy) by the `Text('...')` + error-assignment
  heuristic. The heuristic does not see every shape of hardcoded copy, so
  treat this as a floor, not a proof.
- **Malayalam human translation** remains open for the 4,008 generated
  English-source placeholders. This is explicit technical parity, not final
  localized copy.
- **Admin portal** has no locale-resource system. Backend five-locale
  presentation contracts are tracked separately.

---

## Translator handoff package

For a human validation pass, provide:

1. `apps/staff/lib/l10n/app_strings.dart`
2. `apps/staff/lib/l10n/app_strings_ml_parity.g.dart`
3. `apps/staff/scripts/i18n-verify.mjs`
4. This report
5. `apps/staff/docs/ACCESSIBILITY_AUDIT.md`
6. `apps/staff/docs/COLOR_CONTRAST_AUDIT.md`

Run after every translator edit:

```bash
melos run i18n-parity-check    # must stay green
melos run i18n-health-staff    # re-measure the tables above
```

## Historical notes

### 2026-06-10 (roadmap E2)

- **In-app language switcher** (Settings → Appearance → Language) backed
  by `LocaleProvider` (SharedPreferences-persisted; default = follow the
  device locale, the historical behaviour).
- **Malayalam (`ml`) added** as a declared-partial locale: a nurse-facing
  core (actions, labels, login, dashboard, settings, bed sheet, vitals +
  vitals chart, MAR scan, due meds, nursing notes, handover, code blue, CDS,
  orders/composer/order sets, drug chart, notifications, logout/splash/error).
  All other keys fall back to English by design. The verifier reports `ml`
  separately and does not treat partial coverage as a finding.
- **hi/ta/te gap-fill** of the 43 keys added en-only by later sessions, and
  **drug chart screen de-hardcoded** (`drug_chart.*` keys ×5 locales).
- The 100% coverage claimed by that session was true on that date. It stopped
  being true as later modules landed en-only — which is what the blocking gate
  above now prevents.

### 2026-08-23 (once-over train D) — new-module i18n backlog

The med_rec and transport modules shipped English-first (matching the
specialty-module idiom: AppStrings where an existing key fits, raw English
otherwise). Their strings queue for the next translator pass alongside the
specialty-module backlog. The verifier heuristic now also catches English
assigned to error/message state variables — the blind spot that hid the MAR
hard-stop message (now localized ×5 with `mar_scan.mismatch_blocked`).

### 2026-08-23 (once-over train F) — unused-getter headline overstates

The verifier's "declared but never called: N" counts GETTERS, but several
key families are consumed dynamically via `AppStrings.lookup('<key>')`
(e.g. `appt_queue.notes_optional` from three screens) or from the
front-office workbench dialogs — deleting by that list would break live
strings. A safe purge needs per-key cross-referencing of getter calls AND
dynamic lookups; deliberately deferred to the translator-review pass
rather than done mechanically.
