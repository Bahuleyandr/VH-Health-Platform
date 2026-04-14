# Feature folder convention — VH-health (patient app)

> This doc describes the canonical layout for anything under `lib/features/`.
> Old features don't all follow this shape yet — migrate opportunistically as
> you touch them, don't rewrite everything at once.

## Goal

A developer scanning `lib/features/<thing>/` should immediately see where to
look for UI, state, data, and models — without having to open three files
to find out what "thing" means.

## Canonical shape

```
lib/features/<feature>/
├── screens/         — full-route widgets (mounted by go_router)
├── widgets/         — reusable UI blocks used inside this feature's screens
├── services/        — feature-scoped API calls + domain logic
├── models/          — data classes scoped to this feature
├── controllers/     — optional: stateful coordinators (Provider/ChangeNotifier)
└── README.md        — optional: non-obvious decisions, deep links, routes owned
```

Only `screens/` is mandatory. If a feature has no reusable widgets of its
own, skip `widgets/`. If all API calls are in `core/services/api_client.dart`
via a thin wrapper, skip `services/`.

## Rules

1. **No cross-feature imports.** A file in `features/pharmacy/` must not
   import from `features/appointments/`. If two features share something,
   promote it to `lib/core/` or to a new feature (e.g. `features/shared/`
   if it's app-wide but not core-grade).

2. **Models live with the feature that owns them.** A `PharmacyOrder` type
   used only by pharmacy screens is `features/pharmacy/models/`. If records,
   dashboard, and calendar all need it, promote to `lib/core/models/`.

3. **Screens don't fetch; controllers do.** A screen widget builds UI. State
   + API calls belong in a `ChangeNotifier` under `controllers/` (or
   `services/`). The screen consumes via `context.watch`. Small screens can
   still use `StatefulWidget` + `initState` fetch; the rule is about growth
   beyond ~200 lines.

4. **Feature-internal widgets go in `widgets/`, app-wide widgets in
   `lib/core/widgets/`.** The rule of thumb: is this widget useful to another
   feature? If yes, promote.

5. **README.md is optional but encouraged** when a feature has:
   - More than 5 screens
   - Non-obvious route guards
   - Deep-link handling
   - A state model that needs explaining (e.g. offline sync)

## Migration order

When touching an old feature that doesn't match this shape:

1. Create the missing directories (`screens/`, `widgets/`, etc.).
2. Move files in — prefer one PR per feature so reviewers can see it clearly.
3. Update imports.
4. Don't rename public symbols in the same PR; do that separately.

## What goes where — cheat sheet

| You're adding… | It goes in… |
|---|---|
| A new route-level screen | `features/<feature>/screens/` |
| A card / list item / modal used in this feature | `features/<feature>/widgets/` |
| A card / list item used in 2+ features | `lib/core/widgets/` |
| An HTTP call to a new backend endpoint | `features/<feature>/services/` (or extend `core/services/api_client.dart` if generic) |
| A DTO / value type for this feature | `features/<feature>/models/` |
| A DTO used across features | `lib/core/models/` |
| Constants used across features | `lib/core/constants/` |
| Theme tokens | `lib/core/theme/` (or promote to `vhhealth_core`) |

## Pitfalls to avoid

- **"utils/" bags.** Prefer named files per concern (`date_formatter.dart`,
  not `helpers.dart`). `utils/` becomes a junk drawer.
- **Mega-screens.** If a screen file goes past ~500 lines, extract tabs /
  sections to `widgets/`. `dashboard_screen.dart` and `health_points_screen.dart`
  were already split — check those for patterns.
- **Importing `package:flutter/material.dart` in services.** Services should
  be pure Dart (testable without a Flutter runner). UI types live in screens
  and widgets.
