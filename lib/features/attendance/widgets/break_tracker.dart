import 'package:flutter/material.dart';
import '../../../core/services/staff_api_service.dart';

class BreakTracker extends StatefulWidget {
  final String staffId;
  final bool checkedIn;
  const BreakTracker({super.key, required this.staffId, required this.checkedIn});

  @override
  State<BreakTracker> createState() => _BreakTrackerState();
}

class _BreakTrackerState extends State<BreakTracker> {
  List<dynamic> _breaks = [];
  int _totalBreakMinutes = 0;
  bool _onBreak = false;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadBreaks();
  }

  Future<void> _loadBreaks() async {
    try {
      final data = await StaffApiService.getTodayBreaks(widget.staffId);
      if (mounted) {
        setState(() {
          _breaks = data['breaks'] as List? ?? [];
          _totalBreakMinutes = (data['totalBreakMinutes'] as num?)?.toInt() ?? 0;
          _onBreak = _breaks.any((b) => b['break_end'] == null);
        });
      }
    } catch (e) { debugPrint('break_tracker.dart: $e'); }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.checkedIn) return const SizedBox.shrink();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              const Icon(Icons.coffee_outlined, size: 18, color: Colors.brown),
              const SizedBox(width: 8),
              const Text('Breaks', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              const Spacer(),
              Text('${_totalBreakMinutes}min total', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            ]),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _loading ? null : () => _toggleBreak(),
                icon: Icon(_onBreak ? Icons.play_arrow : Icons.pause, size: 16),
                label: Text(_onBreak ? 'End Break' : 'Take a Break'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: _onBreak ? Colors.green : Colors.brown,
                  side: BorderSide(color: _onBreak ? Colors.green : Colors.brown),
                ),
              ),
            ),
            if (_breaks.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...(_breaks.map((b) {
                final start = b['break_start'] as String? ?? '';
                final end = b['break_end'] as String? ?? '';
                final dur = b['duration_minutes_calc'] ?? b['duration_minutes'];
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(children: [
                    const Icon(Icons.fiber_manual_record, size: 8, color: Colors.grey),
                    const SizedBox(width: 4),
                    Text(
                      start.length >= 16 ? start.substring(11, 16) : '',
                      style: const TextStyle(fontSize: 11),
                    ),
                    if (end.isNotEmpty) Text(' – ${end.substring(11, 16)}', style: const TextStyle(fontSize: 11)),
                    if (dur != null) Text(' (${(dur as num).round()}min)', style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                    if (end.isEmpty) const Text(' (ongoing)', style: TextStyle(fontSize: 11, color: Colors.orange)),
                  ]),
                );
              })),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _toggleBreak() async {
    setState(() => _loading = true);
    try {
      if (_onBreak) {
        await StaffApiService.endBreak(widget.staffId);
      } else {
        await StaffApiService.startBreak(widget.staffId);
      }
      await _loadBreaks();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }
}
