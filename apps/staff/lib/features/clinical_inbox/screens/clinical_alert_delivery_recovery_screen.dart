import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/clinical_alert_delivery_recovery_api_service.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../l10n/app_strings.dart';

typedef ClinicalAlertRecoveryRoleLoader = Future<String> Function();

String _localizedRecoveryCode(
  AppStrings strings,
  Object? value, {
  required String prefix,
  required Set<String> supported,
}) {
  final code = value?.toString().trim().toLowerCase() ?? '';
  return strings.lookup(
    '$prefix.${supported.contains(code) ? code : 'unknown'}',
  );
}

@visibleForTesting
String localizedClinicalAlertRecoveryCaseKind(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.case_kind',
  supported: const {'manual_hold', 'recipient_coverage'},
);

@visibleForTesting
String localizedClinicalAlertRecoverySource(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.source',
  supported: const {'clinical_orders', 'icu_admissions'},
);

@visibleForTesting
String localizedClinicalAlertRecoveryCaseStatus(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.case_status',
  supported: const {'open', 'resolved'},
);

@visibleForTesting
String localizedClinicalAlertRecoveryDeliveryStatus(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.delivery_status',
  supported: const {'pending', 'completed', 'manual_hold'},
);

@visibleForTesting
String localizedClinicalAlertRecoveryTaskStatus(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.task_status',
  supported: const {
    'open',
    'in_progress',
    'blocked',
    'completed',
    'cancelled',
    'overdue',
  },
);

@visibleForTesting
String localizedClinicalAlertRecoverySlaStatus(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.sla_status',
  supported: const {
    'active',
    'completed',
    'breached',
    'escalated',
    'cancelled',
  },
);

@visibleForTesting
String localizedClinicalAlertRecoveryFailureKind(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.failure',
  supported: const {
    'order_mar_schedule',
    'order_mar_carryover',
    'icu_mar_carryover_query',
  },
);

@visibleForTesting
String localizedClinicalAlertRecoveryResolution(
  AppStrings strings,
  Object? value,
) => _localizedRecoveryCode(
  strings,
  value,
  prefix: 'med03.alert_recovery.resolution',
  supported: const {'recovered', 'manual_hold', 'superseded'},
);

@visibleForTesting
String localizedClinicalAlertRecoveryError(AppStrings strings, Object? value) =>
    _localizedRecoveryCode(
      strings,
      value,
      prefix: 'med03.alert_recovery.error',
      supported: const {
        'no_active_clinical_recipients',
        'clinical_alert_recovery_queue_failed',
        'clinical_alert_obligation_intent_invalid',
        'clinical_alert_obligation_policy_invalid',
        'clinical_alert_obligation_source_missing',
        'clinical_alert_obligation_source_mismatch',
      },
    );

class ClinicalAlertDeliveryRecoveryScreen extends StatefulWidget {
  ClinicalAlertDeliveryRecoveryScreen({
    super.key,
    this.initialCaseId,
    ClinicalAlertDeliveryRecoveryApi? api,
    ClinicalAlertRecoveryRoleLoader? roleLoader,
  }) : api = api ?? ClinicalAlertDeliveryRecoveryApiService.instance,
       roleLoader = roleLoader ?? ApiConfig.getRole;

  final String? initialCaseId;
  final ClinicalAlertDeliveryRecoveryApi api;
  final ClinicalAlertRecoveryRoleLoader roleLoader;

  @override
  State<ClinicalAlertDeliveryRecoveryScreen> createState() =>
      _ClinicalAlertDeliveryRecoveryScreenState();
}

class _ClinicalAlertDeliveryRecoveryScreenState
    extends State<ClinicalAlertDeliveryRecoveryScreen> {
  final TextEditingController _reasonController = TextEditingController();
  List<ClinicalAlertDeliveryRecoveryCase> _cases = const [];
  ClinicalAlertDeliveryRecoveryCase? _selected;
  bool _allowed = false;
  bool _loading = true;
  bool _acting = false;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _initialize() async {
    final role = (await widget.roleLoader()).trim().toUpperCase();
    if (!mounted) return;
    _allowed = role == 'ADMIN' || role == 'SUPER_ADMIN';
    if (!_allowed) {
      setState(() => _loading = false);
      return;
    }
    await _load();
  }

  Future<void> _load() async {
    if (!_allowed) return;
    setState(() {
      _loading = true;
      _errorKey = null;
    });
    try {
      final initialId = widget.initialCaseId?.trim() ?? '';
      if (initialId.isNotEmpty) {
        final recoveryCase = await widget.api.getCase(initialId);
        if (!mounted) return;
        setState(() {
          _cases = [recoveryCase];
          _selected = recoveryCase;
          _loading = false;
        });
      } else {
        final cases = await widget.api.listOpenCases();
        if (!mounted) return;
        setState(() {
          _cases = cases;
          if (_selected != null) {
            ClinicalAlertDeliveryRecoveryCase? matching;
            for (final item in cases) {
              if (item.caseId == _selected!.caseId) {
                matching = item;
                break;
              }
            }
            _selected = matching;
          }
          _loading = false;
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'med03.alert_recovery.load_failed';
      });
    }
  }

  Future<void> _act({required bool supersede}) async {
    final recoveryCase = _selected;
    if (recoveryCase == null || _acting) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final reason = _reasonController.text.trim();
    if (reason.length < 10 || reason.length > 1000) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).clinicalInboxFieldRequired),
        ),
      );
      return;
    }
    setState(() => _acting = true);
    try {
      if (supersede) {
        await widget.api.supersede(caseId: recoveryCase.caseId, reason: reason);
      } else {
        await widget.api.retry(caseId: recoveryCase.caseId, reason: reason);
      }
      if (!mounted) return;
      _reasonController.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).clinicalInboxActionRecorded),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).lookup('med03.alert_recovery.action_failed'),
          ),
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _acting = false);
        await _load();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(strings.lookup('med03.alert_recovery.title')),
        actions: [
          IconButton(
            tooltip: strings.actionRefresh,
            onPressed: _loading || !_allowed ? null : () => unawaited(_load()),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !_allowed
          ? Center(
              child: Text(
                strings.lookup('clinical_inbox.workflow_link_unavailable'),
              ),
            )
          : _loading
          ? const Center(child: CircularProgressIndicator())
          : _errorKey != null
          ? _RecoveryError(errorKey: _errorKey!, onRetry: _load)
          : _selected == null
          ? _RecoveryCaseList(cases: _cases, onSelected: _select)
          : _RecoveryCaseDetail(
              recoveryCase: _selected!,
              reasonController: _reasonController,
              acting: _acting,
              isOnline: ConnectivitySyncService.instance.isOnline,
              onBack: widget.initialCaseId == null
                  ? () => setState(() => _selected = null)
                  : null,
              onRetry: _selected!.canRetry
                  ? () => unawaited(_act(supersede: false))
                  : null,
              onSupersede: _selected!.canSupersede
                  ? () => unawaited(_act(supersede: true))
                  : null,
            ),
    );
  }

  void _select(ClinicalAlertDeliveryRecoveryCase recoveryCase) {
    setState(() {
      _selected = recoveryCase;
      _reasonController.clear();
    });
  }
}

class _RecoveryError extends StatelessWidget {
  const _RecoveryError({required this.errorKey, required this.onRetry});

  final String errorKey;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            AppStrings.of(context).lookup(errorKey),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () => unawaited(onRetry()),
            child: Text(AppStrings.of(context).actionRetry),
          ),
        ],
      ),
    ),
  );
}

class _RecoveryCaseList extends StatelessWidget {
  const _RecoveryCaseList({required this.cases, required this.onSelected});

  final List<ClinicalAlertDeliveryRecoveryCase> cases;
  final ValueChanged<ClinicalAlertDeliveryRecoveryCase> onSelected;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    if (cases.isEmpty) {
      return Center(child: Text(strings.lookup('med03.alert_recovery.empty')));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final recoveryCase = cases[index];
        return Card(
          child: ListTile(
            title: Text(
              localizedClinicalAlertRecoveryCaseKind(
                strings,
                recoveryCase.caseKind,
              ),
            ),
            subtitle: Text(
              '${localizedClinicalAlertRecoverySource(strings, recoveryCase.sourceTable)} '
              '#${recoveryCase.sourceId}\n'
              '${localizedClinicalAlertRecoveryTaskStatus(strings, recoveryCase.taskStatus)} '
              '• ${localizedClinicalAlertRecoverySlaStatus(strings, recoveryCase.slaStatus)}',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => onSelected(recoveryCase),
          ),
        );
      },
    );
  }
}

class _RecoveryCaseDetail extends StatelessWidget {
  const _RecoveryCaseDetail({
    required this.recoveryCase,
    required this.reasonController,
    required this.acting,
    required this.isOnline,
    required this.onBack,
    required this.onRetry,
    required this.onSupersede,
  });

  final ClinicalAlertDeliveryRecoveryCase recoveryCase;
  final TextEditingController reasonController;
  final bool acting;
  final bool isOnline;
  final VoidCallback? onBack;
  final VoidCallback? onRetry;
  final VoidCallback? onSupersede;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final due =
        recoveryCase.dueAt?.toIso8601String() ?? strings.clinicalInboxSlaNoDue;
    final timing = strings
        .lookup('med03.alert_recovery.timing_value')
        .replaceAll('{due}', due)
        .replaceAll('{seconds}', '${recoveryCase.openAgeSeconds}')
        .replaceAll('{count}', '${recoveryCase.escalationAttemptCount}');
    final manualHoldCode = recoveryCase.manualHoldCode.trim().toLowerCase();
    final lastErrorCode = recoveryCase.lastErrorCode.trim().toLowerCase();
    final values = <(String, String)>[
      (
        strings.lookup('med03.alert_recovery.field.case_status'),
        localizedClinicalAlertRecoveryCaseStatus(strings, recoveryCase.status),
      ),
      (
        strings.lookup('med03.alert_recovery.field.delivery_status'),
        localizedClinicalAlertRecoveryDeliveryStatus(
          strings,
          recoveryCase.obligationStatus,
        ),
      ),
      (
        strings.lookup('med03.alert_recovery.field.task_status'),
        localizedClinicalAlertRecoveryTaskStatus(
          strings,
          recoveryCase.taskStatus,
        ),
      ),
      (
        strings.lookup('med03.alert_recovery.field.sla_status'),
        localizedClinicalAlertRecoverySlaStatus(
          strings,
          recoveryCase.slaStatus,
        ),
      ),
      (
        strings.lookup('med03.alert_recovery.field.source'),
        '${localizedClinicalAlertRecoverySource(strings, recoveryCase.sourceTable)} '
            '#${recoveryCase.sourceId}',
      ),
      (
        strings.lookup('med03.alert_recovery.field.failure'),
        localizedClinicalAlertRecoveryFailureKind(
          strings,
          recoveryCase.failureKind,
        ),
      ),
      (strings.lookup('med03.alert_recovery.field.timing'), timing),
      if (lastErrorCode.isNotEmpty && lastErrorCode != manualHoldCode)
        (
          strings.lookup('med03.alert_recovery.field.last_error'),
          localizedClinicalAlertRecoveryError(
            strings,
            recoveryCase.lastErrorCode,
          ),
        ),
      if (manualHoldCode.isNotEmpty || recoveryCase.manualHoldReason.isNotEmpty)
        (
          strings.lookup('med03.alert_recovery.field.hold_reason'),
          localizedClinicalAlertRecoveryError(
            strings,
            recoveryCase.manualHoldCode,
          ),
        ),
      if (recoveryCase.resolutionKind.isNotEmpty)
        (
          strings.lookup('med03.alert_recovery.field.resolution'),
          localizedClinicalAlertRecoveryResolution(
            strings,
            recoveryCase.resolutionKind,
          ),
        ),
    ];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (onBack != null)
          Align(
            alignment: Alignment.centerLeft,
            child: BackButton(onPressed: onBack),
          ),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  localizedClinicalAlertRecoveryCaseKind(
                    strings,
                    recoveryCase.caseKind,
                  ),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                for (final value in values) ...[
                  Text(
                    value.$1,
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                  SelectableText(value.$2),
                  const SizedBox(height: 10),
                ],
              ],
            ),
          ),
        ),
        if (recoveryCase.isOpen) ...[
          const SizedBox(height: 12),
          TextField(
            controller: reasonController,
            minLines: 2,
            maxLines: 5,
            maxLength: 1000,
            enabled: !acting && isOnline,
            decoration: InputDecoration(
              labelText: strings.clinicalInboxActionReason,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          if (onRetry != null)
            FilledButton.icon(
              onPressed: acting || !isOnline ? null : onRetry,
              icon: const Icon(Icons.replay),
              label: Text(strings.actionRetry),
            ),
          if (onSupersede != null)
            FilledButton.icon(
              onPressed: acting || !isOnline ? null : onSupersede,
              icon: const Icon(Icons.fact_check_outlined),
              label: Text(strings.clinicalInboxReviewAction),
            ),
        ],
      ],
    );
  }
}
