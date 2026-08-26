import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/period_tracker/screens/period_tracker_screen.dart';
import 'package:vhhealth/features/period_tracker/services/period_tracker_eligibility_loader.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PeriodTrackerDeepLinkRoute extends StatefulWidget {
  const PeriodTrackerDeepLinkRoute({
    super.key,
    this.warmEligible = false,
    this.loader = const ApiPeriodTrackerEligibilityLoader(),
  });

  final bool warmEligible;
  final PeriodTrackerEligibilityLoader loader;

  @override
  State<PeriodTrackerDeepLinkRoute> createState() =>
      _PeriodTrackerDeepLinkRouteState();
}

class _PeriodTrackerDeepLinkRouteState
    extends State<PeriodTrackerDeepLinkRoute> {
  PeriodTrackerEligibilityResult? _result;
  int _loadRevision = 0;

  @override
  void initState() {
    super.initState();
    if (widget.warmEligible) {
      _result = const PeriodTrackerEligible();
    } else {
      _load();
    }
  }

  @override
  void didUpdateWidget(covariant PeriodTrackerDeepLinkRoute oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.warmEligible != widget.warmEligible ||
        oldWidget.loader != widget.loader) {
      if (widget.warmEligible) {
        _loadRevision += 1;
        setState(() => _result = const PeriodTrackerEligible());
      } else {
        _load();
      }
    }
  }

  Future<void> _load() async {
    final revision = ++_loadRevision;
    setState(() => _result = null);
    PeriodTrackerEligibilityResult result;
    try {
      result = await widget.loader.load();
    } catch (_) {
      result = const PeriodTrackerEligibilityFailed(
        PeriodTrackerEligibilityFailureKind.unavailable,
      );
    }
    if (!mounted || revision != _loadRevision) return;
    setState(() => _result = result);
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    if (result == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (result is PeriodTrackerEligible) return const PeriodTrackerScreen();
    return _PeriodTrackerEligibilityError(result: result, onRetry: _load);
  }
}

class _PeriodTrackerEligibilityError extends StatelessWidget {
  const _PeriodTrackerEligibilityError({
    required this.result,
    required this.onRetry,
  });

  final PeriodTrackerEligibilityResult result;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final message = switch (result) {
      PeriodTrackerIneligible() => l.periodTrackerProfileUnavailable,
      PeriodTrackerEligibilityFailed(
        kind: PeriodTrackerEligibilityFailureKind.unauthenticated,
      ) =>
        l.appointmentsLogOutAndBack,
      PeriodTrackerEligibilityFailed(
        kind: PeriodTrackerEligibilityFailureKind.offlineUnavailable,
      ) =>
        l.patientOutageCacheUnavailable,
      _ => l.periodTrackerProfileUnavailable,
    };
    return Scaffold(
      appBar: AppBar(title: Text(l.periodTrackerTitle)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.health_and_safety_outlined,
                size: 48,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 16),
              Text(message, textAlign: TextAlign.center),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_outlined),
                label: Text(l.commonRetry),
              ),
              TextButton(
                onPressed: () => context.go('/home'),
                child: Text(l.commonBackButton),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
