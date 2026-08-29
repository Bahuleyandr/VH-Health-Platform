import '../../../l10n/app_strings.dart';

class PharmacyFundingRecovery {
  const PharmacyFundingRecovery({
    required this.taskId,
    required this.status,
    required this.ownerRole,
    this.deepLink,
  });

  final String taskId;
  final String status;
  final String ownerRole;
  final Uri? deepLink;

  static PharmacyFundingRecovery? from(Object? raw) {
    if (raw is! Map) return null;
    final taskId = raw['task_id']?.toString().trim() ?? '';
    final status = raw['status']?.toString().trim().toLowerCase() ?? '';
    final ownerRole = raw['owner_role']?.toString().trim().toUpperCase() ?? '';
    if (taskId.isEmpty || status.isEmpty || ownerRole.isEmpty) {
      return null;
    }
    final uri = _validatedDeepLink(raw['deep_link']);
    return PharmacyFundingRecovery(
      taskId: taskId,
      status: status,
      ownerRole: ownerRole,
      deepLink: uri,
    );
  }

  static PharmacyFundingRecovery? fromMaterialization(Object? raw) {
    if (raw is! Map) return null;
    return from(raw['fundingRecovery'] ?? raw['funding_recovery']);
  }

  bool get blocksStockIssue => status != 'completed' && status != 'resolved';

  static Uri? _validatedDeepLink(Object? raw) {
    final value = raw?.toString().trim() ?? '';
    if (value.isEmpty) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme.isNotEmpty ||
        uri.hasAuthority ||
        uri.path != '/billing-desk') {
      return null;
    }
    final reconciliationLink =
        uri.queryParametersAll.length == 1 &&
        uri.queryParameters.containsKey('funding_reconciliation_case_id') &&
        _positiveQueryId(uri, 'funding_reconciliation_case_id');
    final exactFundingLink =
        (uri.queryParametersAll.length == 2 ||
            uri.queryParametersAll.length == 3) &&
        uri.queryParametersAll.values.every((values) => values.length == 1) &&
        _positiveQueryId(uri, 'pharmacy_order_id') &&
        _positiveQueryId(uri, 'invoice_item_id') &&
        (!uri.queryParameters.containsKey('tpa_claim_id') ||
            _positiveQueryId(uri, 'tpa_claim_id'));
    if (!reconciliationLink && !exactFundingLink) return null;
    return uri;
  }

  static bool _positiveQueryId(Uri uri, String key) {
    final value = int.tryParse(uri.queryParameters[key] ?? '');
    return value != null && value > 0;
  }

  String summary(AppStrings strings) =>
      strings.format('med03.pharmacy.funding_recovery.task_summary', {
        'taskId': taskId,
        'status': _statusLabel(strings),
        'owner': _ownerLabel(strings),
      });

  String _statusLabel(AppStrings strings) {
    final key = switch (status) {
      'pending' || 'open' => 'pending',
      'in_progress' || 'claimed' => 'in_progress',
      'blocked' || 'failed' || 'cancelled' => 'blocked',
      'completed' || 'resolved' => 'completed',
      _ => 'unknown',
    };
    return strings.lookup('med03.pharmacy.funding_recovery.status.$key');
  }

  String _ownerLabel(AppStrings strings) {
    final key = switch (ownerRole) {
      'FINANCE_INCHARGE' => 'finance',
      'INSURANCE_COORDINATOR' || 'CLAIMS_MANAGER' => 'insurance',
      'BILLING_STAFF' || 'BILLING_INCHARGE' => 'billing',
      _ => 'unknown',
    };
    return strings.lookup('med03.pharmacy.funding_recovery.owner.$key');
  }
}
