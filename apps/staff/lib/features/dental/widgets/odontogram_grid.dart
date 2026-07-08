import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../models/dental_models.dart';

class OdontogramGrid extends StatelessWidget {
  final DentalChart? chart;
  final String? selectedTooth;
  final ValueChanged<String> onToothSelected;

  const OdontogramGrid({
    super.key,
    required this.chart,
    required this.selectedTooth,
    required this.onToothSelected,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.clamp(320.0, 980.0);
        final tile = ((width - 30) / 16).clamp(30.0, 52.0);
        return Center(
          child: CustomPaint(
            painter: _OdontogramGridPainter(
              dividerColor: AppTheme.divider,
              archColor: AppTheme.primaryBlue.withValues(alpha: 0.08),
            ),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildRow(FdiToothLayout.permanentUpper, tile),
                  const SizedBox(height: 8),
                  _buildRow(FdiToothLayout.permanentLower, tile),
                  const SizedBox(height: 14),
                  _buildRow(FdiToothLayout.deciduousUpper, tile),
                  const SizedBox(height: 8),
                  _buildRow(FdiToothLayout.deciduousLower, tile),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildRow(List<String> teeth, double tileSize) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final tooth in teeth) ...[
          _ToothTile(
            key: ValueKey('dental-tooth-$tooth'),
            tooth: tooth,
            size: tileSize,
            summary: chart?.summaryFor(tooth),
            selected: selectedTooth == tooth,
            onTap: () => onToothSelected(tooth),
          ),
          if (_midlineAfter(tooth)) const SizedBox(width: 10),
        ],
      ],
    );
  }

  bool _midlineAfter(String tooth) {
    return tooth == '11' || tooth == '41' || tooth == '51' || tooth == '81';
  }
}

class _ToothTile extends StatelessWidget {
  final String tooth;
  final double size;
  final DentalToothSummary? summary;
  final bool selected;
  final VoidCallback onTap;

  const _ToothTile({
    super.key,
    required this.tooth,
    required this.size,
    required this.summary,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final findingCount = summary?.findings.length ?? 0;
    final procedureCount = summary?.procedures.length ?? 0;
    final hasFinding = findingCount > 0;
    final hasProcedure = procedureCount > 0;
    final color = hasFinding
        ? AppTheme.errorRed
        : hasProcedure
        ? AppTheme.successGreen
        : AppTheme.cardSurface;
    final textColor = hasFinding || hasProcedure
        ? Colors.white
        : AppTheme.textPrimary;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Semantics(
        button: true,
        label: 'Tooth $tooth',
        selected: selected,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(7),
            onTap: onTap,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              width: size,
              height: size,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(7),
                border: Border.all(
                  width: selected ? 2.5 : 1,
                  color: selected ? AppTheme.primaryBlue : AppTheme.divider,
                ),
                boxShadow: selected
                    ? [
                        BoxShadow(
                          color: AppTheme.primaryBlue.withValues(alpha: 0.22),
                          blurRadius: 10,
                        ),
                      ]
                    : null,
              ),
              child: Stack(
                alignment: Alignment.center,
                children: [
                  Text(
                    tooth,
                    style: TextStyle(
                      color: textColor,
                      fontWeight: FontWeight.w700,
                      fontSize: size < 36 ? 11 : 13,
                    ),
                  ),
                  if (findingCount + procedureCount > 0)
                    Positioned(
                      right: 3,
                      bottom: 2,
                      child: Text(
                        '${findingCount + procedureCount}',
                        style: TextStyle(
                          color: textColor,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _OdontogramGridPainter extends CustomPainter {
  final Color dividerColor;
  final Color archColor;

  const _OdontogramGridPainter({
    required this.dividerColor,
    required this.archColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = archColor
      ..style = PaintingStyle.fill;
    final stroke = Paint()
      ..color = dividerColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;

    final outer = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(12),
    );
    canvas.drawRRect(outer, paint);
    canvas.drawRRect(outer, stroke);

    final midX = size.width / 2;
    canvas.drawLine(Offset(midX, 8), Offset(midX, size.height - 8), stroke);
    canvas.drawLine(
      Offset(8, size.height / 2),
      Offset(size.width - 8, size.height / 2),
      stroke,
    );
  }

  @override
  bool shouldRepaint(covariant _OdontogramGridPainter oldDelegate) {
    return oldDelegate.dividerColor != dividerColor ||
        oldDelegate.archColor != archColor;
  }
}
