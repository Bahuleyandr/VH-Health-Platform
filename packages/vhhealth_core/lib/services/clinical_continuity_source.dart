import 'dart:typed_data';

import '../models/clinical_continuity.dart';

class ClinicalContinuitySourceSnapshot {
  final Uint8List manifestEnvelopeBytes;
  final Map<String, Uint8List> assets;
  final ClinicalContinuitySessionContext session;
  final ClinicalContinuityClockAssessment clock;
  final ClinicalContinuitySourceProvenance provenance;

  const ClinicalContinuitySourceSnapshot({
    required this.manifestEnvelopeBytes,
    required this.assets,
    required this.session,
    required this.clock,
    required this.provenance,
  });
}

/// Read-only boundary implemented by the online backend or C3.2 adapter.
///
/// It deliberately returns exact bytes, not trusted clinical objects. C3.3
/// independently verifies every byte before persistence or display.
abstract interface class ClinicalContinuitySource {
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet();

  /// Current named staff/device/facility context. This may remain available
  /// from secure session state while the transport is down.
  Future<ClinicalContinuitySessionContext?> currentSession();

  /// Trusted-clock state from the same authenticated-readiness boundary used
  /// by [fetchFacilitySet]. Implementations must not substitute device wall
  /// time or add their own connectivity observer.
  Future<ClinicalContinuityClockAssessment> assessClock();

  Future<void> cancel();
}

/// C4 adapter: C3.3 may consume only a verified, active facility context for
/// its named session. The transport delegate remains responsible for exact
/// pack bytes and the trusted readiness clock.
class FacilityBoundClinicalContinuitySource
    implements ClinicalContinuitySource {
  const FacilityBoundClinicalContinuitySource({
    required ClinicalContinuitySource delegate,
    required Future<ClinicalContinuitySessionContext?> Function()
    facilitySession,
  }) : _delegate = delegate,
       _facilitySession = facilitySession;

  final ClinicalContinuitySource _delegate;
  final Future<ClinicalContinuitySessionContext?> Function() _facilitySession;

  @override
  Future<ClinicalContinuityClockAssessment> assessClock() =>
      _delegate.assessClock();

  @override
  Future<void> cancel() => _delegate.cancel();

  @override
  Future<ClinicalContinuitySessionContext?> currentSession() =>
      _facilitySession();

  @override
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet() async {
    final session = await _facilitySession();
    if (session == null) {
      throw StateError('Verified facility context required');
    }
    final snapshot = await _delegate.fetchFacilitySet();
    return ClinicalContinuitySourceSnapshot(
      manifestEnvelopeBytes: snapshot.manifestEnvelopeBytes,
      assets: snapshot.assets,
      session: session,
      clock: snapshot.clock,
      provenance: snapshot.provenance,
    );
  }
}
