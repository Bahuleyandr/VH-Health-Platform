// "History" section on the Step Challenge screen — a Daily/Weekly/Monthly
// tabbed view. Extracted from step_challenge_screen.dart as its own
// StatefulWidget so it owns the history TabController.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/step_formatters.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StepHistorySection extends StatefulWidget {
  final List<DailyRow> daily;
  final List<WeeklyRow> weekly;
  final List<MonthlyRow> monthly;
  final bool loading;

  const StepHistorySection({
    super.key,
    required this.daily,
    required this.weekly,
    required this.monthly,
    required this.loading,
  });

  @override
  State<StepHistorySection> createState() => _StepHistorySectionState();
}

class _StepHistorySectionState extends State<StepHistorySection>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'History',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        const SizedBox(height: 8),
        TabBar(
          controller: _tabController,
          labelColor: const Color(0xFF4CAF50),
          unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
          indicatorColor: const Color(0xFF4CAF50),
          tabs: const [
            Tab(text: 'Daily'),
            Tab(text: 'Weekly'),
            Tab(text: 'Monthly'),
          ],
        ),
        SizedBox(
          height: 280,
          child: widget.loading
              ? const Center(child: CircularProgressIndicator())
              : TabBarView(
                  controller: _tabController,
                  children: [
                    _buildDailyList(),
                    _buildWeeklyList(),
                    _buildMonthlyList(),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _buildDailyList() {
    if (widget.daily.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoDailyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: widget.daily.length,
      itemBuilder: (ctx, i) {
        final row = widget.daily[i];
        return _historyTile(
          title: row.date,
          steps: row.steps,
          distanceMeters: row.distanceMeters,
          subtitle: null,
        );
      },
    );
  }

  Widget _buildWeeklyList() {
    if (widget.weekly.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoWeeklyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: widget.weekly.length,
      itemBuilder: (ctx, i) {
        final row = widget.weekly[i];
        return _historyTile(
          title: 'Week of ${row.weekStart}',
          steps: row.avgSteps,
          distanceMeters: row.avgDistanceMeters,
          subtitle: 'avg/day',
        );
      },
    );
  }

  Widget _buildMonthlyList() {
    if (widget.monthly.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoMonthlyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: widget.monthly.length,
      itemBuilder: (ctx, i) {
        final row = widget.monthly[i];
        return _historyTile(
          title: row.month,
          steps: row.avgSteps,
          distanceMeters: row.avgDistanceMeters,
          subtitle: 'avg/day',
        );
      },
    );
  }

  Widget _historyTile({
    required String title,
    required int steps,
    required double distanceMeters,
    required String? subtitle,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
                if (subtitle != null)
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 11, color: Colors.grey),
                  ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '$steps steps',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF4CAF50),
                ),
              ),
              Text(
                stepDistKm(distanceMeters),
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
