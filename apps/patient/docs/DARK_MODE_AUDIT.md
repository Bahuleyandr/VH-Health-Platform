# Patient app — dark-mode audit + sweep plan

**Status:** tracking doc (2026-04-17) — executed incrementally as each
feature screen is touched.

## Baseline

`grep -rc "Colors\\." lib/` finds **340 callsites across 155 files**.
Far broader than the original FINISH_BUILDING.md estimate of 283 (the
original grep missed some re-exports). Not every callsite is a dark-mode
bug — some are intentionally hardcoded (brand, status-semantic) — but
every callsite **should be reviewed** against the rules below.

## Rules

1. **Surface colour** — `Colors.white`, `Colors.black`, `Colors.grey*`,
   `Colors.black87` — must be replaced with `Theme.of(context).colorScheme.*`:

   | Hardcoded | Use |
   |-----------|-----|
   | `Colors.white`           | `theme.colorScheme.surface` or `theme.colorScheme.onPrimary` depending on role |
   | `Colors.black`           | `theme.colorScheme.onSurface` |
   | `Colors.black87`         | `theme.colorScheme.onSurface.withValues(alpha: 0.87)` |
   | `Colors.black54`         | `theme.colorScheme.onSurfaceVariant` |
   | `Colors.grey[50–200]`    | `theme.colorScheme.surfaceContainerLow` / `surfaceContainerLowest` |
   | `Colors.grey[300–500]`   | `theme.colorScheme.outlineVariant` / `outline` |
   | `Colors.grey[600–900]`   | `theme.colorScheme.onSurfaceVariant` / `onSurface` |

2. **Brand + status** — keep hardcoded (document why at the callsite):

   | Keep | Reason |
   |------|--------|
   | Brand palette (`Color(0xFF1565C0)` etc. in `app_theme.dart`)       | Canonical brand tokens |
   | `Colors.green` / `.red` / `.orange` on status badges               | Colour carries semantic meaning across light + dark |
   | `Colors.red` on CDS allergy banner                                 | Clinical safety — must read "danger" in any theme |
   | Vitals gauges (`result_gauge_widget.dart`)                         | Medical-UX convention: reference-range colours are universal |

3. **Inline opacity** — the `dart fix` sweep in 200612d replaced
   `.withOpacity(X)` with `.withValues(alpha: X)`. When converting a
   hardcoded colour to a theme colour, preserve the alpha exactly:
   `Colors.black.withValues(alpha: 0.5)` → `theme.colorScheme.onSurface.withValues(alpha: 0.5)`.

## Top 30 files by callsite count

Tackle in descending order so each PR removes maximum callsites. Every
review must run `flutter run` in both light and dark mode to catch
regressions that static analysis misses.

| File | # callsites | Notes |
|------|------|-------|
| `features/steps/screens/step_challenge_screen.dart` | 25 | Gamified UI — many intentional brand greens. Audit carefully. |
| `features/auth/widgets/otp_ui_components.dart` | 18 | Login path — high visibility. |
| `features/steps/widgets/step_share_card.dart` | 15 | Social share card — likely mostly intentional brand colours. |
| `features/records/screens/records_screen.dart` | 15 | Main feature screen. |
| `features/pharmacy/widgets/order_status_widgets.dart` | 13 | Status badges — most are semantic. |
| `features/your_health/widgets/record_card.dart` | 12 | Listing card. |
| `features/vitals/screens/vitals_screen.dart` | 12 | Clinical screen. |
| `features/your_health/widgets/prescriptions_tab.dart` | 11 | Rx card rendering. |
| `features/pharmacy/widgets/order_form_tab.dart` | 11 | Form background/borders. |
| `features/gamification/widgets/achievement_grid.dart` | 11 | Gamification — many intentional. |
| `features/your_health/widgets/my_uploads_tab.dart` | 10 | Uploads listing. |
| `features/prescriptions/screens/refill_screen.dart` | 10 | Rx refill flow. |
| `features/chatbot/screens/symptom_checker_screen.dart` | 10 | Chat UI. |
| `features/abdm/screens/abdm_screen.dart` | 10 | Health-id integration screen. |
| `features/appointments/screens/appointments_screen.dart` | 9 | Main feature. |
| `features/family/screens/family_screen.dart` | 8 | Dependent-management. |
| `features/investigations/widgets/result_gauge_widget.dart` | 7 | **Clinical — preserve semantic colours.** |
| `features/investigations/screens/my_bookings_screen.dart` | 7 | Booking list. |
| `features/gamification/widgets/achievement_share_card.dart` | 7 | Likely brand. |
| `features/dashboard/widgets/smart_pharmacy_card.dart` | 7 | Dashboard card. |
| `features/dashboard/screens/dashboard_screen.dart` | 7 | Main landing. |
| `core/widgets/circular_feature_dial.dart` | 7 | Navigation dial — main UX element. |
| `features/departments/screens/departments_screen.dart` | 6 | Department listing. |
| `features/dashboard/widgets/wellness_score_widget.dart` | 6 | Dashboard tile. |
| `core/widgets/main_scaffold_go_router.dart` | 6 | Scaffold — high impact. |
| `features/pharmacy/widgets/order_list_tab.dart` | 5 | Listing. |
| `features/notifications/screens/notifications_screen.dart` | 5 | Alerts feed. |
| `features/feedback/screens/feedback_history_screen.dart` | 5 | History. |
| `features/dashboard/widgets/smart_investigation_card.dart` | 5 | Dashboard card. |
| `features/about/screens/about_us_screen.dart` | 5 | Static content — may keep brand. |

Remaining 125 files each have ≤4 callsites. Handle as part of "whoever
touches that file next".

## Workflow per file

```bash
# 1. Identify callsites
grep -n "Colors\." lib/features/<file>.dart

# 2. Decide per callsite: theme-map it OR keep-with-comment.
#    Use Theme.of(context).colorScheme.* for surfaces; keep brand/status.

# 3. Verify via manual run in both themes
flutter run --debug --device-id=<Android emulator>
# tap the theme toggle in settings → review every affected surface

# 4. Ship the PR. No more than 3 files per PR so review-QA loop stays tight.
```

## Regression guard (future)

Once the top 30 files land, add a CI step that fails on new
`Colors\.(white|black|black87|black54|grey)` insertions:

```bash
# .github/workflows/ci.yml — flutter-analyze job
- name: Reject hardcoded Material colours in new code
  run: |
    added=$(git diff origin/main...HEAD -- 'lib/**/*.dart' \
      | grep -E '^\+.*Colors\.(white|black|black[0-9]+|grey)' \
      | grep -v '^\+\+\+' | wc -l)
    if [ "$added" -gt 0 ]; then
      echo "::error::New hardcoded material colours introduced."
      exit 1
    fi
```

Gate it behind a `colours:audited` label until the sweep is >80%
complete; otherwise CI blocks unrelated PRs.

## Out of scope

- Dark-mode semantic tokens for the custom brand palette — `app_theme.dart`
  already defines both light + dark variants; callsites just need to
  consume them via the theme.
- Splash / launch screens — Android + iOS handle these natively.
- WebViews (symptom-checker fallback). They inherit the OS theme.
