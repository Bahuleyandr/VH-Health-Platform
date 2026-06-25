import 'package:flutter/material.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/vital_text_field.dart';
import '../../../l10n/app_strings.dart';

/// EMR Vitals Charting screen — record vitals, view 24h data table, I/O charting.
class VitalsChartScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;

  const VitalsChartScreen({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  @override
  State<VitalsChartScreen> createState() => _VitalsChartScreenState();
}

const _vitalsConsciousnessCodes = {'A', 'C', 'V', 'P', 'U'};
const vitalsConsciousnessOptionCodes = ['A', 'C', 'V', 'P', 'U'];

String normalizeVitalsConsciousness(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return 'A';

  final upper = trimmed.toUpperCase();
  if (_vitalsConsciousnessCodes.contains(upper)) return upper;

  final leadingCode = upper.split(RegExp(r'[\s\-]+')).first;
  if (_vitalsConsciousnessCodes.contains(leadingCode)) return leadingCode;

  return switch (upper) {
    'ALERT' => 'A',
    'CONFUSED' || 'CONFUSION' => 'C',
    'VERBAL' || 'VOICE' || 'RESPONDS TO VOICE' => 'V',
    'PAIN' || 'RESPONDS TO PAIN' => 'P',
    'UNRESPONSIVE' || 'UNRESP' => 'U',
    _ => 'A',
  };
}

String vitalsConsciousnessLabel(AppStrings strings, String code) {
  return switch (code) {
    'A' => strings.vitalsChartConsciousAlert,
    'C' => strings.vitalsChartConsciousConfused,
    'V' => strings.vitalsChartConsciousVerbal,
    'P' => strings.vitalsChartConsciousPain,
    'U' => strings.vitalsChartConsciousUnresp,
    _ => strings.vitalsChartConsciousAlert,
  };
}

Map<String, dynamic> buildVitalsRecordPayload({
  required String patientUid,
  required String hr,
  required String bpSystolic,
  required String bpDiastolic,
  required String temp,
  required String spo2,
  required String rr,
  required String glucose,
  required String pain,
  required String gcs,
  required String consciousness,
}) {
  final hrValue = normalizeVitalValue(hr, VitalUnit.pulse);
  final bpSystolicValue = normalizeVitalValue(bpSystolic, VitalUnit.bp);
  final bpDiastolicValue = normalizeVitalValue(bpDiastolic, VitalUnit.bp);
  final tempValue = normalizeVitalValue(temp, VitalUnit.temperature);
  final spo2Value = normalizeVitalValue(spo2, VitalUnit.spo2);
  final rrValue = normalizeVitalValue(rr, VitalUnit.respiratoryRate);
  final glucoseValue = normalizeVitalValue(glucose, VitalUnit.cbg);
  final painValue = normalizeVitalValue(pain, VitalUnit.pain);
  final gcsValue = normalizeVitalValue(gcs, VitalUnit.gcs);
  final consciousnessValue = normalizeVitalsConsciousness(consciousness);

  final data = <String, dynamic>{
    'patient_uid': patientUid,
    if (hrValue.isNotEmpty) 'heart_rate': int.tryParse(hrValue),
    if (bpSystolicValue.isNotEmpty)
      'systolic_bp': int.tryParse(bpSystolicValue),
    if (bpDiastolicValue.isNotEmpty)
      'diastolic_bp': int.tryParse(bpDiastolicValue),
    if (tempValue.isNotEmpty) 'temperature': double.tryParse(tempValue),
    if (spo2Value.isNotEmpty) 'spo2': int.tryParse(spo2Value),
    if (rrValue.isNotEmpty) 'respiratory_rate': int.tryParse(rrValue),
    if (glucoseValue.isNotEmpty) 'blood_glucose': int.tryParse(glucoseValue),
    if (painValue.isNotEmpty) 'pain_score': int.tryParse(painValue),
    if (gcsValue.isNotEmpty) 'gcs_score': int.tryParse(gcsValue),
    'consciousness': consciousnessValue,
  };

  data.removeWhere((_, v) => v == null);
  return data;
}

dynamic _firstVitalsValue(Map<String, dynamic> row, List<String> keys) {
  for (final key in keys) {
    final value = row[key];
    if (value != null) return value;
  }
  return null;
}

List<Map<String, dynamic>> extractVitalsChartRows(Map<String, dynamic> data) {
  final list =
      data['vitals'] ?? data['records'] ?? data['data'] ?? data['items'];
  if (list is! List) return [];

  return list
      .whereType<Map>()
      .map((e) => Map<String, dynamic>.from(e))
      .toList();
}

List<Map<String, dynamic>> filterVitalsRowsLast24h(
  List<Map<String, dynamic>> rows, {
  DateTime? now,
}) {
  final cutoff = (now ?? DateTime.now()).subtract(const Duration(hours: 24));
  return rows.where((row) {
    final parsed = parseRecordDateTime(row['recorded_at']);
    if (parsed == null) return true;
    return !parsed.toLocal().isBefore(cutoff);
  }).toList();
}

List<Map<String, dynamic>> filterVitalsRowsBeforeLast24h(
  List<Map<String, dynamic>> rows, {
  DateTime? now,
}) {
  final cutoff = (now ?? DateTime.now()).subtract(const Duration(hours: 24));
  return rows.where((row) {
    final parsed = parseRecordDateTime(row['recorded_at']);
    if (parsed == null) return false;
    return parsed.toLocal().isBefore(cutoff);
  }).toList();
}

List<Map<String, dynamic>> extractIOChartRows(Map<String, dynamic> data) {
  final list =
      data['entries'] ?? data['records'] ?? data['data'] ?? data['items'];
  if (list is! List) return [];

  return list
      .whereType<Map>()
      .map((e) => Map<String, dynamic>.from(e))
      .toList();
}

List<Map<String, dynamic>> filterIOEntriesBeforeToday(
  List<Map<String, dynamic>> rows, {
  DateTime? now,
}) {
  final localNow = now ?? DateTime.now();
  final todayStart = DateTime(localNow.year, localNow.month, localNow.day);
  return rows.where((row) {
    final parsed = parseRecordDateTime(row['recorded_at']);
    if (parsed == null) return false;
    return parsed.toLocal().isBefore(todayStart);
  }).toList();
}

DateTime? parseRecordDateTime(dynamic value) {
  if (value is DateTime) return value;
  if (value is! String) return null;
  return DateTime.tryParse(value);
}

Map<String, dynamic> buildIORecordPayload({
  required String patientUid,
  required String type,
  required String category,
  required String amount,
  required String description,
}) {
  final data = <String, dynamic>{
    'patient_uid': patientUid,
    'io_type': type,
    'category': category,
    'amount_ml': int.tryParse(amount) ?? 0,
    if (description.trim().isNotEmpty) 'description': description.trim(),
  };
  return data;
}

String rowIOType(Map<String, dynamic> row) {
  return '${row['io_type'] ?? row['type'] ?? ''}'.toLowerCase();
}

String rowIOAmount(Map<String, dynamic> row) {
  return '${row['amount_ml'] ?? row['amount'] ?? 0}';
}

String rowIODateLabel(Map<String, dynamic> row) {
  return recordDateTimeLabel(row['recorded_at']);
}

String recordDateTimeLabel(dynamic value) {
  final parsed = parseRecordDateTime(value);
  if (parsed == null) return '-';
  final local = parsed.toLocal();
  return '${local.day.toString().padLeft(2, '0')}/${local.month.toString().padLeft(2, '0')} ${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
}

/// NEWS2 escalates at a total score >= 5 (matches the backend
/// NEWS2_ESCALATION_THRESHOLD); >= 7 is the critical band.
const int news2EscalationThreshold = 5;

/// Immutable view-model for the NEWS2 deterioration banner, derived from a
/// record-vitals API response. Audit 2026-06-22 W2-H2: the clinician must SEE
/// the early-warning score + the recommended escalation response after saving.
class News2Banner {
  const News2Banner({
    required this.totalScore,
    required this.clinicalRisk,
    required this.severity,
    required this.shouldEscalate,
  });

  /// 0–20 aggregate NEWS2 score.
  final int totalScore;

  /// Raw backend enum: `low` | `low_to_medium` | `medium` | `high`.
  final String clinicalRisk;

  /// UI severity band: `critical` | `high` | `medium` | `low`.
  final String severity;

  /// True when totalScore >= the escalation threshold (the deterioration case).
  final bool shouldEscalate;
}

/// Map a NEWS2 total score + clinical-risk enum to a UI severity band. Score is
/// authoritative; the enum is a tie-breaker so a high-risk single-parameter
/// trigger (e.g. score 3 in one parameter → clinicalRisk 'high') still bands up.
String news2SeverityToken(int totalScore, String clinicalRisk) {
  final risk = clinicalRisk.toLowerCase();
  if (totalScore >= 7 || risk == 'high') return 'critical';
  if (totalScore >= news2EscalationThreshold || risk == 'medium') return 'high';
  if (totalScore >= 1 || risk == 'low_to_medium') return 'medium';
  return 'low';
}

/// Extract a [News2Banner] from a record-vitals API response (`data` envelope
/// already unwrapped). Returns null when there is no usable NEWS2 payload, so
/// callers can simply hide the banner. Tolerates numeric strings / doubles for
/// the score and either `clinical_risk` or its `risk_level` alias.
News2Banner? extractNews2Banner(Map<String, dynamic>? response) {
  if (response == null) return null;
  final raw = response['news2'];
  if (raw is! Map) return null;
  final news2 = raw.cast<String, dynamic>();
  final scoreRaw = news2['total_score'];
  final int? score = scoreRaw is int
      ? scoreRaw
      : scoreRaw is num
      ? scoreRaw.toInt()
      : int.tryParse('${scoreRaw ?? ''}');
  if (score == null) return null;
  final clinicalRisk = (news2['clinical_risk'] ?? news2['risk_level'] ?? '')
      .toString();
  return News2Banner(
    totalScore: score,
    clinicalRisk: clinicalRisk,
    severity: news2SeverityToken(score, clinicalRisk),
    shouldEscalate: score >= news2EscalationThreshold,
  );
}

class _VitalsChartScreenState extends State<VitalsChartScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  // Vitals data
  List<Map<String, dynamic>> _vitalsHistory = [];
  bool _vitalsLoading = true;
  String? _vitalsError;

  // I/O data
  Map<String, dynamic>? _ioBalance;
  bool _ioLoading = true;
  String? _ioError;
  List<Map<String, dynamic>> _ioHistory = [];
  bool _ioHistoryLoading = true;
  String? _ioHistoryError;

  // Most recent elevated NEWS2 result to surface as a deterioration banner.
  News2Banner? _latestNews2;

  List<Map<String, dynamic>> get _last24hVitals =>
      filterVitalsRowsLast24h(_vitalsHistory);

  List<Map<String, dynamic>> get _previousVitals =>
      filterVitalsRowsBeforeLast24h(_vitalsHistory);

  List<Map<String, dynamic>> get _previousIOEntries =>
      filterIOEntriesBeforeToday(_ioHistory);

  bool get _isDark => AppTheme.brightness == Brightness.dark;
  Color get _accentColor =>
      _isDark ? const Color(0xFF90CAF9) : AppTheme.primaryBlue;
  Color get _sectionSurface => AppTheme.cardSurface;
  Color get _nestedSurface =>
      _isDark ? AppTheme.darkSurface : AppTheme.backgroundGrey;
  Color get _successColor => AppTheme.successOnSurface;
  Color get _warningColor => AppTheme.warningOnSurface;
  Color get _errorColor => AppTheme.errorOnSurface;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadVitalsHistory();
    _loadIOBalance();
    _loadIOHistory();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadVitalsHistory() async {
    setState(() {
      _vitalsLoading = true;
      _vitalsError = null;
    });
    try {
      final data = await MedicalApiService.getVitalsChart(widget.patientUid);
      setState(() {
        _vitalsHistory = extractVitalsChartRows(data);
        _vitalsLoading = false;
      });
    } catch (e) {
      setState(() {
        _vitalsError = e.toString();
        _vitalsLoading = false;
      });
    }
  }

  Future<void> _loadIOBalance() async {
    setState(() {
      _ioLoading = true;
      _ioError = null;
    });
    try {
      final today = DateTime.now();
      final dateStr =
          '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
      final data = await MedicalApiService.getIOBalance(
        widget.patientUid,
        date: dateStr,
      );
      setState(() {
        _ioBalance = data;
        _ioLoading = false;
      });
    } catch (e) {
      setState(() {
        _ioError = e.toString();
        _ioLoading = false;
      });
    }
  }

  Future<void> _loadIOHistory() async {
    setState(() {
      _ioHistoryLoading = true;
      _ioHistoryError = null;
    });
    try {
      final data = await MedicalApiService.getIOChart(widget.patientUid);
      setState(() {
        _ioHistory = extractIOChartRows(data);
        _ioHistoryLoading = false;
      });
    } catch (e) {
      setState(() {
        _ioHistoryError = e.toString();
        _ioHistoryLoading = false;
      });
    }
  }

  Future<void> _refreshToday() async {
    await Future.wait([_loadVitalsHistory(), _loadIOBalance()]);
  }

  Future<void> _refreshPreviousDays() async {
    await Future.wait([_loadVitalsHistory(), _loadIOHistory()]);
  }

  // ── Record Vitals Form ──

  void _showRecordVitalsSheet() {
    final formKey = GlobalKey<FormState>();
    final hr = TextEditingController();
    final bpSystolic = TextEditingController();
    final bpDiastolic = TextEditingController();
    final temp = TextEditingController();
    final spo2 = TextEditingController();
    final rr = TextEditingController();
    final glucose = TextEditingController();
    final pain = TextEditingController();
    final gcs = TextEditingController();
    String consciousness = 'A';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Container(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(ctx).viewInsets.bottom,
          ),
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(ctx).size.height * 0.9,
          ),
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Form(
              key: formKey,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 40,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AppTheme.divider,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      AppStrings.of(ctx).vitalsChartRecordVitals,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Heart Rate
                    _vitalField(
                      hr,
                      AppStrings.of(ctx).vitalsChartHeartRate,
                      Icons.favorite,
                      suffix: VitalUnit.pulse,
                      keyboardType: TextInputType.number,
                    ),
                    const SizedBox(height: 12),

                    // Blood Pressure
                    Row(
                      children: [
                        Expanded(
                          child: _vitalField(
                            bpSystolic,
                            AppStrings.of(ctx).vitalsChartBpSys,
                            Icons.arrow_upward,
                            suffix: VitalUnit.bp,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: Text(
                            '/',
                            style: TextStyle(
                              fontSize: 24,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                        ),
                        Expanded(
                          child: _vitalField(
                            bpDiastolic,
                            AppStrings.of(ctx).vitalsChartBpDia,
                            Icons.arrow_downward,
                            suffix: VitalUnit.bp,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    // Temperature & SpO2
                    Row(
                      children: [
                        Expanded(
                          child: _vitalField(
                            temp,
                            AppStrings.of(ctx).vitalsChartTemp,
                            Icons.thermostat,
                            suffix: VitalUnit.temperature,
                            keyboardType: const TextInputType.numberWithOptions(
                              decimal: true,
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _vitalField(
                            spo2,
                            AppStrings.of(ctx).vitalsChartSpo2,
                            Icons.air,
                            suffix: VitalUnit.spo2,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    // RR & Glucose
                    Row(
                      children: [
                        Expanded(
                          child: _vitalField(
                            rr,
                            AppStrings.of(ctx).vitalsChartRespRate,
                            Icons.waves,
                            suffix: VitalUnit.respiratoryRate,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _vitalField(
                            glucose,
                            AppStrings.of(ctx).vitalsChartGlucose,
                            Icons.water_drop,
                            suffix: VitalUnit.cbg,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    // Pain & GCS
                    Row(
                      children: [
                        Expanded(
                          child: _vitalField(
                            pain,
                            AppStrings.of(ctx).vitalsChartPain,
                            Icons.sentiment_dissatisfied,
                            suffix: VitalUnit.pain,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _vitalField(
                            gcs,
                            AppStrings.of(ctx).vitalsChartGcs,
                            Icons.psychology,
                            suffix: VitalUnit.gcs,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    // Consciousness
                    DropdownButtonFormField<String>(
                      initialValue: consciousness,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(ctx).vitalsChartConsciousness,
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.visibility),
                        ),
                        border: const OutlineInputBorder(),
                      ),
                      items: vitalsConsciousnessOptionCodes
                          .map(
                            (code) => DropdownMenuItem(
                              value: code,
                              child: Text(
                                vitalsConsciousnessLabel(
                                  AppStrings.of(ctx),
                                  code,
                                ),
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: (v) => setSheetState(
                        () => consciousness = v ?? consciousness,
                      ),
                    ),
                    const SizedBox(height: 20),

                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: () => _submitVitals(
                          formKey: formKey,
                          hr: hr.text,
                          bpSystolic: bpSystolic.text,
                          bpDiastolic: bpDiastolic.text,
                          temp: temp.text,
                          spo2: spo2.text,
                          rr: rr.text,
                          glucose: glucose.text,
                          pain: pain.text,
                          gcs: gcs.text,
                          consciousness: consciousness,
                        ),
                        icon: const Icon(Icons.save),
                        label: Text(AppStrings.of(ctx).vitalsChartSaveButton),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _vitalField(
    TextEditingController controller,
    String label,
    IconData icon, {
    String? suffix,
    TextInputType? keyboardType,
  }) {
    return TextFormField(
      controller: controller,
      keyboardType: keyboardType,
      decoration: InputDecoration(
        labelText: label,
        suffixText: suffix,
        prefixIcon: ExcludeSemantics(child: Icon(icon, size: 20)),
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }

  Future<void> _submitVitals({
    required GlobalKey<FormState> formKey,
    required String hr,
    required String bpSystolic,
    required String bpDiastolic,
    required String temp,
    required String spo2,
    required String rr,
    required String glucose,
    required String pain,
    required String gcs,
    required String consciousness,
  }) async {
    Navigator.of(context).pop();

    final data = buildVitalsRecordPayload(
      patientUid: widget.patientUid,
      hr: hr,
      bpSystolic: bpSystolic,
      bpDiastolic: bpDiastolic,
      temp: temp,
      spo2: spo2,
      rr: rr,
      glucose: glucose,
      pain: pain,
      gcs: gcs,
      consciousness: consciousness,
    );

    if (data.length <= 2) {
      // Only patient_uid and consciousness — no vitals entered
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).vitalsChartAtLeastOne),
            backgroundColor: AppTheme.warningAmber,
          ),
        );
      }
      return;
    }

    try {
      final response = await MedicalApiService.recordEmrVitals(data);
      final news2 = extractNews2Banner(response);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).vitalsChartRecordedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        // Surface the deterioration banner only for an escalation-grade score
        // (>= threshold); routine low scores stay silent to avoid alert fatigue.
        setState(() {
          _latestNews2 = (news2 != null && news2.shouldEscalate) ? news2 : null;
        });
        _loadVitalsHistory();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppStrings.of(context).vitalsChartRecordFailed(e.toString()),
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Record I/O Sheet ──

  void _showRecordIOSheet() {
    final formKey = GlobalKey<FormState>();
    final amount = TextEditingController();
    final description = TextEditingController();
    String ioType = 'intake';
    String category = 'oral';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Container(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(ctx).viewInsets.bottom,
          ),
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Form(
              key: formKey,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 40,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AppTheme.divider,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      AppStrings.of(ctx).vitalsChartRecordIo,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Intake / Output toggle
                    Row(
                      children: [
                        Expanded(
                          child: _ioToggle(
                            label: AppStrings.of(ctx).vitalsChartIntake,
                            icon: Icons.arrow_downward,
                            selected: ioType == 'intake',
                            color: _accentColor,
                            onTap: () => setSheetState(() => ioType = 'intake'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _ioToggle(
                            label: AppStrings.of(ctx).vitalsChartOutput,
                            icon: Icons.arrow_upward,
                            selected: ioType == 'output',
                            color: _warningColor,
                            onTap: () => setSheetState(() => ioType = 'output'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),

                    // Category
                    DropdownButtonFormField<String>(
                      initialValue: category,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(ctx).vitalsChartCategory,
                        border: const OutlineInputBorder(),
                      ),
                      items: ioType == 'intake'
                          ? [
                              DropdownMenuItem(
                                value: 'oral',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartIntakeOral,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'iv',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartIntakeIv,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'blood',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartIntakeBlood,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'ng_tube',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartIntakeNg,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'other',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartCatOther,
                                ),
                              ),
                            ]
                          : [
                              DropdownMenuItem(
                                value: 'urine',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartOutputUrine,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'drain',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartOutputDrain,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'emesis',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartOutputEmesis,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'stool',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartOutputStool,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'blood_loss',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartOutputBloodLoss,
                                ),
                              ),
                              DropdownMenuItem(
                                value: 'other',
                                child: Text(
                                  AppStrings.of(ctx).vitalsChartCatOther,
                                ),
                              ),
                            ],
                      onChanged: (v) =>
                          setSheetState(() => category = v ?? category),
                    ),
                    const SizedBox(height: 12),

                    // Amount
                    TextFormField(
                      controller: amount,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(ctx).vitalsChartAmount,
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.water_drop),
                        ),
                        border: const OutlineInputBorder(),
                      ),
                      validator: (v) => (v == null || v.isEmpty)
                          ? AppStrings.of(ctx).admissionRequired
                          : null,
                    ),
                    const SizedBox(height: 12),

                    // Description
                    TextFormField(
                      controller: description,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(ctx).vitalsChartIoDescription,
                        border: const OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 20),

                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: () {
                          if (!formKey.currentState!.validate()) return;
                          Navigator.of(context).pop();
                          _submitIO(
                            type: ioType,
                            category: category,
                            amount: amount.text,
                            description: description.text,
                          );
                        },
                        icon: const Icon(Icons.save),
                        label: Text(AppStrings.of(ctx).vitalsChartIoRecord),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _ioToggle({
    required String label,
    required IconData icon,
    required bool selected,
    required Color color,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: selected
              ? color.withValues(alpha: 0.12)
              : AppTheme.backgroundGrey,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? color : AppTheme.divider,
            width: selected ? 2 : 1,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              color: selected ? color : AppTheme.textSecondary,
              size: 20,
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: selected ? color : AppTheme.textSecondary,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submitIO({
    required String type,
    required String category,
    required String amount,
    required String description,
  }) async {
    try {
      await MedicalApiService.recordIO(
        buildIORecordPayload(
          patientUid: widget.patientUid,
          type: type,
          category: category,
          amount: amount,
          description: description,
        ),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).vitalsChartIoSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadIOBalance();
        _loadIOHistory();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppStrings.of(context).vitalsChartIoFailed(e.toString()),
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Vitals Data Table (last 24h) ──

  Widget _buildVitalsTable({
    required List<Map<String, dynamic>> rows,
    required bool loading,
    required String emptyText,
    String? error,
    VoidCallback? onRetry,
  }) {
    if (loading) {
      return const SizedBox(
        height: 160,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (error != null) {
      return SizedBox(
        height: 180,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 48, color: _errorColor),
            const SizedBox(height: 12),
            Text(error, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: onRetry,
              child: Text(AppStrings.of(context).vitalsChartRetry),
            ),
          ],
        ),
      );
    }
    if (rows.isEmpty) {
      return SizedBox(
        height: 150,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.monitor_heart, size: 64, color: AppTheme.divider),
            const SizedBox(height: 12),
            Text(emptyText, style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SingleChildScrollView(
        child: DataTable(
          headingRowColor: WidgetStateProperty.all(
            _accentColor.withValues(alpha: _isDark ? 0.18 : 0.08),
          ),
          columnSpacing: 16,
          horizontalMargin: 12,
          dataRowMinHeight: 36,
          dataRowMaxHeight: 44,
          columns: [
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColTime,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColHr,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColBp,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColTemp,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColSpo2,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColRr,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColGlucose,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColPain,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColGcs,
                style: _headerStyle,
              ),
            ),
            DataColumn(
              label: Text(
                AppStrings.of(context).vitalsChartColAvpu,
                style: _headerStyle,
              ),
            ),
          ],
          rows: rows.map((v) {
            final bpSystolic = _firstVitalsValue(v, [
              'systolic_bp',
              'bp_systolic',
            ]);
            final bpDiastolic = _firstVitalsValue(v, [
              'diastolic_bp',
              'bp_diastolic',
            ]);
            final glucose = _firstVitalsValue(v, ['blood_glucose', 'glucose']);
            final gcs = _firstVitalsValue(v, ['gcs_score', 'gcs']);
            return DataRow(
              cells: [
                DataCell(
                  Text(
                    recordDateTimeLabel(v['recorded_at']),
                    style: _cellStyle,
                  ),
                ),
                DataCell(
                  _vitalCell(v['heart_rate'], 60, 100, unit: VitalUnit.pulse),
                ),
                DataCell(
                  Text(
                    bpSystolic != null
                        ? vitalValueWithUnit(
                            '$bpSystolic/${bpDiastolic ?? '-'}',
                            VitalUnit.bp,
                          )
                        : '-',
                    style: _cellStyle,
                  ),
                ),
                DataCell(
                  _vitalCell(
                    v['temperature'],
                    97.0,
                    99.5,
                    isDouble: true,
                    unit: VitalUnit.temperature,
                  ),
                ),
                DataCell(_vitalCell(v['spo2'], 95, 100, unit: VitalUnit.spo2)),
                DataCell(
                  _vitalCell(
                    v['respiratory_rate'],
                    12,
                    20,
                    unit: VitalUnit.respiratoryRate,
                  ),
                ),
                DataCell(_vitalCell(glucose, 70, 180, unit: VitalUnit.cbg)),
                DataCell(
                  Text(
                    v['pain_score'] == null
                        ? '-'
                        : vitalValueWithUnit(v['pain_score'], VitalUnit.pain),
                    style: _cellStyle,
                  ),
                ),
                DataCell(
                  Text(
                    gcs == null ? '-' : vitalValueWithUnit(gcs, VitalUnit.gcs),
                    style: _cellStyle,
                  ),
                ),
                DataCell(
                  Text('${v['consciousness'] ?? '-'}', style: _cellStyle),
                ),
              ],
            );
          }).toList(),
        ),
      ),
    );
  }

  Widget _vitalCell(
    dynamic value,
    num low,
    num high, {
    bool isDouble = false,
    String? unit,
  }) {
    if (value == null) {
      return Text('-', style: _cellStyle);
    }
    final num val = value is num ? value : (num.tryParse('$value') ?? 0);
    Color? color;
    if (val < low || val > high) {
      color = _errorColor;
    }
    final display = isDouble ? val.toStringAsFixed(1) : '$val';
    return Text(
      unit == null ? display : vitalValueWithUnit(display, unit),
      style: TextStyle(
        fontSize: 13,
        fontWeight: color != null ? FontWeight.w600 : FontWeight.w400,
        color: color ?? AppTheme.textPrimary,
      ),
    );
  }

  TextStyle get _headerStyle =>
      TextStyle(fontWeight: FontWeight.w700, fontSize: 12, color: _accentColor);

  TextStyle get _cellStyle =>
      TextStyle(fontSize: 13, color: AppTheme.textPrimary);

  String _formatTime(String? ts) {
    if (ts == null || ts.isEmpty) return '-';
    try {
      final dt = DateTime.parse(ts);
      return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  // ── I/O Balance View ──

  Widget _buildIOSection({bool showRecordButton = true}) {
    if (_ioLoading) {
      return const SizedBox(
        height: 160,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_ioError != null) {
      return SizedBox(
        height: 180,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 48, color: _errorColor),
            const SizedBox(height: 12),
            Text(_ioError!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _loadIOBalance,
              child: Text(AppStrings.of(context).vitalsChartRetry),
            ),
          ],
        ),
      );
    }

    final totalIntake = _ioBalance?['total_intake'] ?? 0;
    final totalOutput = _ioBalance?['total_output'] ?? 0;
    final balance = _ioBalance?['balance'] ?? (totalIntake - totalOutput);
    final entries = _ioBalance?['entries'];
    final entryList = entries is List
        ? entries.map((e) => Map<String, dynamic>.from(e as Map)).toList()
        : <Map<String, dynamic>>[];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Summary cards
        Row(
          children: [
            Expanded(
              child: _ioSummaryCard(
                AppStrings.of(context).vitalsChartIntakeLabel,
                '$totalIntake mL',
                Icons.arrow_downward,
                _accentColor,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _ioSummaryCard(
                AppStrings.of(context).vitalsChartOutputLabel,
                '$totalOutput mL',
                Icons.arrow_upward,
                _warningColor,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _ioSummaryCard(
                AppStrings.of(context).vitalsChartBalanceLabel,
                '${balance >= 0 ? '+' : ''}$balance mL',
                Icons.balance,
                balance >= 0 ? _successColor : _errorColor,
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),

        if (showRecordButton) ...[
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _showRecordIOSheet,
              icon: const Icon(Icons.add),
              label: Text(AppStrings.of(context).vitalsChartRecordIoEntry),
            ),
          ),
          const SizedBox(height: 16),
        ],

        // I/O entries
        if (entryList.isNotEmpty) ...[
          Text(
            AppStrings.of(context).vitalsChartTodayEntries,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
          ),
          const SizedBox(height: 8),
          ...entryList.map(
            (entry) => _buildIOEntryTile(entry, showDate: false),
          ),
        ] else
          Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                AppStrings.of(context).vitalsChartNoIoToday,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildIOEntryTile(
    Map<String, dynamic> entry, {
    required bool showDate,
  }) {
    final isIntake = rowIOType(entry) == 'intake';
    final accent = isIntake ? _accentColor : _warningColor;
    final description = entry['description'];
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: _nestedSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ListTile(
        dense: true,
        leading: CircleAvatar(
          radius: 16,
          backgroundColor: accent.withValues(alpha: 0.15),
          child: Icon(
            isIntake ? Icons.arrow_downward : Icons.arrow_upward,
            size: 16,
            color: accent,
          ),
        ),
        title: Text(
          '${entry['category'] ?? rowIOType(entry)} - ${rowIOAmount(entry)} mL',
          style: TextStyle(fontSize: 13, color: AppTheme.textPrimary),
        ),
        subtitle: description is String && description.isNotEmpty
            ? Text(
                description,
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              )
            : null,
        trailing: Text(
          showDate
              ? rowIODateLabel(entry)
              : _formatTime('${entry['recorded_at'] ?? ''}'),
          style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
        ),
      ),
    );
  }

  Widget _ioSummaryCard(
    String label,
    String value,
    IconData icon,
    Color color,
  ) {
    return Container(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        border: Border.all(color: color.withValues(alpha: 0.18)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 6),
            Text(
              value,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 16,
                color: color,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSection({
    required String title,
    required IconData icon,
    required Widget child,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _sectionSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: _accentColor),
              const SizedBox(width: 8),
              Text(
                title,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }

  Widget _buildQuickActions() {
    final s = AppStrings.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final narrow = constraints.maxWidth < 520;
        final vitalsButton = FilledButton.icon(
          onPressed: _showRecordVitalsSheet,
          icon: const Icon(Icons.add_circle_outline),
          label: Text(s.vitalsChartRecordNow),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          ),
        );
        final ioButton = OutlinedButton.icon(
          onPressed: _showRecordIOSheet,
          icon: const Icon(Icons.water_drop_outlined),
          label: Text(s.vitalsChartRecordIo),
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          ),
        );
        if (narrow) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [vitalsButton, const SizedBox(height: 10), ioButton],
          );
        }
        return Row(
          children: [
            Expanded(child: vitalsButton),
            const SizedBox(width: 12),
            Expanded(child: ioButton),
          ],
        );
      },
    );
  }

  Widget _buildTodayPage() {
    final s = AppStrings.of(context);
    return RefreshIndicator(
      onRefresh: _refreshToday,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _buildQuickActions(),
          const SizedBox(height: 16),
          _buildSection(
            title: s.vitalsChartSectionLast24h,
            icon: Icons.monitor_heart,
            child: _buildVitalsTable(
              rows: _last24hVitals,
              loading: _vitalsLoading,
              error: _vitalsError,
              emptyText: s.vitalsChartNoVitals,
              onRetry: _loadVitalsHistory,
            ),
          ),
          const SizedBox(height: 16),
          _buildSection(
            title: s.vitalsChartSectionIoToday,
            icon: Icons.water_drop,
            child: _buildIOSection(showRecordButton: false),
          ),
        ],
      ),
    );
  }

  Widget _buildPreviousDaysPage() {
    final s = AppStrings.of(context);
    return RefreshIndicator(
      onRefresh: _refreshPreviousDays,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _buildSection(
            title: s.vitalsChartSectionPreviousVitals,
            icon: Icons.history,
            child: _buildVitalsTable(
              rows: _previousVitals,
              loading: _vitalsLoading,
              error: _vitalsError,
              emptyText: s.vitalsChartNoPreviousVitals,
              onRetry: _loadVitalsHistory,
            ),
          ),
          const SizedBox(height: 16),
          _buildSection(
            title: s.vitalsChartSectionPreviousIo,
            icon: Icons.receipt_long,
            child: _buildPreviousIOSection(),
          ),
        ],
      ),
    );
  }

  Widget _buildPreviousIOSection() {
    if (_ioHistoryLoading) {
      return const SizedBox(
        height: 160,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_ioHistoryError != null) {
      return SizedBox(
        height: 180,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 48, color: _errorColor),
            const SizedBox(height: 12),
            Text(_ioHistoryError!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _loadIOHistory,
              child: Text(AppStrings.of(context).vitalsChartRetry),
            ),
          ],
        ),
      );
    }
    final rows = _previousIOEntries;
    if (rows.isEmpty) {
      return SizedBox(
        height: 140,
        child: Center(
          child: Text(
            AppStrings.of(context).vitalsChartNoPreviousIo,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
      );
    }
    return Column(
      children: rows
          .map((entry) => _buildIOEntryTile(entry, showDate: true))
          .toList(),
    );
  }

  ({Color color, String band, String guidance, IconData icon}) _news2Style(
    AppStrings s,
    News2Banner banner,
  ) {
    switch (banner.severity) {
      case 'critical':
        return (
          color: _errorColor,
          band: s.news2BandCritical,
          guidance: s.news2GuidanceCritical,
          icon: Icons.crisis_alert,
        );
      case 'high':
        return (
          color: _warningColor,
          band: s.news2BandHigh,
          guidance: s.news2GuidanceHigh,
          icon: Icons.warning_amber,
        );
      case 'medium':
        return (
          color: _warningColor,
          band: s.news2BandMedium,
          guidance: s.news2GuidanceMedium,
          icon: Icons.info_outline,
        );
      default:
        return (
          color: _successColor,
          band: s.news2BandLow,
          guidance: s.news2GuidanceLow,
          icon: Icons.check_circle_outline,
        );
    }
  }

  void _showNews2Guidance(News2Banner banner) {
    final s = AppStrings.of(context);
    final style = _news2Style(s, banner);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(style.icon, color: style.color),
        title: Text(s.news2GuidanceTitle),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.news2BannerTitle(banner.totalScore, style.band),
              style: TextStyle(fontWeight: FontWeight.w700, color: style.color),
            ),
            const SizedBox(height: 12),
            Text(style.guidance),
            const SizedBox(height: 12),
            Text(
              s.news2BannerNotified,
              style: TextStyle(
                fontStyle: FontStyle.italic,
                color: AppTheme.textSecondary,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(s.actionClose),
          ),
        ],
      ),
    );
  }

  Widget _buildNews2Banner() {
    final banner = _latestNews2;
    if (banner == null) return const SizedBox.shrink();
    final s = AppStrings.of(context);
    final style = _news2Style(s, banner);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: style.color.withValues(alpha: _isDark ? 0.18 : 0.10),
        border: Border.all(color: style.color),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(style.icon, color: style.color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  s.news2BannerTitle(banner.totalScore, style.band),
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                    color: style.color,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 20),
                tooltip: s.news2BannerDismiss,
                onPressed: () => setState(() => _latestNews2 = null),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 32, top: 2),
            child: Text(
              s.news2BannerNotified,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => _showNews2Guidance(banner),
              icon: Icon(Icons.escalator_warning, size: 18, color: style.color),
              label: Text(
                s.news2BannerEscalate,
                style: TextStyle(color: style.color),
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: widget.patientName != null
          ? s.vitalsChartTitleWithName(widget.patientName!)
          : s.vitalsChartTitle,
      body: Column(
        children: [
          Material(
            color: AppTheme.surfaceWhite,
            elevation: 1,
            child: TabBar(
              controller: _tabController,
              labelColor: _accentColor,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: _accentColor,
              tabs: [
                Tab(text: s.vitalsChartTabToday),
                Tab(text: s.vitalsChartTabPreviousDays),
              ],
            ),
          ),
          _buildNews2Banner(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [_buildTodayPage(), _buildPreviousDaysPage()],
            ),
          ),
        ],
      ),
    );
  }
}
