// lib/features/ipd/drug_chart_offline_order.dart
//
// Pure decision for the OFFLINE drug-chart medication-order path. Keeps the
// screen thin and the safety branch unit-testable.
//
// INVARIANT: a device that cannot place clinical orders (phone-mode or an
// empty/unknown deviceType) NEVER enqueues — queuing there would only 403 on
// drain (rejectMobileClinicalWrite). This mirrors the backend device gate.

import '../../core/services/order_payloads.dart';

class OfflineOrderIntent {
  const OfflineOrderIntent({
    required this.block,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.reason,
  });

  /// Device cannot place clinical orders → abort, do NOT enqueue.
  final bool block;

  /// Safe to queue the order create.
  final bool enqueue;

  final String endpoint;
  final Map<String, dynamic> body;

  /// AppStrings key for the block reason (null when [enqueue] is true).
  final String? reason;
}

/// Decide whether a drug-chart medication order can be queued offline and build
/// the byte-identical POST /emr/orders body. [deviceType] is the staff app's
/// current posture (`currentDeviceType`): clinical order writes are
/// desktop/tablet-only, so 'mobile' or an empty/unknown value is blocked.
OfflineOrderIntent buildOfflineOrderIntent({
  required String deviceType,
  required String patientUid,
  String? encounterId,
  required String medicationName,
  required String dose,
  required String route,
  required String frequency,
  List<String>? doseTimes,
  String? foodTiming,
  String? instructions,
  int? catalogId,
  int? originalCatalogId,
  int? compositionId,
  String? compositionLabel,
  String? compositionConfidence,
  String? genericName,
  String? strength,
  String? strengthKey,
  String? form,
  String? formKey,
  String? releaseKey,
  bool doNotSubstitute = false,
  String priority = 'routine',
  required DateTime startDate,
}) {
  final dt = deviceType.trim().toLowerCase();
  final block = dt == 'mobile' || dt.isEmpty;
  return OfflineOrderIntent(
    block: block,
    enqueue: !block,
    endpoint: '/emr/orders',
    body: buildInpatientMedicationOrderBody(
      patientUid: patientUid,
      encounterId: encounterId,
      medicationName: medicationName,
      dose: dose,
      route: route,
      frequency: frequency,
      doseTimes: doseTimes,
      foodTiming: foodTiming,
      instructions: instructions,
      catalogId: catalogId,
      originalCatalogId: originalCatalogId,
      compositionId: compositionId,
      compositionLabel: compositionLabel,
      compositionConfidence: compositionConfidence,
      genericName: genericName,
      strength: strength,
      strengthKey: strengthKey,
      form: form,
      formKey: formKey,
      releaseKey: releaseKey,
      doNotSubstitute: doNotSubstitute,
      priority: priority,
      startDate: startDate,
    ),
    reason: block ? 'error.clinical_write_desktop_only' : null,
  );
}
