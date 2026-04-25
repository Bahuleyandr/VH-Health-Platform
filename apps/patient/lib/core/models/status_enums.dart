// lib/core/models/status_enums.dart
//
// Centralized status enums matching backend status strings.
// Use these instead of raw string literals in switch statements.

/// Appointment statuses returned by the backend.
enum AppointmentStatus {
  scheduled('SCHEDULED'),
  confirmed('CONFIRMED'),
  inProgress('IN_PROGRESS'),
  completed('COMPLETED'),
  cancelled('CANCELLED'),
  noShow('NO_SHOW');

  final String value;
  const AppointmentStatus(this.value);

  static AppointmentStatus? fromString(String? status) {
    if (status == null) return null;
    final upper = status.toUpperCase();
    return AppointmentStatus.values.cast<AppointmentStatus?>().firstWhere(
      (e) => e!.value == upper,
      orElse: () => null,
    );
  }

  bool get isActive =>
      this == scheduled || this == confirmed || this == inProgress;
  bool get isTerminal =>
      this == completed || this == cancelled || this == noShow;
}

/// Pharmacy order statuses returned by the backend.
/// Canonical value is `PENDING` (matches backend `ORDER_STATUS.PENDING` after the
/// 2026-04-14 lifecycle alignment). Legacy `PLACED` is accepted for backward
/// compatibility with older backend deployments.
enum PharmacyOrderStatus {
  pending('PENDING'),
  confirmed('CONFIRMED'),
  preparing('PREPARING'),
  ready('READY'),
  dispatched('DISPATCHED'),
  delivered('DELIVERED'),
  cancelled('CANCELLED');

  final String value;
  const PharmacyOrderStatus(this.value);

  static PharmacyOrderStatus? fromString(String? status) {
    if (status == null) return null;
    final upper = status.toUpperCase();
    // Legacy alias: old backends returned 'PLACED' before the 2026-04-14 lifecycle
    // rename. Fold it into the canonical `pending`.
    if (upper == 'PLACED') return PharmacyOrderStatus.pending;
    return PharmacyOrderStatus.values.cast<PharmacyOrderStatus?>().firstWhere(
      (e) => e!.value == upper,
      orElse: () => null,
    );
  }

  bool get isActive => this != delivered && this != cancelled;
  bool get isTerminal => this == delivered || this == cancelled;

  static const List<String> orderedSteps = [
    'PENDING',
    'CONFIRMED',
    'PREPARING',
    'READY',
    'DISPATCHED',
    'DELIVERED',
  ];
}

/// Investigation booking statuses returned by the backend.
enum InvestigationStatus {
  pending('PENDING'),
  confirmed('CONFIRMED'),
  sampleCollected('SAMPLE_COLLECTED'),
  processing('PROCESSING'),
  completed('COMPLETED'),
  reportReady('REPORT_READY'),
  cancelled('CANCELLED');

  final String value;
  const InvestigationStatus(this.value);

  static InvestigationStatus? fromString(String? status) {
    if (status == null) return null;
    final upper = status.toUpperCase();
    return InvestigationStatus.values.cast<InvestigationStatus?>().firstWhere(
      (e) => e!.value == upper,
      orElse: () => null,
    );
  }

  bool get isActive =>
      this != completed && this != cancelled && this != reportReady;
  bool get isTerminal => this == completed || this == cancelled;
}
