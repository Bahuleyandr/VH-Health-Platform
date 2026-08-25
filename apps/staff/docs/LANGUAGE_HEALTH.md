# Staff App - Language Health Report

_Last verified: 2026-08-25 (re-audit J, translation-gap pass)._

## How to reproduce every number below

```bash
# The full informational report (this document's tables come from it)
node apps/staff/scripts/i18n-verify.mjs        # or: melos run i18n-health-staff

# The blocking half: structural key parity only, exits 1 on a gap
node apps/staff/scripts/i18n-verify.mjs --check  # or: melos run i18n-parity-check
```

Both read `apps/staff/lib/l10n/app_strings.dart` directly — there is no
generated artefact and no cached count. "Keys present" is the size of each
locale's map in `_byLang`; every other row is a section of the report, in
the order the script prints them. If a number here disagrees with the
script, the script is right and this document is stale.

This report is the structural verification of the staff app i18n setup.
It answers "does every key resolve?" — **not** "is every translation
clinically approved?" Hindi, Tamil, and Telugu are structurally complete,
but a large part of each map is an AI first pass; **Malayalam is a
declared-partial nurse-facing first pass (2026-06-10)**. Nothing in any
non-English locale has had a fluent clinical review, and all of it still
requires one before production rollout.

## Headline numbers (measured 2026-08-25)

| | en | hi | ta | te | ml |
|---|---:|---:|---:|---:|---:|
| Keys present | 5,660 | 5,657 | 5,657 | 5,657 | 1,556 |
| Coverage vs en | 100% | 100% | 100% | 100% | 27.5% (partial by design) |
| `// REVIEW:` flags | - | 495 | 948 | 949 | 1 (map-level banner) |
| Length outliers | - | 0 | 7 | 1 | 1 |
| Copy-pasted English | - | 125 | 135 | 134 | 61 |

`en` declares 5,660 keys. Three of them are deliberately left to the
English fallback in hi/ta/te (see "Declared English fallback" below), so
the translatable set is 5,657 and hi/ta/te are at 100% of it.

| | |
|---|---:|
| Getters declared on `AppStrings` | 2,533 |
| Getters called from `lib/` | 2,045 |
| Declared but never called | 488 |
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

Three keys are deliberately **not** translated. Each is a declaration a
person signs, where the wording is the legal content of the signature and
must be the deploying hospital's approved text rather than a machine first
pass. They fall through to English at runtime, and the parity gate skips
exactly these three and prints them on every run:

| Key | Why |
|---|---|
| `clinical_inbox.action.attestation` | First-person attestation the clinician signs against a diagnostic result. |
| `ed_trauma.continuity.external_attestation` | States what an inter-facility handoff record asserts was confirmed. |
| `s4.lib.referrals.continue_ownership` | First-person declaration of continuing clinical ownership of a patient. |

The list lives in `DELIBERATE_ENGLISH_FALLBACK` in
`apps/staff/scripts/i18n-verify.mjs`, with the reason next to each key. A key
listed there that no longer exists in `en` fails the gate, so the list cannot
outlive the strings it excuses. The bar for adding one is high: important-but-
descriptive clinical copy gets translated and marked `// REVIEW:` instead.

---

## The parity gate (blocking since 2026-08-25)

Structural key parity is now a **CI failure**, not a report line:

- `node apps/staff/scripts/i18n-verify.mjs --check` exits 1 when hi, ta, or
  te is missing a key that `en` declares.
- Wired into **both** halves of the Flutter tier, alongside the vital-bounds
  and staff-role contract drift checks — pure Node, before the SDK install,
  so it fails in seconds:
  - `.github/workflows/_reusable-flutter-workspace.yml` → step
    "Staff i18n structural parity (hi/ta/te vs en)"
  - `scripts/ci/flutter.mjs` → the Forgejo/local canonical half
- Any change under `apps/staff/` selects the Flutter stage, so touching
  `app_strings.dart` always runs it.

It is deliberately narrow. It compares key **sets** and nothing else: it has
no opinion about translation quality, register, or length, and it never reads
a translated value. That is why it can block without ever being a judgement
call. `ml` is exempt outright as a declared-partial locale. The check also
fails closed if it parses fewer than 1,000 `en` keys, so a future refactor of
`app_strings.dart` that breaks the scanner reports a broken scanner instead
of a cheerful zero.

The full `melos run i18n-health` report stays non-blocking on purpose — its
copy-paste, length-outlier, unused-getter, and hardcoded-English sections are
heuristics, and heuristics do not belong on a path that must not fail.

---

## What's verified

- **English, Hindi, Tamil, and Telugu are at 100% structural key parity**
  (5,657 translatable keys each). The runtime fallback remains English; the
  only keys that depend on it are the three declared above.

- **No runtime crashes from orphan calls.** Every `s.foo` /
  `AppStrings.of(context).foo` reference resolves to a declared getter.

- **No catastrophic length blow-ups from the new fill.** The outlier counts
  (ta 7, te 1, ml 1, hi 0) are unchanged by the 2026-08-25 pass; all are
  pre-existing short UI labels that should wrap, and should be watched during
  visual QA.

- **Fallback still works.** Any missing key in a non-English map falls
  through to English at runtime. Empty-string values are not supported —
  leave a key out of the map to fall through cleanly.

---

## Review queue

Tamil and Telugu were completed as an AI first pass on 2026-05-03; the
2026-08-25 parity fill is the same kind of pass for the modules that shipped
since. Hindi had a second-pass review on 2026-05-02, but the 2026-08-25
additions have not had it.

Before production rollout in Hindi/Tamil/Telugu-speaking staff populations:

1. Validate all `// REVIEW:` strings with a fluent clinician or hospital
   operations translator. Start with the 2026-08-25 block in each locale map
   — it is the newest and the least reviewed.
2. Pay special attention to medication administration and MAR hard stops,
   NEWS2 and partograph escalation wording, blood bank, radiology
   sign-off and patient release, ED closure/recovery evidence, controlled
   dispensing (Schedule H/H1/X) witness copy, consent, discharge,
   emergency/code-blue, payroll, HR, incident, and grievance copy.
3. Decide whether the three declared English-fallback strings should stay
   English or receive hospital-approved translations. If translated, remove
   them from `DELIBERATE_ENGLISH_FALLBACK`.
4. Run `melos run i18n-parity-check` after edits (it must stay green) and
   `melos run i18n-health-staff` to re-measure the tables above.

---

## Remaining non-blocking cleanup

- **488 getters declared but never called.** See the caveat below — this
  headline overstates the safe-to-delete set.
- **Hardcoded English** is down to one file (`lib/main.dart`, 2 occurrences
  in the web-activation hold copy) by the `Text('...')` + error-assignment
  heuristic. The heuristic does not see every shape of hardcoded copy, so
  treat this as a floor, not a proof.
- **Malayalam beyond the nurse-facing core** (4,104 keys fall back to
  English) — extend per screen as the pilot demands. This is deliberate and
  is not a defect; the parity gate exempts `ml`.
- **Admin portal and backend notifications** remain English-only and are
  tracked separately.

---

## Translator handoff package

For a human validation pass, provide:

1. `apps/staff/lib/l10n/app_strings.dart`
2. `apps/staff/scripts/i18n-verify.mjs`
3. This report
4. `apps/staff/docs/ACCESSIBILITY_AUDIT.md`
5. `apps/staff/docs/COLOR_CONTRAST_AUDIT.md`

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
