import 'offline_write_containment.dart';

/// The C-D3-frozen client vocabulary for clinical continuity capture.
///
/// These identifiers are data, not executable routes. Only
/// [clientTransportFor] may resolve a currently approved client transport, and
/// that closed adapter deliberately exposes only the two private draft-store
/// actions implemented by C4.2.
abstract final class OfflineActionIds {
  static const opPrescriptionDraft = 'op.prescription.draft';
  static const ipDrugChartDraft = 'ip.drug_chart.draft';
  static const marAdministrationBackfill = 'mar.administration.backfill';
  static const labSpecimenCollectionBackfill =
      'lab.specimen_collection.backfill';
  static const bloodTransfusionVerificationBackfill =
      'blood.transfusion_verification.backfill';
  static const nursingNoteObservation = 'emr.nursing_note.observation.capture';
  static const nursingNoteMedication =
      'emr.nursing_note.medication_note.capture';
  static const nursingNotePostProcedure =
      'emr.nursing_note.post_procedure.capture';
  static const nursingNoteIntakeOutput =
      'emr.nursing_note.intake_output.capture';
  static const nursingNotePatientComplaint =
      'emr.nursing_note.patient_complaint.capture';
  static const nursingNoteWoundCare = 'emr.nursing_note.wound_care.capture';
  static const nursingNoteShiftHandover =
      'emr.nursing_note.shift_handover.capture';
  static const nursingNoteEmergency = 'emr.nursing_note.emergency.capture';
  static const nursingNoteOther = 'emr.nursing_note.other.capture';
  static const vitalsCapture = 'vitals.capture';
  static const nursingNoteDraftStore = 'emr.nursing_note.draft.store';
  static const opNoteDraftStore = 'emr.op_note.draft.store';
  static const unknown = 'unknown';

  static const values = <String>{
    opPrescriptionDraft,
    ipDrugChartDraft,
    marAdministrationBackfill,
    labSpecimenCollectionBackfill,
    bloodTransfusionVerificationBackfill,
    nursingNoteObservation,
    nursingNoteMedication,
    nursingNotePostProcedure,
    nursingNoteIntakeOutput,
    nursingNotePatientComplaint,
    nursingNoteWoundCare,
    nursingNoteShiftHandover,
    nursingNoteEmergency,
    nursingNoteOther,
    vitalsCapture,
    nursingNoteDraftStore,
    opNoteDraftStore,
    unknown,
  };

  static const draftStoreActions = <String>{
    nursingNoteDraftStore,
    opNoteDraftStore,
  };

  static bool isKnown(String value) => values.contains(value);

  static bool isDraft(String value) => draftStoreActions.contains(value);

  /// Temporary C0A classification used only by the deprecated endpoint facade.
  static String fromLegacyControl({
    required String method,
    required String path,
    required Map<String, dynamic> body,
  }) {
    final classification = OfflineWriteContainment.classify(
      method: method,
      path: path,
    );
    return switch (classification.family) {
      OfflineWriteActionFamily.vitals => vitalsCapture,
      OfflineWriteActionFamily.noteDraft => _legacyDraftAction(body),
      _ => unknown,
    };
  }

  static String _legacyDraftAction(Map<String, dynamic> body) {
    final noteType = body['note_type']?.toString().trim().toLowerCase();
    if (noteType == null || noteType.isEmpty) return nursingNoteDraftStore;
    return switch (noteType) {
      'op_consultation' => opNoteDraftStore,
      'nursing_assessment' || 'nursing_note' => nursingNoteDraftStore,
      _ => unknown,
    };
  }

  /// Closed, in-memory transport adapter. SQLite never stores these values as
  /// C4 execution authority.
  static OfflineClientTransport? clientTransportFor(String actionId) {
    return switch (actionId) {
      nursingNoteDraftStore || opNoteDraftStore => const OfflineClientTransport(
        method: 'PUT',
        path: '/emr/notes/draft',
      ),
      _ => null,
    };
  }
}

class OfflineClientTransport {
  const OfflineClientTransport({required this.method, required this.path});

  final String method;
  final String path;
}
