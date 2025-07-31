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
