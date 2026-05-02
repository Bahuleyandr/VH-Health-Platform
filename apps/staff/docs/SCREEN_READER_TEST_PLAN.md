# Staff App — Screen Reader Test Plan

A scripted manual test plan for verifying the 10 a11y fixes that
shipped on 2026-05-02. Designed to be runnable in a single 60-90
minute session by one tester per platform.

This is the **verification step** for the gaps documented in
`ACCESSIBILITY_AUDIT.md` — you should be able to walk through the 12
scenarios below and confirm each one announces the intended label
and reacts to the intended gesture.

---

## Setup

### Windows (NVDA)

1. Install NVDA (free): https://www.nvaccess.org/download/
2. Launch NVDA before opening the staff app.
3. Common keystrokes:
   - `Insert + ↓` (or `CapsLock + ↓` on laptop layout) — read all
   - `Tab` / `Shift+Tab` — move focus
   - `Insert + Space` — toggle browse / focus mode (n/a for Flutter)
   - `Insert + S` — silence speech for 5 seconds (toggle)
4. Run the staff app: relaunch
   `apps/staff/build/windows/x64/runner/Release/vhhealth_staff.exe`.

### Android (TalkBack)

1. Settings → Accessibility → TalkBack → On.
2. Common gestures:
   - Single tap — focus (announce only).
   - Double tap — activate the focused element.
   - Swipe right / left — move focus to next / previous.
   - Two-finger swipe up / down — scroll.
3. Install the staff Android build (when one exists; today the focus
   is the Windows .exe).

### iOS (VoiceOver) / macOS (VoiceOver)

Same gestures as TalkBack on iOS; on macOS, `Cmd+F5` toggles VO,
`VO+→` next, `VO+Space` activate. iOS / macOS staff builds aren't
the priority target so this is optional today.

---

## Test scenarios

Each scenario has the **label you should hear** before any
interaction, plus the **expected after-state**. If what you hear
doesn't match, file a ticket against the matching `A11y #N` from
the audit doc.

### S1 — Bed-card semantics (verifies A11y #1)

**Setup:** Log in as `EMP-1001` (nurse) → Bed Board → tap a ward.

**Steps:**
1. Use Tab (NVDA) or swipe right (TalkBack) to land on the first bed
   card (e.g. `A-101`).
2. Listen to the announcement.

**Expected:**
- For an occupied bed with notes:
  `"Bed A-101, Occupied, patient Demo Patient Ravi, has notes,
  button. Double tap to view details. Long press to edit notes."`
- For an available bed:
  `"Bed A-102, Available, button. Double tap to view details."`

**Failure modes to check:**
- ❌ Announces only "Bed A-101, button" — semantic label not applied.
- ❌ Reads each piece (icon, status pill, patient text) separately —
  the `_capitalize` / Semantics merge isn't working.

---

### S2 — AppBar tooltips (A11y #2)

**Setup:** Bed Board, with a ward selected.

**Steps:**
1. Tab through the AppBar action icons (Print, Refresh, Patient
   search, Logout).
2. Each should announce a verb, not just "button".

**Expected announcements:**
- `"Print bed board, button"`
- `"Refresh bed board, button"`
- `"Find patient, button"`
- `"Logout, button"`

**Failure mode:** any one of the four announces "button" alone — the
matching IconButton is missing `tooltip:`.

---

### S3 — Toast live regions (A11y #3)

**Setup:** Bed Board → tap any bed → edit notes → Save Notes.

**Steps:**
1. After tapping Save, listen.

**Expected:** Without doing anything else, the screen reader
announces: `"Success: Bed notes saved"` within 1-2 seconds of the
toast appearing.

**Failure mode:** silence after save (toast renders visually but
isn't announced) — `liveRegion: true` not wired or screen reader
isn't picking up the SnackBar.

---

### S4 — Bed quick-action chips (A11y #4)

**Setup:** Bed Board → tap an OCCUPIED bed → bed sheet opens.

**Steps:**
1. Tab/swipe through the four chips at the top of the sheet
   (Open EMR / Record Vitals / Add Note / Handover).

**Expected announcements (one per chip):**
- `"Open EMR for Demo Patient Ravi, button. Opens the open emr
  screen."`
- `"Record Vitals for Demo Patient Ravi, button. ..."`
- `"Add Note for ..., button. ..."`
- `"Handover for ..., button. ..."`

**Failure mode:** the icon and label announce separately, or just
"button" without context.

---

### S5 — Patient context chip close button (A11y #5)

**Setup:** Bed Board → tap a bed → Record Vitals chip → Vitals form
loads with the "For: Demo Patient Ravi" chip at the top.

**Steps:**
1. Tap (or focus) the X button on the chip with a finger / focus
   ring. The hit target should feel comfortable on touch and on
   keyboard focus.

**Expected:**
- The X is at least 48x48 dp (you can verify by inspecting via
  Flutter DevTools or by trying to tap with a precise stylus near
  the edge — should still register).
- Screen reader announces `"Clear patient context, button"`.
- Tapping clears the chip and the form resets.

---

### S6 — Voice dictation announcements (A11y #6)

**Setup:** Bed sheet on any patient → tap the mic icon next to
"Notes".

**Steps:**
1. Listen for the announcement on tap.
2. Watch (or listen) for the recording dialog.
3. Tap "Stop & Transcribe" and listen.

**Expected:**
- On start: `"Recording started"` (announced via
  `SemanticsService.announce`). Plus a subtle haptic on devices
  with vibration.
- On stop: `"Recording stopped, transcribing"`.
- On success: the toast announcement (S3) plus the transcript
  appears in the textarea.

**Failure mode:** silence on start/stop — `SemanticsService.announce`
not firing, or `Directionality` lookup failed.

---

### S7 — Form prefix-icon double-announcement (A11y #7)

**Setup:** Login screen.

**Steps:**
1. Tab through Employee ID → Password → Sign in.

**Expected:** each text field announces:
`"Employee ID, edit text, required"` — the icon is silent.

**Failure mode:** announcement reads:
`"badge icon, Employee ID, edit text"` — `ExcludeSemantics` not
wrapping the prefix icon.

This applies to every form in the app (vitals, notes, leave,
handover, patient picker, etc.). Spot-check 3-4 screens.

---

### S8 — Skeleton respects reduce-motion (A11y #8)

**Setup:**
- Windows: enable Animation Policy `disabled` via
  `flutter_native_splash` or test by opening the Flutter inspector
  → "Disable animations".
- Android: Settings → Accessibility → Remove animations.
- iOS: Settings → Accessibility → Motion → Reduce Motion.

**Steps:**
1. Launch the app and open Bed Board (loading triggers SkeletonList).
2. Watch the placeholder rows.

**Expected:** with reduce-motion ON, the rows are a single static
grey colour — no pulsing. With it OFF, they pulse normally.
Screen reader announces `"Loading…"` once when the skeleton mounts.

---

### S9 — Pill text scaling (A11y #9)

**Setup:**
- Windows: Settings → Accessibility → Text size → 175%.
- Android: Settings → Display → Font size → Largest.

**Steps:**
1. Open Bed Board → drill into a ward.
2. Look at the status filter pills (All / Available / Occupied /
   Maintenance) above the bed grid.

**Expected:** the labels and counts scale with the system text size.
The pill bubble grows accordingly — text doesn't clip to "..." or
overlap the count badge.

**Failure mode:** the pill labels stay 12pt regardless of the system
setting — the hard-coded `fontSize` wasn't dropped.

---

### S10 — Recent-patients list semantics (A11y #10)

**Setup:** After visiting at least 2 patient timelines, return to
dashboard. The "Recent Patients" chip strip is rendered.

**Steps:**
1. Tab/swipe to the Recent Patients section.
2. Continue moving focus through the chips.

**Expected announcements:**
- Section: `"Recent patients (3), list"` (where 3 is the count).
- Each chip: `"1 of 3: Demo Patient Ravi, button. Opens patient
  chart."`, `"2 of 3: ...", "3 of 3: ..."`.

**Failure mode:** chips read as a flat sequence with no scoping or
position — the Semantics container/index isn't applied.

---

### S11 — Keyboard shortcut Ctrl+K from anywhere (verifies C17, complementary)

**Setup:** Any screen.

**Steps:**
1. Press `Ctrl+K`.

**Expected:** patient picker modal opens, search field is auto-
focused, screen reader announces:
`"Find a patient, search field, edit text"`.

---

### S12 — Localisation (verifies D-i18n scaffold)

**Setup:** Switch Windows display language to Hindi (or Tamil/Telugu)
in Settings → Time & Language → Language → Add a language → Hindi.
Restart the staff app.

**Steps:**
1. Open Bed Board.
2. Listen / look at the AppBar title.

**Expected:** title reads `"बेड बोर्ड"` (Hindi), the dashboard
greeting reads `"सुप्रभात"` / `"नमस्ते"` / `"शुभ संध्या"` per time of
day. Material date pickers and back labels also localise.

**Caveat:** most other strings still read in English — only the
greeting + bed-board title have been migrated to `AppStrings`.
That's expected for the scaffolding milestone.

---

## Sign-off checklist

After the 12 scenarios, fill in:

| Scenario | Pass / Fail | Notes |
|---|---|---|
| S1 Bed-card label | | |
| S2 AppBar tooltips | | |
| S3 Toast live region | | |
| S4 Quick-action chips | | |
| S5 Close-button hit target | | |
| S6 Voice announcements | | |
| S7 Prefix-icon silence | | |
| S8 Reduce motion | | |
| S9 Text scaling | | |
| S10 Recent-patients list | | |
| S11 Cmd/Ctrl+K | | |
| S12 i18n switch | | |

If any row is "Fail", file a ticket referencing the corresponding
A11y #N from `ACCESSIBILITY_AUDIT.md`.

---

## What this plan does NOT cover (yet)

- **Colour contrast audit.** Use a tool like Axe DevTools or Stark
  to verify WCAG AA on body text against `AppTheme.cardSurface` and
  `AppTheme.backgroundGrey` in both light and dark mode. Out of
  scope for the screen-reader pass.
- **Focus order on long forms.** The vitals + leave + handover forms
  weren't covered; they need a Tab-walk to verify nothing skips or
  loops back. Fold into a follow-up when migrating those screens'
  hard-coded strings to AppStrings.
- **Print PDF accessibility.** The `printing` package supports
  tagged PDFs (PDF/UA). Currently disabled; would-be-nice for
  long-term audit compliance.
