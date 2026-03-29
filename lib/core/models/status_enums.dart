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

  bool get isActive => this == scheduled || this == confirmed || this == inProgress;
  bool get isTerminal => this == completed || this == cancelled || this == noShow;
}

/// Pharmacy order statuses returned by the backend.
enum PharmacyOrderStatus {
  placed('PLACED'),
  confirmed('CONFIRMED'),
  preparing('PREPARING'),
  dispatched('DISPATCHED'),
  delivered('DELIVERED'),
  cancelled('CANCELLED');

  final String value;
  const PharmacyOrderStatus(this.value);

  static PharmacyOrderStatus? fromString(String? status) {
    if (status == null) return null;
    final upper = status.toUpperCase();
    return PharmacyOrderStatus.values.cast<PharmacyOrderStatus?>().firstWhere(
      (e) => e!.value == upper,
      orElse: () => null,
    );
  }

  bool get isActive => this != delivered && this != cancelled;
  bool get isTerminal => this == delivered || this == cancelled;

  static const List<String> orderedSteps = [
    'PLACED',
    'CONFIRMED',
    'PREPARING',
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

  bool get isActive => this != completed && this != cancelled && this != reportReady;
  bool get isTerminal => this == completed || this == cancelled;
}
