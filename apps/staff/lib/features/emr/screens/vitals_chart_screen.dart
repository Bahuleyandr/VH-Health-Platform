import 'package:flutter/material.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
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

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadVitalsHistory();
    _loadIOBalance();
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
      // Load HR trend as a proxy — the backend returns last 24h records
      final data = await MedicalApiService.getVitalsTrend(
        widget.patientUid,
        'all',
      );
      final list = data['vitals'] ?? data['records'] ?? data['trend'];
      setState(() {
        _vitalsHistory = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
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
    String consciousness = 'Alert';

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
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
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
                    SizedBox(height: 16),
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
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 8),
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
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _vitalField(
                            glucose,
                            AppStrings.of(ctx).vitalsChartGlucose,
                            Icons.water_drop,
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
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _vitalField(
                            gcs,
                            AppStrings.of(ctx).vitalsChartGcs,
                            Icons.psychology,
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
                      items: [
                        DropdownMenuItem(
                          value: 'Alert',
                          child: Text(
                            AppStrings.of(ctx).vitalsChartConsciousAlert,
                          ),
                        ),
                        DropdownMenuItem(
                          value: 'Verbal',
                          child: Text(
                            AppStrings.of(ctx).vitalsChartConsciousVerbal,
                          ),
                        ),
                        DropdownMenuItem(
                          value: 'Pain',
                          child: Text(
                            AppStrings.of(ctx).vitalsChartConsciousPain,
                          ),
                        ),
                        DropdownMenuItem(
                          value: 'Unresponsive',
                          child: Text(
                            AppStrings.of(ctx).vitalsChartConsciousUnresp,
                          ),
                        ),
                      ],
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
    TextInputType? keyboardType,
  }) {
    return TextFormField(
      controller: controller,
      keyboardType: keyboardType,
      decoration: InputDecoration(
        labelText: label,
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

    final data = <String, dynamic>{
      'patient_uid': widget.patientUid,
      if (hr.isNotEmpty) 'heart_rate': int.tryParse(hr),
      if (bpSystolic.isNotEmpty) 'bp_systolic': int.tryParse(bpSystolic),
      if (bpDiastolic.isNotEmpty) 'bp_diastolic': int.tryParse(bpDiastolic),
      if (temp.isNotEmpty) 'temperature': double.tryParse(temp),
      if (spo2.isNotEmpty) 'spo2': int.tryParse(spo2),
      if (rr.isNotEmpty) 'respiratory_rate': int.tryParse(rr),
      if (glucose.isNotEmpty) 'glucose': int.tryParse(glucose),
      if (pain.isNotEmpty) 'pain_score': int.tryParse(pain),
      if (gcs.isNotEmpty) 'gcs': int.tryParse(gcs),
      'consciousness': consciousness,
    };

    // Remove null values from parsing failures
    data.removeWhere((_, v) => v == null);

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
      await MedicalApiService.recordEmrVitals(data);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).vitalsChartRecordedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
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
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
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
                    SizedBox(height: 16),
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
                            color: AppTheme.primaryBlue,
                            onTap: () => setSheetState(() => ioType = 'intake'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _ioToggle(
                            label: AppStrings.of(ctx).vitalsChartOutput,
                            icon: Icons.arrow_upward,
                            selected: ioType == 'output',
                            color: AppTheme.warningAmber,
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
        padding: EdgeInsets.symmetric(vertical: 14),
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
            SizedBox(width: 6),
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
      await MedicalApiService.recordIO({
        'patient_uid': widget.patientUid,
        'type': type,
        'category': category,
        'amount_ml': int.tryParse(amount) ?? 0,
        if (description.isNotEmpty) 'description': description,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).vitalsChartIoSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadIOBalance();
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

  Widget _buildVitalsTable() {
    if (_vitalsLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_vitalsError != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 12),
            Text(_vitalsError!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _loadVitalsHistory,
              child: Text(AppStrings.of(context).vitalsChartRetry),
            ),
          ],
        ),
      );
    }
    if (_vitalsHistory.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.monitor_heart, size: 64, color: AppTheme.divider),
            SizedBox(height: 12),
            Text(
              AppStrings.of(context).vitalsChartNoVitals,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SingleChildScrollView(
        child: DataTable(
          headingRowColor: WidgetStateProperty.all(
            AppTheme.primaryBlue.withValues(alpha: 0.06),
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
          rows: _vitalsHistory.map((v) {
            return DataRow(
              cells: [
                DataCell(
                  Text(
                    _formatTime(v['recorded_at'] as String?),
                    style: _cellStyle,
                  ),
                ),
                DataCell(_vitalCell(v['heart_rate'], 60, 100)),
                DataCell(
                  Text(
                    v['bp_systolic'] != null
                        ? '${v['bp_systolic']}/${v['bp_diastolic'] ?? '-'}'
                        : '-',
                    style: _cellStyle,
                  ),
                ),
                DataCell(
                  _vitalCell(v['temperature'], 97.0, 99.5, isDouble: true),
                ),
                DataCell(_vitalCell(v['spo2'], 95, 100)),
                DataCell(_vitalCell(v['respiratory_rate'], 12, 20)),
                DataCell(_vitalCell(v['glucose'], 70, 180)),
                DataCell(Text('${v['pain_score'] ?? '-'}', style: _cellStyle)),
                DataCell(Text('${v['gcs'] ?? '-'}', style: _cellStyle)),
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

  Widget _vitalCell(dynamic value, num low, num high, {bool isDouble = false}) {
    if (value == null) {
      return const Text('-', style: _cellStyle);
    }
    final num val = value is num ? value : (num.tryParse('$value') ?? 0);
    Color? color;
    if (val < low || val > high) {
      color = AppTheme.errorRed;
    }
    final display = isDouble ? val.toStringAsFixed(1) : '$val';
    return Text(
      display,
      style: TextStyle(
        fontSize: 13,
        fontWeight: color != null ? FontWeight.w600 : FontWeight.w400,
        color: color ?? AppTheme.textPrimary,
      ),
    );
  }

  static const _headerStyle = TextStyle(
    fontWeight: FontWeight.w600,
    fontSize: 12,
    color: AppTheme.primaryBlue,
  );

  static const _cellStyle = TextStyle(fontSize: 13);

  String _formatTime(String? ts) {
    if (ts == null) return '-';
    try {
      final dt = DateTime.parse(ts);
      return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  // ── I/O Balance View ──

  Widget _buildIOSection() {
    if (_ioLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_ioError != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
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

    return SingleChildScrollView(
      padding: const EdgeInsets.all(12),
      child: Column(
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
                  AppTheme.primaryBlue,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _ioSummaryCard(
                  AppStrings.of(context).vitalsChartOutputLabel,
                  '$totalOutput mL',
                  Icons.arrow_upward,
                  AppTheme.warningAmber,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _ioSummaryCard(
                  AppStrings.of(context).vitalsChartBalanceLabel,
                  '${balance >= 0 ? '+' : ''}$balance mL',
                  Icons.balance,
                  balance >= 0 ? AppTheme.successGreen : AppTheme.errorRed,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Record I/O button
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _showRecordIOSheet,
              icon: const Icon(Icons.add),
              label: Text(AppStrings.of(context).vitalsChartRecordIoEntry),
            ),
          ),
          const SizedBox(height: 16),

          // I/O entries
          if (entryList.isNotEmpty) ...[
            Text(
              AppStrings.of(context).vitalsChartTodayEntries,
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
            ),
            const SizedBox(height: 8),
            ...entryList.map((entry) {
              final isIntake =
                  (entry['type'] as String?)?.toLowerCase() == 'intake';
              return Card(
                margin: const EdgeInsets.only(bottom: 6),
                child: ListTile(
                  dense: true,
                  leading: CircleAvatar(
                    radius: 16,
                    backgroundColor:
                        (isIntake
                                ? AppTheme.primaryBlue
                                : AppTheme.warningAmber)
                            .withValues(alpha: 0.15),
                    child: Icon(
                      isIntake ? Icons.arrow_downward : Icons.arrow_upward,
                      size: 16,
                      color: isIntake
                          ? AppTheme.primaryBlue
                          : AppTheme.warningAmber,
                    ),
                  ),
                  title: Text(
                    '${entry['category'] ?? entry['type']} - ${entry['amount_ml'] ?? entry['amount']} mL',
                    style: const TextStyle(fontSize: 13),
                  ),
                  subtitle: entry['description'] != null
                      ? Text(
                          entry['description'] as String,
                          style: const TextStyle(fontSize: 12),
                        )
                      : null,
                  trailing: Text(
                    _formatTime(entry['recorded_at'] as String?),
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ),
              );
            }),
          ] else
            Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  AppStrings.of(context).vitalsChartNoIoToday,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _ioSummaryCard(
    String label,
    String value,
    IconData icon,
    Color color,
  ) {
    return Card(
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
            SizedBox(height: 2),
            Text(
              label,
              style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }

  // ── Record Vitals Quick Entry Tab ──

  Widget _buildRecordTab() {
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.monitor_heart,
              size: 80,
              color: AppTheme.primaryBlue.withValues(alpha: 0.3),
            ),
            const SizedBox(height: 20),
            Text(
              widget.patientName != null
                  ? s.vitalsChartRecordForName(widget.patientName!)
                  : s.vitalsChartRecordPatient,
              style: TextStyle(fontSize: 16, color: AppTheme.textSecondary),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _showRecordVitalsSheet,
              icon: const Icon(Icons.add_circle_outline),
              label: Text(s.vitalsChartRecordNow),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 14,
                ),
              ),
            ),
          ],
        ),
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
            color: Colors.white,
            elevation: 1,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: [
                Tab(text: s.vitalsChartTabRecord),
                Tab(text: s.vitalsChartTabLast24h),
                Tab(text: s.vitalsChartTabIoBalance),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildRecordTab(),
                RefreshIndicator(
                  onRefresh: _loadVitalsHistory,
                  child: _buildVitalsTable(),
                ),
                RefreshIndicator(
                  onRefresh: _loadIOBalance,
                  child: _buildIOSection(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
