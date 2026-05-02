# Staff App — Accessibility Audit

_Last updated: 2026-05-02 — first full sweep after the UX upgrade run._

This is a read-only gap report. None of the items below have been
fixed yet — they're queued for a dedicated accessibility-focused
session. The list is ordered by impact (severity × frequency on the
clinical floor); pick from the top down.

---

## Methodology

- Reviewed the 65 screen files under `apps/staff/lib/features/` plus
  the 12 shared widgets under `apps/staff/lib/core/widgets/`.
- Checked for: missing `Semantics` labels, image-only icon buttons,
  contrast against `AppTheme.brightness`, focus-order inversions on
  desktop, and keyboard reachability.
- Did NOT run a real screen-reader pass (TalkBack / NVDA / VoiceOver)
  — that's the next step once these structural gaps are filled.

---

## Top 10 prioritized gaps

### 1. Bed-card status is conveyed by colour alone

`features/beds/screens/bed_board_screen.dart` — bed cards distinguish
available / occupied / maintenance via a green / red / orange border
+ icon tint. The status text IS rendered but is small and tucked
inside a coloured pill. Colour-blind users (≈8% of male staff) can't
tell occupied from maintenance reliably.

**Fix:** wrap the bed card in `Semantics(label: 'Bed $n, $status,
patient $name')` so screen readers and high-contrast mode both
work. Also bold/uppercase the status pill text.

### 2. Icon-only AppBar actions lack tooltips on some screens

The `LogoutAction` and `PatientSearchAction` widgets DO set
`tooltip:` already, but several inline `IconButton` instances —
notably the refresh button in `bed_board_screen.dart`, the print
button (just shipped in C19), and the back button in `_buildBedGrid`
— either omit `tooltip:` or have one that's missing on long-press.
Screen readers fall back to the icon's CodePoint, which is useless.

**Fix:** add `tooltip: ` to every `IconButton` in the AppBar actions
or top header. Easy mechanical sweep.

### 3. Toast messages don't announce to screen readers

`SuccessToast` and `ErrorToast` use the standard `SnackBar` API but
without `Semantics(liveRegion: true)`. A nurse using TalkBack won't
hear "Bed notes saved" — they'll just see no visible UI change.

**Fix:** wrap the SnackBar `content` in
`Semantics(liveRegion: true, label: …)` so assistive tech announces
the message immediately.

### 4. Quick-action chips on the bed sheet have no semantic labels

`_BedQuickActions` in `bed_board_screen.dart` builds 4 tappable
columns (icon + 11pt text) inside an InkWell. The icon is decorative
and the label text is inside a `Column`, so screen readers see the
icon as one node and the label as a separate node — the relationship
isn't explicit.

**Fix:** wrap the InkWell child in `Semantics(button: true, label:
'$action for $patientName')`.

### 5. Patient context chip's "X" button is a 22pt hit target

`PatientContextChip` has a small close icon at 18pt that users with
motor impairments can miss. Material guidance is 48dp minimum.

**Fix:** wrap in `Tooltip` + bump the IconButton's `iconSize` to 24
and `padding` to 12.

### 6. Recording dialog has no announcement

`_RecordingDialog` in `voice_dictate_button.dart` shows a pulsing red
mic + timer. A blind user has no audio cue that recording started.
Mic dictation is meant to BE the accessibility win — but if you
can't tell it started, it's worse than the keyboard.

**Fix:** add `SemanticsService.announce('Recording started')` on
mount and `'Recording stopped'` on stop. Plus a haptic via
`HapticFeedback.lightImpact()`.

### 7. Form fields with prefix icons have no semantic decoration

Most `TextFormField`s in nursing-notes / handover / vitals use a
`prefixIcon: Icon(...)` for visual flair. The icon has no label, so
screen readers read "edit text, edit text, edit text" without
context. The `labelText` should be enough but isn't always read.

**Fix:** add `decoration: InputDecoration(prefixIcon:
ExcludeSemantics(child: Icon(...)), ...)` so the icon doesn't
double-announce, and verify `labelText` propagates as the field's
semantic label.

### 8. Skeleton loaders pulse forever — bad for vestibular sensitivity

`SkeletonList` and `SkeletonGrid` (just shipped in A6) animate 24/7
while the list is loading. Users with vestibular disorders can find
the pulse triggering. The shimmer is decorative; the loading state
is the message.

**Fix:** check `MediaQuery.disableAnimations` (or
`MediaQueryData.fromView(view).accessibleNavigation`); when set,
fall back to a static colour for the placeholder boxes.

### 9. Status pills on bed grid hard-code 11pt text

The status filter pills (`_statusPill`) use a 12pt label and 11pt
count badge. Users with `MediaQuery.textScaleFactor > 1.3` get
clipped text. Standard guidance is to allow scaling up to 200%.

**Fix:** drop the explicit `fontSize:` — let the pill inherit
`Theme.of(context).textTheme.bodySmall` so the user's text-size
preference applies.

### 10. Recent-patients chips don't announce as a list

`_buildRecentPatients` on the dashboard builds a horizontal
`ListView.separated` of `ActionChip`s. Screen readers read each chip
in isolation — "Demo Patient Ravi, button" — without "1 of 5" /
"item 2 in list". Easy fix.

**Fix:** wrap the `SizedBox(height:44, child: ListView…)` in
`Semantics(container: true, label: 'Recent patients', child: …)`.

---

## Out of scope (would-be-nice but lower impact)

- **High-contrast theme variant.** The dark mode work is recent and
  visually distinct, but neither light nor dark currently meets WCAG
  AAA contrast on the secondary text colour. Worth a follow-up.
- **Dynamic font scaling on the SliverAppBar greeting.** Currently
  the dashboard greeting forces 24pt; should use the inherited theme
  text style.
- **Bed grid keyboard navigation.** Tab moves between cards but
  there's no visible focus ring on the InkWell. Either ship a
  custom focus-highlight decoration or use Material's `FocusRing`.
- **Alt-text on the bed status icons.** They're decorative repeats
  of the status pill, so they're fine to mark
  `ExcludeSemantics`.
- **Print PDF accessibility.** The PDF generated by
  `BedBoardPrintService` is a tagged-PDF candidate — `pdf` package
  has tagging support but it's opt-in and currently not configured.

---

## Suggested next-step ordering

1. Sweep #1, #2, #3, #4, #6, #10 in one batch — all 10 line edits
   each, no architectural change. About 2 hours total.
2. Run TalkBack on Android (or NVDA on Windows) against a build with
   those fixes; capture remaining gaps.
3. Tackle #5, #8, #9 (visual / motor accessibility); needs slightly
   more thought on focus + animation defaults.
4. Then come back to the out-of-scope items (themes, PDF tagging).

The total is comfortably one focused session.
