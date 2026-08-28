import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

@visibleForTesting
const Set<String> billingCreditNoteReviewerRoles = {
  'ADMIN',
  'SUPER_ADMIN',
  'FINANCE_INCHARGE',
  'BILLING_INCHARGE',
};

@visibleForTesting
const Set<String> billingRefundApproverRoles = {'ADMIN', 'SUPER_ADMIN'};

@visibleForTesting
const Set<String> billingRefundPayoutRoles = {
  'ADMIN',
  'SUPER_ADMIN',
  'FINANCE_INCHARGE',
  'BILLING_INCHARGE',
};

@visibleForTesting
const Set<String> manualMedicationRefundModes = {'CASH', 'CHEQUE', 'DD'};

@visibleForTesting
const Set<String> gatewayMedicationRefundModes = {
  'CARD',
  'UPI',
  'NETBANKING',
  'WALLET',
};

bool billingCreditNoteCanReview(String role) =>
    billingCreditNoteReviewerRoles.contains(role.trim().toUpperCase());

bool billingCreditNoteCanApproveRefund(String role) =>
    billingRefundApproverRoles.contains(role.trim().toUpperCase());

bool billingCreditNoteCanSettleRefund(String role) =>
    billingRefundPayoutRoles.contains(role.trim().toUpperCase());

@visibleForTesting
String? billingRefundWorkbenchRoute(Object? refundId) {
  final value = refundId?.toString().trim() ?? '';
  final parsed = int.tryParse(value);
  if (parsed == null ||
      parsed < 1 ||
      parsed > 2147483647 ||
      value.startsWith('0')) {
    return null;
  }
  return '/billing/refunds?refund_id=$value';
}

@visibleForTesting
String localizedBillingCreditNoteStatus(AppStrings strings, Object? code) {
  final normalized = code?.toString().trim().toLowerCase() ?? '';
  const supported = {
    'all',
    'pending',
    'approved',
    'applied',
    'rejected',
    'paid',
  };
  return strings.lookup(
    supported.contains(normalized)
        ? 'med03.credit_note.status.$normalized'
        : 'med03.credit_note.status.unknown',
  );
}

@visibleForTesting
String localizedBillingCreditNoteEvent(AppStrings strings, Object? code) {
  final normalized = code?.toString().trim().toLowerCase() ?? '';
  if (normalized == 'raised') {
    return strings.lookup('med03.credit_note.event.raised');
  }
  return localizedBillingCreditNoteStatus(strings, normalized);
}

@visibleForTesting
String localizedBillingRefundMode(AppStrings strings, Object? code) {
  final normalized = code?.toString().trim().toLowerCase() ?? '';
  const supported = {
    'cash',
    'card',
    'upi',
    'netbanking',
    'cheque',
    'dd',
    'wallet',
    'insurance',
  };
  return strings.lookup(
    supported.contains(normalized)
        ? 'med03.credit_note.refund_mode.$normalized'
        : 'med03.credit_note.refund_mode.unknown',
  );
}

class BillingCreditNotesScreen extends StatefulWidget {
  const BillingCreditNotesScreen({super.key, this.initialCreditNoteId});

  final String? initialCreditNoteId;

  @override
  State<BillingCreditNotesScreen> createState() =>
      _BillingCreditNotesScreenState();
}

class _BillingCreditNotesScreenState extends State<BillingCreditNotesScreen> {
  String _role = '';
  String _status = 'all';
  bool _loading = true;
  bool _acting = false;
  String? _error;
  List<Map<String, dynamic>> _notes = const [];
  Map<String, dynamic>? _selected;
  final IdempotencyAttemptRegistry _actionAttempts =
      IdempotencyAttemptRegistry();

  bool get _canReview => billingCreditNoteCanReview(_role);
  bool get _canApproveRefund => billingCreditNoteCanApproveRefund(_role);
  bool get _canSettleRefund => billingCreditNoteCanSettleRefund(_role);

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void dispose() {
    _actionAttempts.clear();
    super.dispose();
  }

  Future<void> _initialize() async {
    final role = (await ApiConfig.getRole()).trim().toUpperCase();
    if (!mounted) return;
    setState(() => _role = role);
    if (!billingCreditNoteCanReview(role)) {
      setState(() => _loading = false);
      return;
    }
    await _load();
  }

  Future<void> _load({String? selectId}) async {
    if (!_canReview) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final notes = await BillingApiService.listMedicationCreditNotes(
        status: _status == 'all' ? null : _status,
      );
      final target =
          selectId ??
          _selected?['id']?.toString() ??
          widget.initialCreditNoteId;
      Map<String, dynamic>? detail;
      if (target != null && target.trim().isNotEmpty) {
        detail = await BillingApiService.getMedicationCreditNote(target);
      }
      if (!mounted) return;
      setState(() {
        _notes = notes;
        _selected = detail;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), error);
      });
    }
  }

  Future<void> _select(Map<String, dynamic> note) async {
    final id = note['id']?.toString();
    if (id == null || id.isEmpty) return;
    await _load(selectId: id);
  }

  Future<bool> _confirm(String titleKey, String bodyKey) async {
    return await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: AppText(titleKey),
            content: AppText(bodyKey),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const AppText('action.cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const AppText('action.confirm'),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<String?> _promptText({
    required String titleKey,
    required String labelKey,
    int minLength = 1,
  }) async {
    final controller = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: AppText(titleKey),
          content: TextField(
            controller: controller,
            autofocus: true,
            minLines: 1,
            maxLines: 4,
            onChanged: (_) => setDialogState(() {}),
            decoration: InputDecoration(
              labelText: AppStrings.of(context).lookup(labelKey),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const AppText('action.cancel'),
            ),
            FilledButton(
              onPressed: controller.text.trim().length < minLength
                  ? null
                  : () => Navigator.pop(context, controller.text.trim()),
              child: const AppText('action.confirm'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    return value;
  }

  Future<String?> _promptRefundMode() async {
    String? mode;
    return showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const AppText('med03.credit_note.apply_title'),
          content: DropdownButtonFormField<String>(
            initialValue: mode,
            decoration: InputDecoration(
              labelText: AppStrings.of(context)
                  .lookup('med03.credit_note.refund_mode'),
            ),
            items:
                const [
                      'CASH',
                      'CARD',
                      'UPI',
                      'NETBANKING',
                      'CHEQUE',
                      'DD',
                      'WALLET',
                    ]
                    .map(
                      (value) => DropdownMenuItem(
                        value: value,
                        child: Text(
                          localizedBillingRefundMode(
                            AppStrings.of(context),
                            value,
                          ),
                        ),
                      ),
                    )
                    .toList(),
            onChanged: (value) => setDialogState(() => mode = value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const AppText('action.cancel'),
            ),
            FilledButton(
              onPressed: mode == null
                  ? null
                  : () => Navigator.pop(context, mode),
              child: const AppText('med03.credit_note.action_apply'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _runAction({
    required String attemptScope,
    required Object payload,
    required Future<void> Function(String idempotencyKey) action,
  }) async {
    if (_acting || !OnlineOnlyActionGuard.require(context)) return;
    final idempotencyKey = _actionAttempts.keyFor(attemptScope, payload);
    setState(() {
      _acting = true;
      _error = null;
    });
    try {
      await action(idempotencyKey);
      _actionAttempts.complete(attemptScope);
      if (!mounted) return;
      final id = _selected?['id']?.toString();
      await _load(selectId: id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: AppText('med03.credit_note.action_completed')),
      );
    } catch (error) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), error),
      );
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _approveCreditNote() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    if (!await _confirm(
      'med03.credit_note.approve_title',
      'med03.credit_note.approve_body',
    )) {
      return;
    }
    final id = _selected!['id'].toString();
    await _runAction(
      attemptScope: 'billing-credit-note:$id:approve',
      payload: const <String, dynamic>{},
      action: (idempotencyKey) async {
        await BillingApiService.approveMedicationCreditNote(
          creditNoteId: id,
          idempotencyKey: idempotencyKey,
        );
      },
    );
  }

  Future<void> _rejectCreditNote() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final reason = await _promptText(
      titleKey: 'med03.credit_note.reject_title',
      labelKey: 'med03.credit_note.rejection_reason',
      minLength: 3,
    );
    if (reason == null) return;
    final id = _selected!['id'].toString();
    final payload = <String, dynamic>{'rejection_reason': reason.trim()};
    await _runAction(
      attemptScope: 'billing-credit-note:$id:reject',
      payload: payload,
      action: (idempotencyKey) async {
        await BillingApiService.rejectMedicationCreditNote(
          creditNoteId: id,
          rejectionReason: reason,
          idempotencyKey: idempotencyKey,
        );
      },
    );
  }

  Future<void> _applyCreditNote() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final note = _selected!;
    final amountMinor = _integer(note['amount_minor']);
    final dueMinor = (_number(note['amount_due']) * 100).round();
    final needsRefund = amountMinor > dueMinor;
    final mode = needsRefund ? await _promptRefundMode() : null;
    if (needsRefund && mode == null) return;
    if (!needsRefund &&
        !await _confirm(
          'med03.credit_note.apply_title',
          'med03.credit_note.apply_body',
        )) {
      return;
    }
    final id = note['id'].toString();
    final payload = <String, dynamic>{
      if (mode != null && mode.trim().isNotEmpty)
        'refund_mode': mode.trim().toUpperCase(),
    };
    await _runAction(
      attemptScope: 'billing-credit-note:$id:apply',
      payload: payload,
      action: (idempotencyKey) async {
        await BillingApiService.applyMedicationCreditNote(
          creditNoteId: id,
          refundMode: mode,
          idempotencyKey: idempotencyKey,
        );
      },
    );
  }

  Future<void> _approveRefund() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final refund = _refund;
    if (refund == null ||
        !await _confirm(
          'med03.credit_note.refund_approve_title',
          'med03.credit_note.refund_approve_body',
        )) {
      return;
    }
    final refundId = _integer(refund['id']);
    await _runAction(
      attemptScope: 'billing-refund:$refundId:approve',
      payload: const <String, dynamic>{},
      action: (idempotencyKey) async => BillingApiService.approveRefund(
        refundId,
        idempotencyKey: idempotencyKey,
      ),
    );
  }

  void _openRefundWorkbench(Map<String, dynamic> refund) {
    final route = billingRefundWorkbenchRoute(refund['id']);
    if (route == null) return;
    context.push(route);
  }

  Map<String, dynamic>? get _refund {
    final value = _selected?['refund'];
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  int _integer(dynamic value) => int.tryParse(value?.toString() ?? '') ?? 0;

  double _number(dynamic value) =>
      double.tryParse(value?.toString() ?? '') ?? 0;

  String _minorMoney(dynamic value) =>
      '₹${(_integer(value) / 100).toStringAsFixed(2)}';

  String _money(dynamic value) => '₹${_number(value).toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup('med03.credit_note.title'),
      actions: [
        if (_role == 'ADMIN' || _role == 'SUPER_ADMIN')
          IconButton(
            tooltip: strings.lookup(
              'med03.gateway_refund_reconciliation.open_queue',
            ),
            onPressed: () =>
                context.push('/billing/gateway-refund-reconciliation'),
            icon: const Icon(Icons.sync_problem_outlined),
          ),
        IconButton(
          tooltip: strings.lookup('action.refresh'),
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: !_canReview && !_loading
          ? const _AccessDenied()
          : _loading && _notes.isEmpty && _selected == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 980;
                  return ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (_error != null) ...[
                        _Notice(text: _error!, error: true),
                        const SizedBox(height: 12),
                      ],
                      if (wide)
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(width: 350, child: _buildQueue()),
                            const SizedBox(width: 12),
                            Expanded(child: _buildDetail()),
                          ],
                        )
                      else ...[
                        _buildQueue(),
                        const SizedBox(height: 12),
                        _buildDetail(),
                      ],
                    ],
                  );
                },
              ),
            ),
    );
  }

  Widget _buildQueue() {
    final strings = AppStrings.of(context);
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.request_quote_outlined),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  strings.lookup('med03.credit_note.queue'),
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              SizedBox(
                width: 132,
                child: DropdownButtonFormField<String>(
                  initialValue: _status,
                  isDense: true,
                  items:
                      const [
                            'all',
                            'pending',
                            'approved',
                            'applied',
                            'rejected',
                          ]
                          .map(
                            (status) => DropdownMenuItem(
                              value: status,
                              child: Text(
                                strings.lookup(
                                  'med03.credit_note.status.$status',
                                ),
                              ),
                            ),
                          )
                          .toList(),
                  onChanged: _loading
                      ? null
                      : (value) {
                          if (value == null) return;
                          setState(() {
                            _status = value;
                            _selected = null;
                          });
                          _load();
                        },
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_notes.isEmpty)
            const _Notice(textKey: 'med03.credit_note.empty')
          else
            ..._notes.map((note) {
              final selected =
                  note['id']?.toString() == _selected?['id']?.toString();
              return Card(
                color: selected
                    ? AppTheme.primaryBlue.withValues(alpha: 0.10)
                    : null,
                child: ListTile(
                  selected: selected,
                  onTap: _loading ? null : () => _select(note),
                  title: Text(
                    note['credit_note_number']?.toString() ?? '#${note['id']}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  subtitle: Text(
                    '${note['invoice_number'] ?? '#${note['invoice_id']}'} · '
                    '${_minorMoney(note['amount_minor'])}',
                  ),
                  trailing: _StatusChip(status: note['status']?.toString()),
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _buildDetail() {
    final note = _selected;
    if (note == null) {
      return const _Panel(child: _Notice(textKey: 'med03.credit_note.select'));
    }
    final strings = AppStrings.of(context);
    final status = note['status']?.toString().toLowerCase() ?? '';
    final events = (note['events'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                note['credit_note_number']?.toString() ?? '#${note['id']}',
                style: Theme.of(context).textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
              _StatusChip(status: status),
              if (_acting)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              _Fact(
                label: strings.lookup('med03.credit_note.invoice'),
                value:
                    note['invoice_number']?.toString() ??
                    '#${note['invoice_id']}',
              ),
              _Fact(
                label: strings.lookup('med03.credit_note.ward_indent'),
                value:
                    note['indent_number']?.toString() ??
                    '#${note['ward_indent_id']}',
              ),
              _Fact(
                label: strings.lookup('med03.credit_note.amount'),
                value: _minorMoney(note['amount_minor']),
              ),
              _Fact(
                label: strings.lookup('med03.credit_note.account_due'),
                value: _money(note['amount_due']),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            note['reason']?.toString() ?? '',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          if (status == 'pending')
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: _acting ? null : _approveCreditNote,
                  icon: const Icon(Icons.check_circle_outline),
                  label: const AppText('med03.credit_note.action_approve'),
                ),
                OutlinedButton.icon(
                  onPressed: _acting ? null : _rejectCreditNote,
                  icon: const Icon(Icons.cancel_outlined),
                  label: const AppText('med03.credit_note.action_reject'),
                ),
              ],
            ),
          if (status == 'approved') ...[
            const _Notice(textKey: 'med03.credit_note.application_owned'),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: _acting ? null : _applyCreditNote,
              icon: const Icon(Icons.account_balance_wallet_outlined),
              label: const AppText('med03.credit_note.action_apply'),
            ),
          ],
          if (_refund != null) ...[
            const SizedBox(height: 18),
            _buildRefund(_refund!),
          ],
          if (events.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text(
              strings.lookup('med03.credit_note.events'),
              style: Theme.of(context).textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            ...events.reversed.map(
              (event) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.history, size: 18),
                title: Text(
                  localizedBillingCreditNoteEvent(strings, event['event_type']),
                ),
                subtitle: Text(event['occurred_at']?.toString() ?? ''),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildRefund(Map<String, dynamic> refund) {
    final strings = AppStrings.of(context);
    final status = refund['approval_status']?.toString().toUpperCase() ?? '';
    final mode = refund['mode']?.toString().toUpperCase() ?? '';
    final payoutRail = refund['payout_rail']?.toString().toLowerCase();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.warningAmber.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: AppTheme.warningAmber.withValues(alpha: 0.45),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                strings.lookup('med03.credit_note.refund'),
                style: Theme.of(context).textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
              _StatusChip(status: status),
              Text(
                '${_money(refund['amount'])} · '
                '${localizedBillingRefundMode(strings, mode)}',
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (status == 'PENDING') ...[
            const _Notice(textKey: 'med03.credit_note.refund_pending'),
            if (_canApproveRefund) ...[
              const SizedBox(height: 8),
              FilledButton.icon(
                onPressed: _acting ? null : _approveRefund,
                icon: const Icon(Icons.approval_outlined),
                label: const AppText('med03.credit_note.action_approve_refund'),
              ),
            ],
          ],
          if (status == 'APPROVED') ...[
            _Notice(
              textKey: mode == 'INSURANCE'
                  ? 'med03.credit_note.insurance_hold'
                  : payoutRail == 'gateway'
                  ? 'med03.credit_note.gateway_in_progress'
                  : manualMedicationRefundModes.contains(mode)
                  ? 'med03.credit_note.manual_help'
                  : gatewayMedicationRefundModes.contains(mode)
                  ? 'med03.credit_note.gateway_help'
                  : 'med03.credit_note.insurance_hold',
            ),
            if (_canSettleRefund &&
                (manualMedicationRefundModes.contains(mode) ||
                    gatewayMedicationRefundModes.contains(mode))) ...[
              const SizedBox(height: 8),
              FilledButton.icon(
                key: const ValueKey('medication-refund-open-workbench'),
                onPressed: _acting ? null : () => _openRefundWorkbench(refund),
                icon: const Icon(Icons.payments_outlined),
                label: const AppText('med03.credit_note.action_record_payout'),
              ),
            ],
          ],
          if (status == 'PAID')
            const _Notice(textKey: 'med03.credit_note.refund_paid'),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Theme.of(context).dividerColor),
        ),
        child: child,
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({this.status});

  final String? status;

  @override
  Widget build(BuildContext context) {
    final value = status?.trim().toUpperCase() ?? 'UNKNOWN';
    final color = switch (value) {
      'APPLIED' || 'PAID' => AppTheme.primaryTeal,
      'APPROVED' => AppTheme.primaryBlue,
      'REJECTED' => AppTheme.errorRed,
      _ => AppTheme.warningAmber,
    };
    return Chip(
      visualDensity: VisualDensity.compact,
      label: Text(
        localizedBillingCreditNoteStatus(AppStrings.of(context), value),
      ),
      backgroundColor: color.withValues(alpha: 0.13),
      side: BorderSide(color: color.withValues(alpha: 0.45)),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 140),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelSmall),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({this.text, this.textKey, this.error = false});

  final String? text;
  final String? textKey;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final value = text ?? AppStrings.of(context).lookup(textKey!);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: (error ? AppTheme.errorRed : AppTheme.primaryBlue).withValues(
          alpha: 0.08,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(value),
    );
  }
}

class _AccessDenied extends StatelessWidget {
  const _AccessDenied();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: AppText('med03.credit_note.access_denied'),
      ),
    );
  }
}
