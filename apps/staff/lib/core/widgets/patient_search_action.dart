import 'package:flutter/material.dart';

import '../services/telemetry_service.dart';
import 'patient_search_sheet.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

/// AppBar magnifier that opens the global patient picker
/// ([PatientSearchSheet]). Drop into any screen's AppBar.actions list.
///
/// Non-clinical roles will see the icon but the underlying
/// `/api/v1/patients/search` endpoint RBAC's to clinical staff +
/// admins; for them the picker surfaces the 403 inline as the search
/// error message ("Forbidden") rather than throwing a dialog. Hiding
/// the action per-role would require an async role read every build,
/// which isn't worth the flicker.
class PatientSearchAction extends StatelessWidget {
  const PatientSearchAction({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.person_search_outlined),
      tooltip: AppStrings.of(context)
          .lookup('s4.lib.patient_search_action.find_patient'),
      onPressed: () {
        Telemetry.event('patient_picker.open', {'from': 'appbar'});
        PatientSearchSheet.show(context);
      },
    );
  }
}
