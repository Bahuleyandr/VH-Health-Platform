import 'package:vhhealth/generated/app_localizations.dart';

/// Adds a convenient `recordTypeLabel` helper to AppLocalizations.
extension RecordTypeLocalizations on AppLocalizations {
  /// Converts the backend/raw record-type string to the localized label.
  String recordTypeLabel(String raw) {
    switch (raw.toLowerCase()) {
      case 'consultation':
        return recordTypeConsultation;
      case 'investigation':
        return recordTypeInvestigation;
      case 'report':
        return recordTypeReport;
      // fall-back (also used for “All”):
      default:
        return recordTypeAll;
    }
  }
}

/// Adds localized labels for patient-visible consultation note types.
extension ConsultationNoteTypeLocalizations on AppLocalizations {
  String consultationNoteTypeLabel(String raw) {
    switch (raw.toLowerCase()) {
      case 'op_consultation':
        return consultationNoteTypeOpConsultation;
      case 'consultation':
        return consultationNoteTypeConsultation;
      case 'consultation_note':
        return consultationNoteTypeConsultationNote;
      case 'follow_up':
      case 'follow-up':
        return consultationNoteTypeFollowUp;
      case 'progress':
        return consultationNoteTypeProgress;
      case 'soap':
        return consultationNoteTypeSoap;
      default:
        return raw
            .replaceAll('_', ' ')
            .replaceAll('-', ' ')
            .trim()
            .split(RegExp(r'\s+'))
            .where((part) => part.isNotEmpty)
            .map((part) => part[0].toUpperCase() + part.substring(1))
            .join(' ');
    }
  }
}
