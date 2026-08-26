import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

enum AppointmentHydrationFailureKind {
  unauthenticated,
  forbidden,
  notFound,
  offlineUnavailable,
  malformedResponse,
  unavailable,
}

sealed class AppointmentHydrationResult {
  const AppointmentHydrationResult();
}

class AppointmentHydrated extends AppointmentHydrationResult {
  const AppointmentHydrated({
    required this.appointment,
    required this.fromCache,
    this.staleLabel,
    this.cachedAt,
  });

  final AppointmentInfo appointment;
  final bool fromCache;
  final String? staleLabel;
  final DateTime? cachedAt;
}

class AppointmentHydrationFailed extends AppointmentHydrationResult {
  const AppointmentHydrationFailed(this.kind, {this.requestId});

  final AppointmentHydrationFailureKind kind;
  final String? requestId;
}

abstract interface class AppointmentDeepLinkLoader {
  Future<AppointmentHydrationResult> load(int appointmentId);
}

typedef AppointmentDetailRequest = Future<ApiResponse> Function(
  int appointmentId,
);

Future<ApiResponse> _requestAppointmentDetail(int appointmentId) =>
    ApiClient.get('/appointments/$appointmentId');

class ApiAppointmentDeepLinkLoader implements AppointmentDeepLinkLoader {
  const ApiAppointmentDeepLinkLoader({
    this.feedRepository = const ApiAppointmentFeedRepository(),
    this.patientIdResolver,
    this.detailRequest = _requestAppointmentDetail,
  });

  final AppointmentFeedRepository feedRepository;
  final Future<String?> Function()? patientIdResolver;
  final AppointmentDetailRequest detailRequest;

  @override
  Future<AppointmentHydrationResult> load(int appointmentId) async {
    if (appointmentId < 1) {
      return const AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.malformedResponse,
      );
    }

    ApiResponse response;
    try {
      response = await detailRequest(appointmentId);
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Appointment deep-link hydration transport failed: $error');
      }
      return _loadOfflineCopy(appointmentId);
    }

    if (response.isSuccess) {
      final data = response.dataAsMap();
      final raw = data['appointment'] ?? data;
      if (raw is Map) {
        final appointment = AppointmentInfo.fromJson(
          Map<String, dynamic>.from(raw),
        );
        if (appointment.id == appointmentId) {
          return AppointmentHydrated(
            appointment: appointment,
            fromCache: false,
          );
        }
      }
      return AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.malformedResponse,
        requestId: response.requestId,
      );
    }

    if (response.statusCode == 401) {
      return AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.unauthenticated,
        requestId: response.requestId,
      );
    }
    if (response.statusCode == 403) {
      return AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.forbidden,
        requestId: response.requestId,
      );
    }
    if (response.statusCode == 404) {
      return AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.notFound,
        requestId: response.requestId,
      );
    }
    if (response.statusCode == 0 ||
        response.statusCode == 502 ||
        response.statusCode == 503 ||
        response.statusCode == 504 ||
        response.code == 'PATIENT_OUTAGE_CACHE_ONLY') {
      return _loadOfflineCopy(appointmentId);
    }
    return AppointmentHydrationFailed(
      AppointmentHydrationFailureKind.unavailable,
      requestId: response.requestId,
    );
  }

  Future<AppointmentHydrationResult> _loadOfflineCopy(int appointmentId) async {
    String? patientId;
    try {
      patientId = await (patientIdResolver?.call() ?? _activePatientId());
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Appointment deep-link patient resolution failed: $error');
      }
      return const AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.offlineUnavailable,
      );
    }
    if (patientId == null || patientId.trim().isEmpty) {
      return const AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.unauthenticated,
      );
    }

    try {
      final cached = await feedRepository.fetch(patientId);
      if (cached.isSuccess) {
        for (final appointment in parseAppointmentInfos(cached.data)) {
          if (appointment.id == appointmentId) {
            return AppointmentHydrated(
              appointment: appointment,
              fromCache: true,
              staleLabel: cached.staleLabel,
              cachedAt: cached.cachedAt,
            );
          }
        }
      }
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Appointment deep-link cache hydration failed: $error');
      }
    }
    return const AppointmentHydrationFailed(
      AppointmentHydrationFailureKind.offlineUnavailable,
    );
  }

  Future<String?> _activePatientId() async {
    final dependent = DependentsProvider.instance?.activeDependent;
    if (dependent != null) return dependent.id.toString();
    return VHSecureStorage.instance.read(key: 'user_id');
  }
}
