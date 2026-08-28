import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

typedef GatewayRefundReconciliationRoleLoader = Future<String> Function();
typedef GatewayRefundReconciliationLister =
    Future<List<Map<String, dynamic>>> Function();
typedef GatewayRefundReconciliationResolver =
    Future<Map<String, dynamic>> Function({
      required int gatewayRefundId,
      required String disposition,
      required String evidenceReference,
      required String note,
    });

@visibleForTesting
const Set<String> gatewayRefundReconciliationRoles = {'ADMIN', 'SUPER_ADMIN'};

bool gatewayRefundReconciliationCanOpen(String role) =>
    gatewayRefundReconciliationRoles.contains(role.trim().toUpperCase());

@visibleForTesting
String? gatewayRefundAuthorityRoute(Object? refundId) {
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
String localizedGatewayRefundReconciliationDisposition(
  AppStrings strings,
  Object? value,
) {
  final code = value?.toString().trim().toLowerCase() ?? '';
  const supported = {'provider_not_refunded', 'manual_settled'};
  return strings.lookup(
    'med03.gateway_refund_reconciliation.disposition.'
    '${supported.contains(code) ? code : 'unknown'}',
  );
}

class GatewayRefundReconciliationScreen extends StatefulWidget {
  GatewayRefundReconciliationScreen({
    super.key,
    this.initialRefundId,
    GatewayRefundReconciliationRoleLoader? roleLoader,
    GatewayRefundReconciliationLister? listRefunds,
    GatewayRefundReconciliationResolver? resolveRefund,
  }) : roleLoader = roleLoader ?? ApiConfig.getRole,
       listRefunds =
           listRefunds ??
           (() => BillingApiService.listGatewayRefundReconciliations()),
       resolveRefund =
           resolveRefund ??
           (({
             required gatewayRefundId,
             required disposition,
             required evidenceReference,
             required note,
           }) => BillingApiService.reconcileGatewayRefund(
             gatewayRefundId: gatewayRefundId,
             disposition: disposition,
             evidenceReference: evidenceReference,
             note: note,
           ));

  final String? initialRefundId;
  final GatewayRefundReconciliationRoleLoader roleLoader;
  final GatewayRefundReconciliationLister listRefunds;
  final GatewayRefundReconciliationResolver resolveRefund;

  @override
  State<GatewayRefundReconciliationScreen> createState() =>
      _GatewayRefundReconciliationScreenState();
}

class _GatewayRefundReconciliationScreenState
    extends State<GatewayRefundReconciliationScreen> {
  final TextEditingController _evidenceController = TextEditingController();
  final TextEditingController _noteController = TextEditingController();

  bool _allowed = false;
  bool _loading = true;
  bool _acting = false;
  String? _error;
  String _disposition = 'provider_not_refunded';
  List<Map<String, dynamic>> _rows = const [];
  Map<String, dynamic>? _selected;

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  @override
  void dispose() {
    _evidenceController.dispose();
    _noteController.dispose();
    super.dispose();
  }

  Future<void> _initialize() async {
    final role = (await widget.roleLoader()).trim().toUpperCase();
    if (!mounted) return;
    _allowed = gatewayRefundReconciliationCanOpen(role);
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
      _error = null;
    });
    try {
      final rows = await widget.listRefunds();
      final targetId =
          _selected?['id']?.toString() ?? widget.initialRefundId?.trim();
      Map<String, dynamic>? selected;
      if (targetId != null && targetId.isNotEmpty) {
        for (final row in rows) {
          if (row['id']?.toString() == targetId) {
            selected = row;
            break;
          }
        }
      }
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _selected = selected;
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

  void _select(Map<String, dynamic> row) {
    setState(() {
      _selected = row;
      _disposition = 'provider_not_refunded';
      _evidenceController.clear();
      _noteController.clear();
    });
  }

  Future<void> _reconcile() async {
    final row = _selected;
    final id = int.tryParse(row?['id']?.toString() ?? '');
    if (id == null || id < 1 || id > 2147483647 || _acting) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final evidence = _evidenceController.text.trim();
    final note = _noteController.text.trim();
    if (evidence.length < 6 ||
        evidence.length > 120 ||
        note.length < 10 ||
        note.length > 500) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context)
                .lookup('med03.gateway_refund_reconciliation.validation'),
          ),
        ),
      );
      return;
    }
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const AppText(
              'med03.gateway_refund_reconciliation.confirm_title',
            ),
            content: AppText(
              'med03.gateway_refund_reconciliation.confirm_body',
              values: {
                'disposition': localizedGatewayRefundReconciliationDisposition(
                  AppStrings.of(context),
                  _disposition,
                ),
              },
            ),
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
    if (!confirmed || !mounted) return;

    setState(() => _acting = true);
    try {
      await widget.resolveRefund(
        gatewayRefundId: id,
        disposition: _disposition,
        evidenceReference: evidence,
        note: note,
      );
      if (!mounted) return;
      _evidenceController.clear();
      _noteController.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('med03.gateway_refund_reconciliation.success'),
        ),
      );
      setState(() => _selected = null);
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), error),
      );
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup('med03.gateway_refund_reconciliation.title'),
      actions: [
        IconButton(
          tooltip: strings.actionRefresh,
          onPressed: _loading || !_allowed ? null : () => unawaited(_load()),
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: !_allowed && !_loading
          ? const Center(
              child: AppText(
                'med03.gateway_refund_reconciliation.access_denied',
              ),
            )
          : _loading && _rows.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 920;
                  return ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (_error != null) ...[
                        _Notice(message: _error!, error: true),
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
          Text(
            strings.lookup('med03.gateway_refund_reconciliation.queue'),
            style: Theme.of(context).textTheme.titleMedium
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          if (_rows.isEmpty)
            const AppText('med03.gateway_refund_reconciliation.empty')
          else
            ..._rows.map(
              (row) => ListTile(
                selected: row['id']?.toString() == _selected?['id']?.toString(),
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.sync_problem_outlined),
                title: Text(
                  '${row['provider'] ?? ''} · #${row['id'] ?? ''}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                subtitle: Text(
                  '${strings.lookup('med03.gateway_refund_reconciliation.amount')}: '
                  '${row['currency'] ?? 'INR'} ${row['amount'] ?? ''}',
                ),
                onTap: _acting ? null : () => _select(row),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildDetail() {
    final row = _selected;
    if (row == null) {
      return const _Panel(
        child: AppText('med03.gateway_refund_reconciliation.select'),
      );
    }
    final strings = AppStrings.of(context);
    final authorityRoute = gatewayRefundAuthorityRoute(
      row['billing_refund_id'],
    );
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${strings.lookup('med03.gateway_refund_reconciliation.refund')} #${row['id']}',
            style: Theme.of(context).textTheme.titleLarge
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 20,
            runSpacing: 10,
            children: [
              _Fact(
                label: strings.lookup(
                  'med03.gateway_refund_reconciliation.billing_refund',
                ),
                value: row['billing_refund_id']?.toString() ?? '—',
              ),
              _Fact(
                label: strings.lookup(
                  'med03.gateway_refund_reconciliation.provider_payment',
                ),
                value: row['provider_payment_id']?.toString() ?? '—',
              ),
              _Fact(
                label: strings.lookup(
                  'med03.gateway_refund_reconciliation.provider_refund',
                ),
                value: row['provider_refund_id']?.toString() ?? '—',
              ),
              _Fact(
                label: strings.lookup(
                  'med03.gateway_refund_reconciliation.failure',
                ),
                value:
                    row['failure_reason']?.toString() ??
                    row['failure_code']?.toString() ??
                    '—',
              ),
            ],
          ),
          if (authorityRoute != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => context.push(authorityRoute),
              icon: const Icon(Icons.receipt_long_outlined),
              label: const AppText(
                'med03.gateway_refund_reconciliation.open_authority',
              ),
            ),
          ],
          const Divider(height: 32),
          DropdownButtonFormField<String>(
            initialValue: _disposition,
            decoration: InputDecoration(
              labelText: strings.lookup(
                'med03.gateway_refund_reconciliation.disposition',
              ),
            ),
            items: const ['provider_not_refunded', 'manual_settled']
                .map(
                  (value) => DropdownMenuItem(
                    value: value,
                    child: Text(
                      localizedGatewayRefundReconciliationDisposition(
                        strings,
                        value,
                      ),
                    ),
                  ),
                )
                .toList(growable: false),
            onChanged: _acting
                ? null
                : (value) => setState(
                    () => _disposition = value ?? 'provider_not_refunded',
                  ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _evidenceController,
            enabled: !_acting,
            maxLength: 120,
            decoration: InputDecoration(
              labelText: strings.lookup(
                'med03.gateway_refund_reconciliation.evidence',
              ),
              helperText: strings.lookup(
                _disposition == 'manual_settled'
                    ? 'med03.gateway_refund_reconciliation.evidence_settled_help'
                    : 'med03.gateway_refund_reconciliation.evidence_not_refunded_help',
              ),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _noteController,
            enabled: !_acting,
            minLines: 2,
            maxLines: 5,
            maxLength: 500,
            decoration: InputDecoration(
              labelText: strings.lookup(
                'med03.gateway_refund_reconciliation.note',
              ),
            ),
          ),
          if (_disposition == 'provider_not_refunded') ...[
            const SizedBox(height: 8),
            const _Notice(
              messageKey:
                  'med03.gateway_refund_reconciliation.gateway_retry_notice',
            ),
          ],
          const SizedBox(height: 16),
          OnlineOnlyActionState(
            builder: (context, isOnline, offlineMessage) => FilledButton.icon(
              onPressed: _acting || !isOnline
                  ? null
                  : () => unawaited(_reconcile()),
              icon: _acting
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.verified_outlined),
              label: Text(
                isOnline
                    ? strings.lookup(
                        'med03.gateway_refund_reconciliation.submit',
                      )
                    : offlineMessage,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    borderRadius: BorderRadius.circular(12),
    child: Padding(padding: const EdgeInsets.all(16), child: child),
  );
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minWidth: 180, maxWidth: 360),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 2),
        SelectableText(value),
      ],
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice({this.message, this.messageKey, this.error = false})
    : assert(message != null || messageKey != null);

  final String? message;
  final String? messageKey;
  final bool error;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: (error ? AppTheme.errorRed : AppTheme.warningAmber).withValues(
        alpha: 0.10,
      ),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(message ?? AppStrings.of(context).lookup(messageKey!)),
  );
}
