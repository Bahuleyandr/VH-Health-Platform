// lib/features/doctor/prescription_offline_rx.dart
//
// Pure decision for the OFFLINE e-prescription path. Keeps the screen thin and the
// safety branch unit-testable.
//
// INVARIANT: a device that cannot place clinical orders (phone-mode or an empty/unknown
// deviceType) NEVER enqueues — queuing there would only 403 on drain
// (rejectMobileClinicalWrite). This mirrors the backend device gate.

import '../../core/services/prescription_payloads.dart';

class OfflineRxIntent {
  const OfflineRxIntent({
    required this.block,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.reason,
  });

  /// Device cannot place clinical writes → abort, do NOT enqueue.
  final bool block;

  /// Safe to queue the prescription create.
  final bool enqueue;

  final String endpoint;
  final Map<String, dynamic> body;

  /// User-facing block reason (null when [enqueue] is true).
  final String? reason;
}

/// Decide whether an e-prescription can be queued offline and build the byte-identical
/// POST /prescriptions/create body. [deviceType] is the staff app's current posture
/// (`currentDeviceType`): clinical writes are desktop/tablet-only, so 'mobile' or an
/// empty/unknown value is blocked. The offline body omits `override` (no CDS blocker is
/// seen offline — a block surfaces on drain as a conflict).
OfflineRxIntent buildOfflineRxIntent({
  required String deviceType,
  required int patientId,
  required int doctorId,
  int? appointmentId,
  required String diagnosis,
  String? clinicalNotes,
  required List<Map<String, dynamic>> medications,
  String? followUpDate,
  String? followUpNotes,
  Map<String, dynamic>? vitals,
}) {
  final dt = deviceType.trim().toLowerCase();
  final block = dt == 'mobile' || dt.isEmpty;
  return OfflineRxIntent(
    block: block,
    enqueue: !block,
    endpoint: '/prescriptions/create',
    body: buildPrescriptionBody(
      patientId: patientId,
      doctorId: doctorId,
      appointmentId: appointmentId,
      diagnosis: diagnosis,
      clinicalNotes: clinicalNotes,
      medications: medications,
      followUpDate: followUpDate,
      followUpNotes: followUpNotes,
      vitals: vitals,
    ),
    reason: block
        ? 'Prescriptions can only be created from a desktop or tablet workstation.'
        : null,
  );
}
