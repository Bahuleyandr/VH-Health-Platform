// lib/features/emr/models/patient_summary.dart
//
// Pure logic for the one-screen patient summary (roadmap E5): partitions
// the patient's clinical orders into active medications and pending
// results, compacts the latest vitals row into a single line, and
// normalises the allergy payloads that ride on the command-board
// response. No Flutter imports — unit-tested in
// test/features/emr/patient_summary_test.dart.

/// Orders that are still clinically live on the chart. Mirrors the
/// backend's canonical live-order set ('ordered','verified','in_progress')
/// — orderEntryService/ipdSupportService/admissionService all use the
/// triple; an in-progress infusion or a specimen already in the lab is
/// still on the chart. (Review fix pre-merge: 'in_progress' was missing.)
const kActiveOrderStatuses = {'ordered', 'verified', 'in_progress'};

/// Order types whose un-completed orders read as "pending results".
const kResultOrderTypes = {'investigation', 'lab', 'radiology', 'ecg'};

/// Split a patient's clinical orders into the summary buckets:
/// active medication orders and result-type orders still awaiting
/// completion. Everything else (nursing, diet, consults, completed or
/// stopped orders) is out of summary scope.
({
  List<Map<String, dynamic>> activeMeds,
  List<Map<String, dynamic>> pendingResults,
})
partitionOrdersForSummary(List<dynamic> orders) {
  final meds = <Map<String, dynamic>>[];
  final results = <Map<String, dynamic>>[];
  for (final o in orders) {
    if (o is! Map) continue;
    final order = Map<String, dynamic>.from(o);
    final status = order['status']?.toString().toLowerCase() ?? '';
    if (!kActiveOrderStatuses.contains(status)) continue;
    final type = order['order_type']?.toString().toLowerCase() ?? '';
    if (type == 'medication' || type == 'med') {
      meds.add(order);
    } else if (kResultOrderTypes.contains(type)) {
      results.add(order);
    }
  }
  return (activeMeds: meds, pendingResults: results);
}

/// Compact one vitals_chart row into a single display line, skipping
/// missing values. Field names follow the EMR vitals chart response
/// (`heart_rate`, `systolic_bp`/`diastolic_bp`, `temperature`, `spo2`,
/// `respiratory_rate`); legacy `bp_systolic`/`bp_diastolic` spellings
/// are tolerated.
String latestVitalsLine(Map<String, dynamic>? row) {
  if (row == null) return '';
  dynamic v(List<String> keys) {
    for (final k in keys) {
      final value = row[k];
      if (value != null && '$value'.trim().isNotEmpty) return value;
    }
    return null;
  }

  final sys = v(const ['systolic_bp', 'bp_systolic']);
  final dia = v(const ['diastolic_bp', 'bp_diastolic']);
  final parts = <String>[
    if (sys != null && dia != null) 'BP $sys/$dia',
    if (v(const ['heart_rate', 'pulse']) case final hr?) 'HR $hr',
    if (v(const ['spo2']) case final spo2?) 'SpO2 $spo2%',
    if (v(const ['temperature', 'temp']) case final t?) 'T $t',
    if (v(const ['respiratory_rate', 'rr']) case final rr?) 'RR $rr',
    if (v(const ['pain_score']) case final pain?) 'Pain $pain',
  ];
  return parts.join(' · ');
}

/// Dedupe + cap the allergy items from the command-board payload
/// (items shaped {allergy/name/allergy_name, severity?, source?}).
/// Returns display strings, severity-suffixed when present.
List<String> summarizeAllergies(List<dynamic> items, {int cap = 8}) {
  final seen = <String>{};
  final out = <String>[];
  for (final item in items) {
    String? name;
    String? severity;
    if (item is Map) {
      name = (item['allergy'] ?? item['allergy_name'] ?? item['name'])
          ?.toString();
      severity = item['severity']?.toString();
    } else if (item is String) {
      name = item;
    }
    final norm = name?.trim().toLowerCase() ?? '';
    if (norm.isEmpty || !seen.add(norm)) continue;
    final display = name!.trim();
    out.add(
      severity != null && severity.trim().isNotEmpty
          ? '$display (${severity.trim()})'
          : display,
    );
    if (out.length >= cap) break;
  }
  return out;
}

/// Pull this patient's admission entry (if any) out of the
/// command-board response (`{admissions|patients|items: [...]}` — the
/// board has used a couple of envelope spellings; all are tolerated).
Map<String, dynamic>? extractBoardEntry(
  Map<String, dynamic> board,
  String patientUid,
) {
  for (final key in const ['admissions', 'patients', 'items', 'data']) {
    final list = board[key];
    if (list is! List) continue;
    for (final entry in list) {
      if (entry is! Map) continue;
      final row = Map<String, dynamic>.from(entry);
      final uid =
          (row['patient_uid'] ??
                  row['uid'] ??
                  (row['patient'] is Map
                      ? (row['patient'] as Map)['uid']
                      : null))
              ?.toString();
      if (uid == patientUid) return row;
    }
  }
  return null;
}
