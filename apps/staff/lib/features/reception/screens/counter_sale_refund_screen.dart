import 'dart:collection';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/navigation/staff_route_policy.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

typedef CounterSaleRefundRoleLoader = Future<String> Function();
typedef CounterSaleRefundStaffUidLoader = Future<String?> Function();
typedef CounterSaleRefundGetter = Future<Map<String, dynamic>> Function(
  int refundId,
);
typedef CounterSaleRefundApprover = Future<Map<String, dynamic>> Function(
  int refundId, {
  required String idempotencyKey,
});
typedef CounterSaleRefundManualPayer = Future<Map<String, dynamic>> Function({
  required int refundId,
  required String reference,
  String? cashDrawerSessionId,
  required String idempotencyKey,
});
typedef CounterSaleRefundOfflineElectronicPayer =
    Future<Map<String, dynamic>> Function({
      required int refundId,
      required String originalPaymentReference,
      required String providerName,
      required String providerRefundReference,
      required DateTime providerRefundedAt,
      required String idempotencyKey,
    });
typedef CounterSaleRefundCashDrawerLister =
    Future<List<Map<String, dynamic>>> Function({
      required String cashierUid,
      String status,
      int limit,
    });
typedef CounterSaleRefundGatewayCandidateLister =
    Future<List<Map<String, dynamic>>> Function(int refundId);
typedef CounterSaleRefundGatewayStarter =
    Future<Map<String, dynamic>> Function({
      required int refundId,
      required int gatewayOrderId,
      required String idempotencyKey,
    });

@visibleForTesting
const Set<String> counterSaleRefundRouteRoles = {
  'ADMIN',
  'SUPER_ADMIN',
  'FINANCE_INCHARGE',
  'BILLING_INCHARGE',
  'BILLING_STAFF',
  'CASHIER',
};

@visibleForTesting
const Set<String> counterSaleRefundApproverRoles = {'ADMIN', 'SUPER_ADMIN'};

bool counterSaleRefundCanOpen(String role) =>
    counterSaleRefundRouteRoles.contains(role.trim().toUpperCase());

bool counterSaleRefundCanApprove(String role) =>
    counterSaleRefundApproverRoles.contains(role.trim().toUpperCase());

bool counterSaleRefundCanPay(String role) =>
    counterSaleRefundRouteRoles.contains(role.trim().toUpperCase());

Map<String, dynamic>? _refundMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

String _refundCode(Object? value, {String fallback = 'unknown'}) {
  final normalized = value?.toString().trim().toLowerCase() ?? '';
  return normalized.isEmpty ? fallback : normalized;
}

@visibleForTesting
String localizedCounterSaleRefundWorkflow(AppStrings strings, Object? value) {
  const supported = {
    'awaiting_approval',
    'ready_for_payout',
    'paid',
    'rejected',
    'refund_rejected_review',
    'reconciliation_required',
    'counter_sale_void_completed',
  };
  final code = _refundCode(value);
  return strings.lookup(
    supported.contains(code)
        ? 'med03.counter_sale_refund.workflow.$code'
        : 'med03.counter_sale_refund.workflow.unknown',
  );
}

@visibleForTesting
String localizedCounterSaleVoidRequestStatus(
  AppStrings strings,
  Object? value,
) {
  return switch (_refundCode(value).toUpperCase()) {
    'CREATING' => strings.lookup(
      's4.lib.counter_sale.workflow_status.pending_review',
    ),
    'PENDING_REFUND' => strings.lookup(
      's4.lib.counter_sale.status.void_pending_refund',
    ),
    'REFUND_REJECTED_REVIEW' => strings.lookup(
      's4.lib.counter_sale.workflow_status.refund_rejected_review',
    ),
    'CANCELLED_HANDOVER_CONFIRMED' => strings.lookup(
      's4.lib.counter_sale.workflow_status.cancelled_handover_confirmed',
    ),
    'COMPLETED' => strings.lookup('s4.lib.counter_sale.workflow_status.voided'),
    _ => strings.lookup('s4.lib.counter_sale.workflow_status.unknown'),
  };
}

@visibleForTesting
String localizedCounterSaleRefundRail(AppStrings strings, Object? value) {
  final code = _refundCode(value);
  const supported = {'manual', 'offline_electronic', 'gateway'};
  return strings.lookup(
    supported.contains(code)
        ? 'med03.counter_sale_refund.rail.$code'
        : 'med03.counter_sale_refund.rail.unknown',
  );
}

@visibleForTesting
String localizedCounterSaleRefundMode(AppStrings strings, Object? value) {
  final code = _refundCode(value);
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
    supported.contains(code)
        ? 'med03.credit_note.refund_mode.$code'
        : 'med03.credit_note.refund_mode.unknown',
  );
}

dynamic _canonicalRefundValue(dynamic value) {
  if (value is Map) {
    final sorted = SplayTreeMap<String, dynamic>();
    for (final entry in value.entries) {
      sorted[entry.key.toString()] = _canonicalRefundValue(entry.value);
    }
    return sorted;
  }
  if (value is List) return value.map(_canonicalRefundValue).toList();
  return value;
}

String _refundFingerprint(Object? value) =>
    jsonEncode(_canonicalRefundValue(value));

class CounterSaleRefundScreen extends StatefulWidget {
  const CounterSaleRefundScreen({
    super.key,
    required this.refundId,
    this.voidRequestId = '',
    this.roleLoader,
    this.staffUidLoader,
    this.getRefund,
    this.approveRefund,
    this.payManualRefund,
    this.payOfflineElectronicRefund,
    this.listCashDrawerSessions,
    this.listGatewayCandidates,
    this.startGatewayRefund,
  });

  final String refundId;
  final String voidRequestId;
  final CounterSaleRefundRoleLoader? roleLoader;
  final CounterSaleRefundStaffUidLoader? staffUidLoader;
  final CounterSaleRefundGetter? getRefund;
  final CounterSaleRefundApprover? approveRefund;
  final CounterSaleRefundManualPayer? payManualRefund;
  final CounterSaleRefundOfflineElectronicPayer? payOfflineElectronicRefund;
  final CounterSaleRefundCashDrawerLister? listCashDrawerSessions;
  final CounterSaleRefundGatewayCandidateLister? listGatewayCandidates;
  final CounterSaleRefundGatewayStarter? startGatewayRefund;

  @override
  State<CounterSaleRefundScreen> createState() =>
      _CounterSaleRefundScreenState();
}

class _CounterSaleRefundScreenState extends State<CounterSaleRefundScreen> {
  final IdempotencyAttemptRegistry _attempts = IdempotencyAttemptRegistry();
  final Map<String, String> _attemptFingerprints = {};
  final Set<String> _ambiguousAttempts = {};
  final TextEditingController _manualReferenceController =
      TextEditingController();
  final TextEditingController _providerController = TextEditingController();
  final TextEditingController _providerRefundReferenceController =
      TextEditingController();
  final TextEditingController _providerRefundedAtController =
      TextEditingController();

  String _role = '';
  String? _staffUid;
  bool _loading = true;
  String? _actingScope;
  String? _error;
  String? _drawerError;
  Map<String, dynamic>? _detail;
  List<Map<String, dynamic>> _cashDrawers = const [];
  String? _selectedCashDrawerId;
  List<Map<String, dynamic>> _gatewayCandidates = const [];
  bool _gatewayCandidatesLoaded = false;

  int? get _refundId {
    final value = int.tryParse(widget.refundId.trim());
    return value != null && value > 0 ? value : null;
  }

  bool get _canOpen => counterSaleRefundCanOpen(_role);
  bool get _canApprove => counterSaleRefundCanApprove(_role);
  bool get _canPay => counterSaleRefundCanPay(_role);
  bool get _acting => _actingScope != null;

  Map<String, dynamic>? get _refund => _refundMap(_detail?['refund']);
  Map<String, dynamic>? get _voidRequest =>
      _refundMap(_detail?['void_request']);
  Map<String, dynamic>? get _originalPayment =>
      _refundMap(_detail?['original_payment']);
  Map<String, dynamic>? get _offlineEvidence =>
      _refundMap(_detail?['offline_electronic_evidence']);

  String get _approvalStatus =>
      _refundCode(_refund?['approval_status']).toUpperCase();
  String get _paymentMode => _refundCode(_refund?['mode']).toUpperCase();
  String get _payoutRail => _refundCode(_refund?['payout_rail'], fallback: '');

  Set<String> get _allowedPayoutRails {
    final raw = _detail?['allowed_payout_rails'];
    if (raw is! List) return const {};
    return raw
        .map(_refundCode)
        .where(const {'manual', 'offline_electronic', 'gateway'}.contains)
        .toSet();
  }

  bool get _sameApproverAndPayer {
    final approvedBy = _refund?['approved_by']?.toString().trim().toLowerCase();
    final uid = _staffUid?.trim().toLowerCase();
    return approvedBy != null &&
        approvedBy.isNotEmpty &&
        uid != null &&
        uid.isNotEmpty &&
        approvedBy == uid;
  }

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void dispose() {
    _attempts.clear();
    _manualReferenceController.dispose();
    _providerController.dispose();
    _providerRefundReferenceController.dispose();
    _providerRefundedAtController.dispose();
    super.dispose();
  }

  Future<void> _initialize() async {
    final roleLoader = widget.roleLoader ?? ApiConfig.getRole;
    final staffUidLoader = widget.staffUidLoader ?? ApiConfig.getStaffUid;
    final role = (await roleLoader()).trim().toUpperCase();
    final staffUid = await staffUidLoader();
    if (!mounted) return;
    setState(() {
      _role = role;
      _staffUid = staffUid;
    });
    if (!_canOpen) {
      setState(() => _loading = false);
      return;
    }
    await _refresh(showLoading: true);
  }

  bool _detailMatchesRoute(Map<String, dynamic> detail) {
    final refund = _refundMap(detail['refund']);
    final request = _refundMap(detail['void_request']);
    if (refund == null || refund['id']?.toString() != widget.refundId.trim()) {
      return false;
    }
    final voidRequestId = widget.voidRequestId.trim();
    if (voidRequestId.isEmpty) {
      return refund['counter_sale_void_request_id'] == null && request == null;
    }
    return request != null &&
        refund['counter_sale_void_request_id']?.toString() == voidRequestId &&
        request['id']?.toString() == voidRequestId &&
        request['refund_id']?.toString() == widget.refundId.trim();
  }

  Future<bool> _refresh({bool showLoading = false}) async {
    final refundId = _refundId;
    if (refundId == null) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = AppStrings.of(context)
              .lookup('med03.counter_sale_refund.invalid_target');
        });
      }
      return false;
    }
    if (showLoading && mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final getter = widget.getRefund ?? BillingApiService.getRefund;
      final detail = await getter(refundId);
      if (!_detailMatchesRoute(detail)) {
        throw const FormatException('counter_sale_refund_target_mismatch');
      }
      if (!mounted) return false;
      setState(() {
        _detail = detail;
        _loading = false;
        _error = null;
        if (_payoutRail != 'gateway') {
          _gatewayCandidates = const [];
          _gatewayCandidatesLoaded = false;
        }
      });
      final provider = _originalPayment?['provider_name']?.toString().trim();
      if (_providerController.text.trim().isEmpty &&
          provider != null &&
          provider.isNotEmpty) {
        _providerController.text = provider;
      }
      await _loadCashDrawersIfNeeded();
      return true;
    } on FormatException {
      if (!mounted) return false;
      setState(() {
        _loading = false;
        _error = AppStrings.of(context)
            .lookup('med03.counter_sale_refund.target_mismatch');
      });
      return false;
    } catch (_) {
      if (!mounted) return false;
      setState(() {
        _loading = false;
        _error = AppStrings.of(context)
            .lookup('med03.counter_sale_refund.load_failed');
      });
      return false;
    }
  }

  Future<void> _loadCashDrawersIfNeeded() async {
    if (!_allowedPayoutRails.contains('manual') ||
        _paymentMode != 'CASH' ||
        _approvalStatus != 'APPROVED' ||
        !_canPay ||
        _sameApproverAndPayer) {
      if (mounted) {
        setState(() {
          _cashDrawers = const [];
          _selectedCashDrawerId = null;
          _drawerError = null;
        });
      }
      return;
    }
    final uid = _staffUid?.trim() ?? '';
    if (uid.isEmpty) {
      if (mounted) {
        setState(() {
          _cashDrawers = const [];
          _selectedCashDrawerId = null;
          _drawerError = AppStrings.of(context)
              .lookup('med03.counter_sale_refund.drawer_identity_missing');
        });
      }
      return;
    }
    try {
      final lister =
          widget.listCashDrawerSessions ??
          BillingApiService.listCashDrawerSessions;
      final drawers = await lister(cashierUid: uid, status: 'open', limit: 100);
      if (!mounted) return;
      final valid = drawers.where((drawer) {
        final id = drawer['id']?.toString().trim() ?? '';
        return RegExp(r'^[1-9][0-9]*$').hasMatch(id) &&
            _refundCode(drawer['status']) == 'open';
      }).toList();
      setState(() {
        _cashDrawers = valid;
        if (!valid.any(
          (drawer) => drawer['id']?.toString() == _selectedCashDrawerId,
        )) {
          _selectedCashDrawerId = null;
        }
        _drawerError = valid.isEmpty
            ? AppStrings.of(context)
                  .lookup('med03.counter_sale_refund.no_open_drawer')
            : null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _cashDrawers = const [];
        _selectedCashDrawerId = null;
        _drawerError = AppStrings.of(context)
            .lookup('med03.counter_sale_refund.drawer_load_failed');
      });
    }
  }

  Future<bool> _confirmChangedAttempt() async {
    final strings = AppStrings.of(context);
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogContext) => AlertDialog(
            title: Text(
              strings.lookup('med03.counter_sale_refund.changed_attempt_title'),
            ),
            content: Text(
              strings.lookup('med03.counter_sale_refund.changed_attempt_body'),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(strings.actionCancel),
              ),
              FilledButton(
                key: const ValueKey('counter-sale-refund-new-attempt'),
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(
                  strings.lookup(
                    'med03.counter_sale_refund.changed_attempt_confirm',
                  ),
                ),
              ),
            ],
          ),
        ) ??
        false;
  }

  bool _isDefinitiveActionError(Object error) {
    final message = error.toString().toUpperCase();
    return const {
      'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
      'BILLING_REFUND_CASH_DRAWER_REQUIRED',
      'BILLING_REFUND_CASH_DRAWER_INVALID',
      'BILLING_REFUND_CASH_DRAWER_NOT_OPEN',
      'BILLING_REFUND_CASH_DRAWER_OWNER_MISMATCH',
      'BILLING_REFUND_CASH_DRAWER_INSUFFICIENT_FUNDS',
      'BILLING_REFUND_MANUAL_ELECTRONIC_FORBIDDEN',
      'BILLING_REFUND_OFFLINE_ELECTRONIC_MODE_MISMATCH',
      'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_REQUIRED',
      'BILLING_REFUND_PROVIDER_REQUIRED',
      'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_REQUIRED',
      'BILLING_REFUND_PROVIDER_REFUNDED_AT_REQUIRED',
      'BILLING_REFUND_PAYOUT_RAIL_CONFLICT',
      'BILLING_REFUND_NOT_FOUND',
      'FORBIDDEN',
      'UNAUTHORIZED',
    }.any(message.contains);
  }

  String _localizedActionError(AppStrings strings, Object error) {
    final message = error.toString().toUpperCase();
    if (message.contains('BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER')) {
      return strings.lookup('med03.counter_sale_refund.payer_must_differ');
    }
    if (message.contains('CASH_DRAWER')) {
      return strings.lookup('med03.counter_sale_refund.cash_drawer_error');
    }
    if (message.contains('ORIGINAL_PAYMENT_REFERENCE') ||
        message.contains('OFFLINE_ELECTRONIC_MODE') ||
        message.contains('MANUAL_ELECTRONIC')) {
      return strings.lookup(
        'med03.counter_sale_refund.electronic_evidence_error',
      );
    }
    if (message.contains('PROVIDER')) {
      return strings.lookup(
        'med03.counter_sale_refund.provider_evidence_error',
      );
    }
    if (message.contains('PAYOUT_RAIL_CONFLICT')) {
      return strings.lookup('med03.counter_sale_refund.rail_conflict');
    }
    return strings.lookup('med03.counter_sale_refund.action_failed');
  }

  Future<void> _runAction({
    required String scope,
    required Map<String, dynamic> payload,
    required Future<void> Function(String idempotencyKey) action,
    required bool Function(Map<String, dynamic> detail) isConfirmed,
  }) async {
    if (_acting || !OnlineOnlyActionGuard.require(context)) return;
    final strings = AppStrings.of(context);
    final fingerprint = _refundFingerprint(payload);
    final previousFingerprint = _attemptFingerprints[scope];
    if (_ambiguousAttempts.contains(scope) &&
        previousFingerprint != null &&
        previousFingerprint != fingerprint) {
      final confirmed = await _confirmChangedAttempt();
      if (!confirmed || !mounted) return;
      _attempts.complete(scope);
      _attemptFingerprints.remove(scope);
      _ambiguousAttempts.remove(scope);
    }
    final idempotencyKey = _attempts.keyFor(scope, payload);
    _attemptFingerprints[scope] = fingerprint;
    setState(() {
      _actingScope = scope;
      _error = null;
    });
    Object? actionError;
    try {
      await action(idempotencyKey);
    } catch (error) {
      actionError = error;
    }

    final refreshed = await _refresh();
    final detail = _detail;
    final confirmed = refreshed && detail != null && isConfirmed(detail);
    if (!mounted) return;
    if (confirmed) {
      _attempts.complete(scope);
      _attemptFingerprints.remove(scope);
      _ambiguousAttempts.remove(scope);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            strings.lookup('med03.counter_sale_refund.action_confirmed'),
          ),
        ),
      );
    } else if (actionError != null && _isDefinitiveActionError(actionError)) {
      _attempts.complete(scope);
      _attemptFingerprints.remove(scope);
      _ambiguousAttempts.remove(scope);
      setState(() => _error = _localizedActionError(strings, actionError!));
    } else {
      _ambiguousAttempts.add(scope);
      setState(
        () => _error = strings.lookup(
          'med03.counter_sale_refund.action_response_unconfirmed',
        ),
      );
    }
    setState(() => _actingScope = null);
  }

  Future<bool> _confirmAction(String bodyKey) async {
    final strings = AppStrings.of(context);
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(
              strings.lookup('med03.counter_sale_refund.confirm_title'),
            ),
            content: Text(strings.lookup(bodyKey)),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(strings.actionCancel),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(strings.actionConfirm),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _approve() async {
    final refundId = _refundId;
    if (refundId == null ||
        _approvalStatus != 'PENDING' ||
        !await _confirmAction('med03.counter_sale_refund.approve_confirm')) {
      return;
    }
    await _runAction(
      scope: 'counter-sale-refund:$refundId:approve',
      payload: {'refund_id': refundId},
      action: (idempotencyKey) async {
        final approver =
            widget.approveRefund ?? BillingApiService.approveRefund;
        await approver(refundId, idempotencyKey: idempotencyKey);
      },
      isConfirmed: (detail) {
        final status = _refundCode(
          _refundMap(detail['refund'])?['approval_status'],
        ).toUpperCase();
        return status != 'PENDING' && status != 'UNKNOWN';
      },
    );
  }

  Future<void> _payManual() async {
    final refundId = _refundId;
    final reference = _manualReferenceController.text.trim();
    final drawerId = _paymentMode == 'CASH' ? _selectedCashDrawerId : null;
    if (refundId == null ||
        reference.isEmpty ||
        (_paymentMode == 'CASH' && drawerId == null) ||
        !await _confirmAction('med03.counter_sale_refund.manual_confirm')) {
      return;
    }
    final payload = <String, dynamic>{
      'refund_id': refundId,
      'reference': reference,
    };
    if (drawerId != null) payload['cash_drawer_session_id'] = drawerId;
    await _runAction(
      scope: 'counter-sale-refund:$refundId:manual',
      payload: payload,
      action: (idempotencyKey) async {
        final payer =
            widget.payManualRefund ?? BillingApiService.markRefundPaid;
        await payer(
          refundId: refundId,
          reference: reference,
          cashDrawerSessionId: drawerId,
          idempotencyKey: idempotencyKey,
        );
      },
      isConfirmed: (detail) {
        final refund = _refundMap(detail['refund']);
        return _refundCode(refund?['approval_status']) == 'paid' &&
            _refundCode(refund?['payout_rail']) == 'manual';
      },
    );
  }

  Future<void> _payOfflineElectronic() async {
    final refundId = _refundId;
    final originalReference = _originalPayment?['reference']?.toString().trim();
    final provider = _providerController.text.trim();
    final providerReference = _providerRefundReferenceController.text.trim();
    final providerRefundedAt = DateTime.tryParse(
      _providerRefundedAtController.text.trim(),
    );
    if (refundId == null ||
        originalReference == null ||
        originalReference.isEmpty ||
        provider.isEmpty ||
        providerReference.isEmpty ||
        providerRefundedAt == null ||
        !await _confirmAction(
          'med03.counter_sale_refund.offline_electronic_confirm',
        )) {
      return;
    }
    final payload = <String, dynamic>{
      'refund_id': refundId,
      'original_payment_reference': originalReference,
      'provider_name': provider,
      'provider_refund_reference': providerReference,
      'provider_refunded_at': providerRefundedAt.toUtc().toIso8601String(),
    };
    await _runAction(
      scope: 'counter-sale-refund:$refundId:offline-electronic',
      payload: payload,
      action: (idempotencyKey) async {
        final payer =
            widget.payOfflineElectronicRefund ??
            BillingApiService.markOfflineElectronicRefundPaid;
        await payer(
          refundId: refundId,
          originalPaymentReference: originalReference,
          providerName: provider,
          providerRefundReference: providerReference,
          providerRefundedAt: providerRefundedAt,
          idempotencyKey: idempotencyKey,
        );
      },
      isConfirmed: (detail) {
        final refund = _refundMap(detail['refund']);
        return _refundCode(refund?['approval_status']) == 'paid' &&
            _refundCode(refund?['payout_rail']) == 'offline_electronic' &&
            _refundMap(detail['offline_electronic_evidence']) != null;
      },
    );
  }

  Future<void> _loadGatewayCandidates() async {
    final refundId = _refundId;
    if (refundId == null ||
        _acting ||
        !OnlineOnlyActionGuard.require(context)) {
      return;
    }
    setState(() {
      _actingScope = 'gateway-candidates';
      _error = null;
    });
    try {
      final lister =
          widget.listGatewayCandidates ??
          BillingApiService.listGatewayRefundCandidates;
      final candidates = await lister(refundId);
      if (!mounted) return;
      setState(() {
        _gatewayCandidates = candidates.where((candidate) {
          final id = int.tryParse(
            candidate['gateway_order_id']?.toString() ?? '',
          );
          return id != null && id > 0;
        }).toList();
        _gatewayCandidatesLoaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(
        () =>
            _error = AppStrings.of(context)
                .lookup('med03.counter_sale_refund.gateway_candidates_failed'),
      );
    } finally {
      if (mounted) setState(() => _actingScope = null);
    }
  }

  Future<void> _startGateway(Map<String, dynamic> candidate) async {
    final refundId = _refundId;
    final gatewayOrderId = int.tryParse(
      candidate['gateway_order_id']?.toString() ?? '',
    );
    if (refundId == null ||
        gatewayOrderId == null ||
        gatewayOrderId < 1 ||
        !await _confirmAction('med03.counter_sale_refund.gateway_confirm')) {
      return;
    }
    final payload = {
      'billing_refund_id': refundId,
      'gateway_order_id': gatewayOrderId,
    };
    await _runAction(
      scope: 'counter-sale-refund:$refundId:gateway',
      payload: payload,
      action: (idempotencyKey) async {
        final starter =
            widget.startGatewayRefund ??
            BillingApiService.initiateGatewayRefund;
        await starter(
          refundId: refundId,
          gatewayOrderId: gatewayOrderId,
          idempotencyKey: idempotencyKey,
        );
      },
      isConfirmed: (detail) {
        final refund = _refundMap(detail['refund']);
        return _refundCode(refund?['approval_status']) == 'paid' ||
            (_refundCode(refund?['payout_rail']) == 'gateway' &&
                refund?['gateway_refund_id'] != null);
      },
    );
  }

  String? get _pharmacyRoute {
    final saleId = _voidRequest?['counter_sale_id']?.toString().trim();
    if (saleId == null || !RegExp(r'^[1-9][0-9]*$').hasMatch(saleId)) {
      return null;
    }
    return StaffRoutePolicy.sanitizeExternalRoute(
      '/pharmacy?tab=counter-sales&sale_id=$saleId',
    );
  }

  String _refundStatusLabel(AppStrings strings) {
    const supported = {'pending', 'approved', 'paid', 'rejected'};
    final status = _approvalStatus.toLowerCase();
    return strings.lookup(
      supported.contains(status)
          ? 's4.lib.counter_sale.refund_status.$status'
          : 's4.lib.counter_sale.refund_status.unknown',
    );
  }

  String _dispositionLabel(AppStrings strings) {
    final disposition = _refundCode(_voidRequest?['disposition']).toUpperCase();
    return switch (disposition) {
      'NEVER_HANDED_OVER' => strings.lookup(
        's4.lib.counter_sale.disposition.never_handed_over',
      ),
      'PATIENT_RETURNED' => strings.lookup(
        's4.lib.counter_sale.disposition.patient_returned',
      ),
      _ => strings.lookup('med03.counter_sale_refund.value_unknown'),
    };
  }

  String _money(Object? value) {
    final amount = value is num
        ? value.toDouble()
        : double.tryParse(value?.toString() ?? '') ?? 0;
    return '₹${amount.toStringAsFixed(2)}';
  }

  Widget _dataRow(String label, String value, {Key? key}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 190,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          Expanded(child: Text(value, key: key)),
        ],
      ),
    );
  }

  Widget _notice(AppStrings strings, String text, {bool error = false}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: (error ? Colors.red : AppTheme.warningAmber).withValues(
          alpha: 0.12,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(text),
    );
  }

  Widget _buildSummary(AppStrings strings) {
    final refund = _refund!;
    final request = _voidRequest;
    final originalReference = _originalPayment?['reference']?.toString().trim();
    final evidence = _offlineEvidence;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              strings.lookup('med03.counter_sale_refund.summary'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _dataRow(
              strings.lookup('med03.counter_sale_refund.refund_id'),
              refund['id'].toString(),
            ),
            if (request != null) ...[
              _dataRow(
                strings.lookup('med03.counter_sale_refund.void_request_id'),
                request['id'].toString(),
              ),
              _dataRow(
                strings.lookup('med03.counter_sale_refund.sale_id'),
                request['counter_sale_id']?.toString() ??
                    strings.lookup('med03.counter_sale_refund.value_unknown'),
              ),
            ],
            _dataRow(
              strings.lookup('med03.counter_sale_refund.amount'),
              _money(refund['amount']),
            ),
            _dataRow(
              strings.lookup('med03.counter_sale_refund.payment_mode'),
              localizedCounterSaleRefundMode(strings, refund['mode']),
            ),
            _dataRow(
              strings.lookup('med03.counter_sale_refund.approval_status'),
              _refundStatusLabel(strings),
              key: const ValueKey('counter-sale-refund-approval-status'),
            ),
            _dataRow(
              strings.lookup('med03.counter_sale_refund.workflow_status'),
              localizedCounterSaleRefundWorkflow(
                strings,
                _detail?['workflow_status'],
              ),
              key: const ValueKey('counter-sale-refund-workflow-status'),
            ),
            if (request != null) ...[
              _dataRow(
                strings.lookup('med03.counter_sale_refund.disposition'),
                _dispositionLabel(strings),
              ),
              _dataRow(
                strings.lookup(
                  'med03.counter_sale_refund.reconciliation_status',
                ),
                localizedCounterSaleVoidRequestStatus(
                  strings,
                  request['status'],
                ),
              ),
            ],
            if (originalReference != null && originalReference.isNotEmpty)
              _dataRow(
                strings.lookup(
                  'med03.counter_sale_refund.original_payment_reference',
                ),
                originalReference,
              ),
            if (_payoutRail.isNotEmpty)
              _dataRow(
                strings.lookup('med03.counter_sale_refund.payout_rail'),
                localizedCounterSaleRefundRail(strings, _payoutRail),
              ),
            if (evidence != null) ...[
              _dataRow(
                strings.lookup('med03.counter_sale_refund.provider'),
                evidence['provider_name']?.toString() ?? '—',
              ),
              _dataRow(
                strings.lookup(
                  'med03.counter_sale_refund.provider_refund_reference',
                ),
                evidence['provider_refund_reference']?.toString() ?? '—',
              ),
            ],
            if (_pharmacyRoute != null) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                key: const ValueKey('counter-sale-refund-open-pharmacy'),
                onPressed: () => context.push(_pharmacyRoute!),
                icon: const Icon(Icons.inventory_2_outlined),
                label: Text(
                  strings.lookup(
                    'med03.counter_sale_refund.open_reconciliation',
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildApproval(AppStrings strings) {
    if (_approvalStatus != 'PENDING') return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              strings.lookup('med03.counter_sale_refund.approval_title'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              strings.lookup(
                _canApprove
                    ? 'med03.counter_sale_refund.approval_ready'
                    : 'med03.counter_sale_refund.approval_waiting',
              ),
            ),
            if (_canApprove) ...[
              const SizedBox(height: 12),
              OnlineOnlyActionState(
                builder: (context, isOnline, _) => FilledButton.icon(
                  key: const ValueKey('counter-sale-refund-approve'),
                  onPressed: !isOnline || _acting ? null : _approve,
                  icon: _actingScope?.endsWith(':approve') == true
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.verified_outlined),
                  label: Text(
                    strings.lookup('med03.counter_sale_refund.approve_action'),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildManualRail(AppStrings strings) {
    final isCash = _paymentMode == 'CASH';
    final ready =
        _manualReferenceController.text.trim().isNotEmpty &&
        (!isCash || _selectedCashDrawerId != null);
    return Card(
      key: const ValueKey('counter-sale-refund-manual-rail'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              localizedCounterSaleRefundRail(strings, 'manual'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (isCash) ...[
              DropdownButtonFormField<String>(
                key: const ValueKey('counter-sale-refund-cash-drawer'),
                initialValue: _selectedCashDrawerId,
                decoration: InputDecoration(
                  labelText: strings.lookup(
                    'med03.counter_sale_refund.cash_drawer',
                  ),
                ),
                items: _cashDrawers
                    .map(
                      (drawer) => DropdownMenuItem(
                        value: drawer['id'].toString(),
                        child: Text(
                          strings.format(
                            'med03.counter_sale_refund.cash_drawer_option',
                            {
                              'id': drawer['id'],
                              'shift': drawer['shift'] ?? '—',
                            },
                          ),
                        ),
                      ),
                    )
                    .toList(),
                onChanged: _acting
                    ? null
                    : (value) => setState(() => _selectedCashDrawerId = value),
              ),
              if (_drawerError != null) ...[
                const SizedBox(height: 8),
                _notice(strings, _drawerError!, error: true),
              ],
              const SizedBox(height: 8),
            ],
            TextField(
              key: const ValueKey('counter-sale-refund-manual-reference'),
              controller: _manualReferenceController,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: strings.lookup(
                  isCash
                      ? 'med03.counter_sale_refund.cash_voucher'
                      : 'med03.counter_sale_refund.manual_reference',
                ),
              ),
            ),
            const SizedBox(height: 12),
            OnlineOnlyActionState(
              builder: (context, isOnline, _) => FilledButton.icon(
                key: const ValueKey('counter-sale-refund-pay-manual'),
                onPressed: !isOnline || _acting || !ready ? null : _payManual,
                icon: const Icon(Icons.payments_outlined),
                label: Text(
                  strings.lookup('med03.counter_sale_refund.record_payout'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildOfflineElectronicRail(AppStrings strings) {
    final originalReference = _originalPayment?['reference']?.toString().trim();
    final ready =
        originalReference != null &&
        originalReference.isNotEmpty &&
        _providerController.text.trim().isNotEmpty &&
        _providerRefundReferenceController.text.trim().isNotEmpty &&
        DateTime.tryParse(_providerRefundedAtController.text.trim()) != null;
    return Card(
      key: const ValueKey('counter-sale-refund-offline-electronic-rail'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              localizedCounterSaleRefundRail(strings, 'offline_electronic'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (originalReference == null || originalReference.isEmpty)
              _notice(
                strings,
                strings.lookup(
                  'med03.counter_sale_refund.original_reference_missing',
                ),
                error: true,
              )
            else
              TextFormField(
                key: const ValueKey(
                  'counter-sale-refund-original-payment-reference',
                ),
                initialValue: originalReference,
                readOnly: true,
                decoration: InputDecoration(
                  labelText: strings.lookup(
                    'med03.counter_sale_refund.original_payment_reference',
                  ),
                ),
              ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('counter-sale-refund-provider'),
              controller: _providerController,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: strings.lookup('med03.counter_sale_refund.provider'),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('counter-sale-refund-provider-reference'),
              controller: _providerRefundReferenceController,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: strings.lookup(
                  'med03.counter_sale_refund.provider_refund_reference',
                ),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('counter-sale-refund-provider-refunded-at'),
              controller: _providerRefundedAtController,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: strings.lookup(
                  'med03.counter_sale_refund.provider_refunded_at',
                ),
                helperText: strings.lookup(
                  'med03.counter_sale_refund.timestamp_hint',
                ),
              ),
            ),
            const SizedBox(height: 12),
            OnlineOnlyActionState(
              builder: (context, isOnline, _) => FilledButton.icon(
                key: const ValueKey(
                  'counter-sale-refund-pay-offline-electronic',
                ),
                onPressed: !isOnline || _acting || !ready
                    ? null
                    : _payOfflineElectronic,
                icon: const Icon(Icons.receipt_long_outlined),
                label: Text(
                  strings.lookup(
                    'med03.counter_sale_refund.record_offline_electronic',
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGatewayRail(AppStrings strings) {
    return Card(
      key: const ValueKey('counter-sale-refund-gateway-rail'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              localizedCounterSaleRefundRail(strings, 'gateway'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (!_gatewayCandidatesLoaded)
              OnlineOnlyActionState(
                builder: (context, isOnline, _) => OutlinedButton.icon(
                  key: const ValueKey(
                    'counter-sale-refund-load-gateway-candidates',
                  ),
                  onPressed: !isOnline || _acting
                      ? null
                      : _loadGatewayCandidates,
                  icon: const Icon(Icons.sync),
                  label: Text(
                    strings.lookup(
                      'med03.counter_sale_refund.load_gateway_candidates',
                    ),
                  ),
                ),
              )
            else if (_gatewayCandidates.isEmpty)
              _notice(
                strings,
                strings.lookup(
                  'med03.counter_sale_refund.no_gateway_candidates',
                ),
                error: true,
              )
            else
              ..._gatewayCandidates.map(
                (candidate) => ListTile(
                  key: ValueKey(
                    'counter-sale-refund-gateway-${candidate['gateway_order_id']}',
                  ),
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    strings.format(
                      'med03.counter_sale_refund.gateway_candidate',
                      {'id': candidate['gateway_order_id']},
                    ),
                  ),
                  subtitle: Text(
                    candidate['provider']?.toString() ??
                        candidate['payment_mode']?.toString() ??
                        '',
                  ),
                  trailing: OnlineOnlyActionState(
                    builder: (context, isOnline, _) => FilledButton(
                      onPressed: !isOnline || _acting
                          ? null
                          : () => _startGateway(candidate),
                      child: Text(
                        strings.lookup(
                          'med03.counter_sale_refund.start_gateway_refund',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildPayout(AppStrings strings) {
    if (_approvalStatus != 'APPROVED') return const SizedBox.shrink();
    if (_sameApproverAndPayer) {
      return _notice(
        strings,
        strings.lookup('med03.counter_sale_refund.payer_must_differ'),
        error: true,
      );
    }
    if (!_canPay) {
      return _notice(
        strings,
        strings.lookup('med03.counter_sale_refund.payout_not_authorized'),
        error: true,
      );
    }
    if (_payoutRail.isNotEmpty) {
      return _notice(
        strings,
        strings.format('med03.counter_sale_refund.payout_in_progress', {
          'rail': localizedCounterSaleRefundRail(strings, _payoutRail),
        }),
      );
    }
    final rails = _allowedPayoutRails;
    if (rails.isEmpty) {
      return _notice(
        strings,
        strings.lookup('med03.counter_sale_refund.no_authoritative_rail'),
        error: true,
      );
    }
    return Column(
      children: [
        if (rails.contains('manual')) _buildManualRail(strings),
        if (rails.contains('offline_electronic'))
          _buildOfflineElectronicRail(strings),
        if (rails.contains('gateway')) _buildGatewayRail(strings),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup(
        _voidRequest == null
            ? 'med03.credit_note.refund'
            : 'med03.counter_sale_refund.title',
      ),
      actions: [
        IconButton(
          key: const ValueKey('counter-sale-refund-refresh'),
          tooltip: strings.lookup('action.refresh'),
          onPressed: _loading || _acting
              ? null
              : () => _refresh(showLoading: true),
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: !_canOpen && !_loading
          ? Center(
              child: Text(
                strings.lookup('med03.counter_sale_refund.access_denied'),
              ),
            )
          : _loading && _detail == null
          ? const Center(child: CircularProgressIndicator())
          : _detail == null
          ? ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (_error != null) _notice(strings, _error!, error: true),
              ],
            )
          : RefreshIndicator(
              onRefresh: () => _refresh(),
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) ...[
                    _notice(strings, _error!, error: true),
                    const SizedBox(height: 12),
                  ],
                  if (_ambiguousAttempts.isNotEmpty) ...[
                    _notice(
                      strings,
                      strings.lookup(
                        'med03.counter_sale_refund.retry_same_attempt',
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  _buildSummary(strings),
                  _buildApproval(strings),
                  _buildPayout(strings),
                  const SizedBox(height: 24),
                ],
              ),
            ),
    );
  }
}
