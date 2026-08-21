import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_staff/core/services/staff_clinical_action_gateway.dart';

void main() {
  final root = _repositoryRoot();

  test('compiled action vocabulary is exactly the countersigned C-D3 set', () {
    expect(
      OfflineActionIds.values,
      equals(const {
        'op.prescription.draft',
        'ip.drug_chart.draft',
        'mar.administration.backfill',
        'lab.specimen_collection.backfill',
        'blood.transfusion_verification.backfill',
        'emr.nursing_note.observation.capture',
        'emr.nursing_note.medication_note.capture',
        'emr.nursing_note.post_procedure.capture',
        'emr.nursing_note.intake_output.capture',
        'emr.nursing_note.patient_complaint.capture',
        'emr.nursing_note.wound_care.capture',
        'emr.nursing_note.shift_handover.capture',
        'emr.nursing_note.emergency.capture',
        'emr.nursing_note.other.capture',
        'vitals.capture',
        'emr.nursing_note.draft.store',
        'emr.op_note.draft.store',
        'unknown',
      }),
    );
  });

  test('closed call-site manifest has one exact production attachment each', () {
    const manifest = {
      StaffCaptureCallSite.nursingAssessmentDraftStorage: (
        file:
            'apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart',
        token: 'captureCallSite: StaffCaptureCallSite.nursingAssessmentDraftStorage',
      ),
      StaffCaptureCallSite.opConsultationDraftStorage: (
        file: 'apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart',
        token:
            'captureCallSite: StaffCaptureCallSite.opConsultationDraftStorage',
      ),
      StaffCaptureCallSite.opPrescriptionLocalDraft: (
        file:
            'apps/staff/lib/features/doctor/screens/prescriptions_screen.dart',
        token: 'callSite: StaffCaptureCallSite.opPrescriptionLocalDraft',
      ),
      StaffCaptureCallSite.ipDrugChartLocalDraft: (
        file: 'apps/staff/lib/features/ipd/screens/drug_chart_screen.dart',
        token: 'callSite: StaffCaptureCallSite.ipDrugChartLocalDraft',
      ),
    };
    expect(manifest.keys.toSet(), StaffCaptureCallSite.values.toSet());

    final observed = <String>[];
    for (final file in _staffProductionDart(root)) {
      if (file.path.endsWith('staff_clinical_action_gateway.dart')) continue;
      final source = file.readAsStringSync();
      observed.addAll(
        RegExp(r'StaffCaptureCallSite\.([A-Za-z0-9_]+)')
            .allMatches(source)
            .map((match) => match.group(1)!),
      );
    }

    expect(
      observed.toSet(),
      StaffCaptureCallSite.values.map((site) => site.name).toSet(),
    );
    expect(observed, hasLength(StaffCaptureCallSite.values.length));
    for (final entry in manifest.entries) {
      final source = _read(root, entry.value.file);
      expect(_occurrences(source, entry.value.token), 1);
      expect(source, isNot(contains('OfflineActionIds.')));
    }
  });

  test('only two closed call sites can reach an electronic transport', () {
    expect(
      StaffCaptureCallSite.values.where((site) => site.isQueueCapture).toSet(),
      {
        StaffCaptureCallSite.nursingAssessmentDraftStorage,
        StaffCaptureCallSite.opConsultationDraftStorage,
      },
    );
    expect(
      {for (final site in StaffCaptureCallSite.values) site: site.actionId},
      {
        StaffCaptureCallSite.nursingAssessmentDraftStorage:
            OfflineActionIds.nursingNoteDraftStore,
        StaffCaptureCallSite.opConsultationDraftStorage:
            OfflineActionIds.opNoteDraftStore,
        StaffCaptureCallSite.opPrescriptionLocalDraft:
            OfflineActionIds.opPrescriptionDraft,
        StaffCaptureCallSite.ipDrugChartLocalDraft:
            OfflineActionIds.ipDrugChartDraft,
      },
    );

    final transported = OfflineActionIds.values
        .where((id) => OfflineActionIds.clientTransportFor(id) != null)
        .toSet();
    expect(transported, {
      OfflineActionIds.nursingNoteDraftStore,
      OfflineActionIds.opNoteDraftStore,
    });
    for (final id in transported) {
      final transport = OfflineActionIds.clientTransportFor(id)!;
      expect(transport.method, 'PUT');
      expect(transport.path, '/emr/notes/draft');
    }
  });

  test(
    'production Staff has no raw queue or prepared-transport attachment',
    () {
      const forbidden = <String>[
        'ConnectivitySyncService.instance.enqueue(',
        'ConnectivitySyncService.enqueue(',
        'OfflineQueue.enqueue(',
        'OfflineQueue.persistPreparedCommand(',
        'VHHttpClient.sendPreparedMutation(',
        '.prepareCapture(',
      ];
      final violations = <String>[];
      for (final file in _staffProductionDart(root)) {
        final relative = _relative(root, file);
        final source = file.readAsStringSync();
        for (final token in forbidden) {
          if (source.contains(token)) violations.add('$relative: $token');
        }
      }
      expect(violations, isEmpty, reason: violations.join('\n'));
    },
  );

  test('physical actions cannot be enabled by policy or configuration', () {
    const fixtures = <({String screen, String intent, String actionId})>[
      (
        screen: 'apps/staff/lib/features/nursing/screens/mar_scan_screen.dart',
        intent: 'apps/staff/lib/features/nursing/mar_offline_administer.dart',
        actionId: OfflineActionIds.marAdministrationBackfill,
      ),
      (
        screen: 'apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart',
        intent:
            'apps/staff/lib/features/investigations/specimen_scan_intent.dart',
        actionId: OfflineActionIds.labSpecimenCollectionBackfill,
      ),
      (
        screen: 'apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart',
        intent:
            'apps/staff/lib/features/bloodbank/transfusion_scan_intent.dart',
        actionId: OfflineActionIds.bloodTransfusionVerificationBackfill,
      ),
    ];

    for (final fixture in fixtures) {
      final screen = _read(root, fixture.screen);
      final intent = _read(root, fixture.intent);
      expect('$screen\n$intent', isNot(contains('StaffClinicalActionGateway')));
      expect('$screen\n$intent', isNot(contains('.enqueue(')));
      expect(intent, isNot(matches(RegExp(r'\bendpoint\b'))));
      expect(intent, isNot(matches(RegExp(r'\benqueue\b'))));
      expect(OfflineActionIds.clientTransportFor(fixture.actionId), isNull);
    }
  });

  test('high-risk online and paper paths stay in the closed guard inventory', () {
    const inventory = <({String file, List<String> symbols})>[
      (
        file:
            'apps/staff/lib/features/doctor/screens/prescriptions_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'OnlineOnlyActionState'],
      ),
      (
        file: 'apps/staff/lib/features/nursing/screens/mar_scan_screen.dart',
        symbols: ['_administerOffline', 'showMarAdministrationOfflineFallback'],
      ),
      (
        file: 'apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart',
        symbols: ['showSpecimenCollectionOfflineFallback'],
      ),
      (
        file: 'apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart',
        symbols: ['showTransfusionVerificationOfflineFallback'],
      ),
      (
        file: 'apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_completeAppointment'],
      ),
      (
        file: 'apps/staff/lib/features/emr/screens/clinical_notes_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_signNoteAction'],
      ),
      (
        file: 'apps/staff/lib/features/radiology/screens/radiology_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_showSignOffForm'],
      ),
      (
        file: 'apps/staff/lib/features/investigations/screens/lab_bookings_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_showUploadResultDialog'],
      ),
      (
        file:
            'apps/staff/lib/features/emr/screens/discharge_summary_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_proceedToDischarge'],
      ),
      (
        file: 'apps/staff/lib/features/emr/screens/discharge_hub_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', '_finishWorkItem'],
      ),
      (
        file: 'apps/staff/lib/features/beds/screens/bed_board_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'Future<void> _discharge'],
      ),
      (
        file: 'apps/staff/lib/features/clinical_inbox/screens/clinical_inbox_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'OnlineOnlyActionState'],
      ),
      (
        file: 'apps/staff/lib/core/providers/clinical_inbox_provider.dart',
        symbols: ['_requireOnlineMutation', 'ClinicalInboxOfflineMutation'],
      ),
      (
        file:
            'apps/staff/lib/core/widgets/post_discharge_cross_sign_sheet.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'OnlineOnlyActionState'],
      ),
      (
        file: 'apps/staff/lib/features/settings/screens/settings_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'OnlineOnlyActionState'],
      ),
      (
        file: 'apps/staff/lib/features/hr/screens/staff_management_screen.dart',
        symbols: ['OnlineOnlyActionGuard.require', 'OnlineOnlyActionState'],
      ),
      (
        file: 'apps/staff/lib/core/services/clinical_platform_api_service.dart',
        symbols: ['signEncounter', 'lockEncounter'],
      ),
    ];

    final missing = <String>[];
    for (final item in inventory) {
      final source = _read(root, item.file);
      for (final symbol in item.symbols) {
        if (!source.contains(symbol)) missing.add('${item.file}: $symbol');
      }
    }
    expect(missing, isEmpty, reason: missing.join('\n'));
  });

  test('engineering version is 1.2.0+4 without creating policy authority', () {
    final pubspec = _read(root, 'apps/staff/pubspec.yaml');
    expect(
      pubspec,
      contains(RegExp(r'^version: 1\.2\.0\+4\r?$', multiLine: true)),
    );
    expect(StaffClinicalActionGateway.currentAppVersion, '1.2.0+4');
    expect(
      _read(
        root,
        'apps/staff/lib/core/services/staff_action_policy_source.dart',
      ),
      contains('UnavailableStaffActionPolicySource'),
    );
  });
}

Directory _repositoryRoot() {
  var current = Directory.current.absolute;
  while (true) {
    final pubspec = File(
      '${current.path}${Platform.pathSeparator}pubspec.yaml',
    );
    if (pubspec.existsSync() &&
        pubspec.readAsStringSync().contains('name: vhhealth_workspace')) {
      return current;
    }
    final parent = current.parent;
    if (parent.path == current.path) {
      throw StateError('VH Health repository root not found');
    }
    current = parent;
  }
}

Iterable<File> _staffProductionDart(Directory root) {
  final directory = Directory(
    '${root.path}${Platform.pathSeparator}apps'
    '${Platform.pathSeparator}staff${Platform.pathSeparator}lib',
  );
  return directory
      .listSync(recursive: true, followLinks: false)
      .whereType<File>()
      .where((file) => file.path.endsWith('.dart'));
}

String _read(Directory root, String relative) => File(
  '${root.path}${Platform.pathSeparator}${relative.replaceAll('/', Platform.pathSeparator)}',
).readAsStringSync();

String _relative(Directory root, File file) =>
    file.path.substring(root.path.length + 1).replaceAll('\\', '/');

int _occurrences(String source, String token) =>
    RegExp(RegExp.escape(token)).allMatches(source).length;
