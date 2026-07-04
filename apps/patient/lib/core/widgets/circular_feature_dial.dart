import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:vhhealth/core/widgets/heartbeat_logo.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class FeatureIconData {
  final IconData icon;
  final String label;
  final void Function(BuildContext) onTap;
  final Color color;
  final bool hasNew;
  final String? badge;
  final String? description;
  final String? svgAsset;

  FeatureIconData({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.color,
    this.hasNew = false,
    this.badge,
    this.description,
    this.svgAsset,
  });
}

class CircularFeatureDial extends StatefulWidget {
  final List<FeatureIconData> features;
  final VoidCallback? onCenterDoubleTap;
  final void Function(Color)? onFocusColorChanged;
  final double? size;
  final bool enableHaptics;
  final bool autoRotateToTop;
  final bool enableParticles;
  final bool enableAccessibility;
  final double iconScale;

  const CircularFeatureDial({
    super.key,
    required this.features,
    this.onCenterDoubleTap,
    this.onFocusColorChanged,
    this.size,
    this.enableHaptics = true,
    this.autoRotateToTop = true,
    this.enableParticles = false,
    this.enableAccessibility = true,
    this.iconScale = 1.0,
  });

  @override
  State<CircularFeatureDial> createState() => _CircularFeatureDialState();
}

class _CircularFeatureDialState extends State<CircularFeatureDial>
    with TickerProviderStateMixin {
  int? selectedIndex;
  int? hoveredIndex;
  double _rotation = 0;
  double? _lastPanAngle;

  late AnimationController _tapController;
  late AnimationController _snapController;
  late List<FeatureIconData> _reorderedFeatures;

  @override
  void initState() {
    super.initState();
    _reorderedFeatures = _getReordered();
    _tapController = AnimationController(
      duration: const Duration(milliseconds: 260),
      vsync: this,
    );
    _snapController = AnimationController(
      duration: const Duration(milliseconds: 620),
      vsync: this,
    );

    if (widget.onFocusColorChanged != null && _reorderedFeatures.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onFocusColorChanged!(_reorderedFeatures[0].color);
      });
    }
  }

  @override
  void didUpdateWidget(CircularFeatureDial oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.features != widget.features) {
      _reorderedFeatures = _getReordered();
      selectedIndex = null;
      hoveredIndex = null;
      _rotation = 0;
    }
  }

  @override
  void dispose() {
    _tapController.dispose();
    _snapController.dispose();
    super.dispose();
  }

  List<FeatureIconData> _getReordered() {
    if (widget.features.isEmpty) return [];
    final healthIndex = widget.features.indexWhere(
      (f) => f.label.toLowerCase().contains('health'),
    );
    if (healthIndex <= 0) return List<FeatureIconData>.from(widget.features);
    final reordered = List<FeatureIconData>.from(widget.features);
    final healthFeature = reordered.removeAt(healthIndex);
    reordered.insert(0, healthFeature);
    return reordered;
  }

  void _onFeatureTap(int index, FeatureIconData feature) {
    if (widget.enableHaptics) HapticFeedback.selectionClick();
    setState(() => selectedIndex = index);
    _tapController
      ..reset()
      ..forward().then((_) {
        if (mounted) _tapController.reverse();
      });
    widget.onFocusColorChanged?.call(feature.color);
    feature.onTap(context);
  }

  void _onCenterDoubleTap() {
    widget.onCenterDoubleTap?.call();
  }

  double _angleForLocalPosition(Offset localPosition, double diameter) {
    final center = Offset(diameter / 2, diameter / 2);
    final delta = localPosition - center;
    return atan2(delta.dy, delta.dx);
  }

  double _shortestAngleDelta(double from, double to) {
    var delta = to - from;
    while (delta > pi) {
      delta -= 2 * pi;
    }
    while (delta < -pi) {
      delta += 2 * pi;
    }
    return delta;
  }

  void _startDrag(DragStartDetails details, double diameter) {
    _snapController.stop();
    _lastPanAngle = _angleForLocalPosition(details.localPosition, diameter);
  }

  void _updateDrag(DragUpdateDetails details, double diameter) {
    final nextAngle = _angleForLocalPosition(details.localPosition, diameter);
    final previousAngle = _lastPanAngle;
    if (previousAngle == null) {
      _lastPanAngle = nextAngle;
      return;
    }
    final delta = _shortestAngleDelta(previousAngle, nextAngle);
    setState(() => _rotation += delta);
    _lastPanAngle = nextAngle;
  }

  void _endDrag() {
    _lastPanAngle = null;
    if (!widget.autoRotateToTop || _rotation.abs() < 0.002) {
      return;
    }

    final start = _rotation;
    _snapController
      ..stop()
      ..reset();
    final animation = CurvedAnimation(
      parent: _snapController,
      curve: Curves.easeOutBack,
    );
    void listener() {
      if (!mounted) return;
      setState(() => _rotation = start * (1 - animation.value));
    }

    animation.addListener(listener);
    _snapController.forward().whenComplete(() {
      animation.removeListener(listener);
      if (mounted) setState(() => _rotation = 0);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_reorderedFeatures.isEmpty) {
      return Center(
        child: Text(AppLocalizations.of(context)!.circularDialNoFeatures),
      );
    }

    final theme = Theme.of(context);
    final screenSize = MediaQuery.sizeOf(context);

    return LayoutBuilder(
      builder: (context, constraints) {
        final availableWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : screenSize.width;
        final baseWidth = min(availableWidth, screenSize.width);
        final targetDiameter =
            widget.size ??
            baseWidth.clamp(320.0, 430.0) * (baseWidth >= 700 ? 0.92 : 0.98);
        final diameter = min(
          targetDiameter,
          availableWidth,
        ).clamp(300.0, 430.0);
        final radius = diameter * 0.36;
        final iconScale = widget.iconScale.clamp(1.0, 1.2).toDouble();
        final itemSize = (diameter * 0.19).clamp(64.0, 82.0) * iconScale;

        return Center(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onPanStart: (details) => _startDrag(details, diameter),
            onPanUpdate: (details) => _updateDrag(details, diameter),
            onPanEnd: (_) => _endDrag(),
            onPanCancel: _endDrag,
            child: SizedBox(
              width: diameter,
              height: diameter,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  CustomPaint(
                    size: Size.square(diameter),
                    painter: _DialPlatePainter(
                      colorScheme: theme.colorScheme,
                      brightness: theme.brightness,
                      itemCount: _reorderedFeatures.length,
                    ),
                  ),
                  Transform.rotate(
                    angle: _rotation,
                    child: SizedBox.square(
                      dimension: diameter,
                      child: Stack(
                        alignment: Alignment.center,
                        children: _buildFeatureItems(
                          diameter,
                          radius,
                          itemSize,
                          theme,
                        ),
                      ),
                    ),
                  ),
                  _CenterLogoButton(
                    onDoubleTap: _onCenterDoubleTap,
                    iconScale: iconScale,
                  ),
                  Positioned(
                    top: diameter * 0.035,
                    child: Container(
                      width: 52,
                      height: 5,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary.withValues(alpha: 0.9),
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: [
                          BoxShadow(
                            color: theme.colorScheme.primary.withValues(
                              alpha: 0.35,
                            ),
                            blurRadius: 10,
                            offset: const Offset(0, 2),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  List<Widget> _buildFeatureItems(
    double diameter,
    double radius,
    double itemSize,
    ThemeData theme,
  ) {
    final itemCount = _reorderedFeatures.length;
    final angleStep = (2 * pi) / itemCount;

    return List.generate(itemCount, (index) {
      final angle = -pi / 2 + (angleStep * index);
      final x = radius * cos(angle);
      final y = radius * sin(angle);
      final feature = _reorderedFeatures[index];
      final isSelected = index == selectedIndex;
      final isHovered = index == hoveredIndex;
      final isTopItem = index == 0;

      return Positioned(
        left: diameter / 2 + x - itemSize / 2,
        top: diameter / 2 + y - itemSize / 2,
        width: itemSize,
        height: itemSize,
        child: Transform.rotate(
          angle: -_rotation,
          child: MouseRegion(
            onEnter: (_) => setState(() => hoveredIndex = index),
            onExit: (_) => setState(() => hoveredIndex = null),
            child: GestureDetector(
              onTap: () => _onFeatureTap(index, feature),
              onLongPress: widget.enableAccessibility
                  ? () {
                      _showFeatureDescription(feature);
                    }
                  : null,
              child: AnimatedBuilder(
                animation: _tapController,
                builder: (context, child) {
                  final tapScale = isSelected
                      ? 1 + (_tapController.value * 0.12)
                      : 1.0;
                  final hoverScale = isHovered ? 1.06 : 1.0;
                  return Transform.scale(
                    scale: tapScale * hoverScale * (isTopItem ? 1.05 : 1.0),
                    child: child,
                  );
                },
                child: _FeatureDialButton(
                  feature: feature,
                  isHighlighted: isSelected || isHovered || isTopItem,
                  iconScale: widget.iconScale,
                ),
              ),
            ),
          ),
        ),
      );
    });
  }

  void _showFeatureDescription(FeatureIconData feature) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Row(
          children: [
            Icon(feature.icon, color: feature.color),
            const SizedBox(width: 8),
            Flexible(child: Text(feature.label)),
          ],
        ),
        content: Text(feature.description ?? 'Tap to access ${feature.label}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.pop(context);
              feature.onTap(context);
            },
            style: FilledButton.styleFrom(backgroundColor: feature.color),
            child: const Text('Open'),
          ),
        ],
      ),
    );
  }
}

class _FeatureDialButton extends StatelessWidget {
  final FeatureIconData feature;
  final bool isHighlighted;
  final double iconScale;

  const _FeatureDialButton({
    required this.feature,
    required this.isHighlighted,
    required this.iconScale,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isLight = theme.brightness == Brightness.light;
    final foreground = _strongColor(feature.color, isLight);
    final surface = theme.colorScheme.surface;
    final labelColor = foreground;
    final scale = iconScale.clamp(1.0, 1.2).toDouble();
    final iconBubbleSize = 32.0 * scale;
    final iconSize = 29.0 * scale;
    final label = _dialLabel(feature.label);

    return Semantics(
      button: true,
      label: feature.label,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            center: Alignment.topLeft,
            radius: 1.05,
            colors: [
              surface.withValues(alpha: isLight ? 1 : 0.92),
              feature.color.withValues(alpha: isLight ? 0.28 : 0.24),
              surface.withValues(alpha: isLight ? 0.94 : 0.78),
            ],
          ),
          border: Border.all(
            color: isHighlighted
                ? foreground
                : feature.color.withValues(alpha: isLight ? 0.42 : 0.28),
            width: isHighlighted ? 2.2 : 1.1,
          ),
          boxShadow: [
            BoxShadow(
              color: feature.color.withValues(
                alpha: isHighlighted
                    ? (isLight ? 0.32 : 0.25)
                    : (isLight ? 0.16 : 0.10),
              ),
              blurRadius: isHighlighted ? 16 : 10,
              offset: const Offset(0, 5),
            ),
          ],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Stack(
              clipBehavior: Clip.none,
              alignment: Alignment.center,
              children: [
                Container(
                  width: iconBubbleSize,
                  height: iconBubbleSize,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      center: Alignment.topLeft,
                      radius: 1.15,
                      colors: [
                        Colors.white.withValues(alpha: isLight ? 0.96 : 0.30),
                        feature.color.withValues(alpha: isLight ? 0.16 : 0.18),
                        Colors.black.withValues(alpha: isLight ? 0.03 : 0.14),
                      ],
                    ),
                    border: Border.all(
                      color: Colors.white.withValues(
                        alpha: isLight ? 0.80 : 0.22,
                      ),
                      width: 1,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: feature.color.withValues(
                          alpha: isHighlighted ? 0.26 : 0.14,
                        ),
                        blurRadius: isHighlighted ? 12 : 7,
                        offset: const Offset(0, 3),
                      ),
                    ],
                  ),
                  child: feature.svgAsset != null
                      ? SvgPicture.asset(
                          feature.svgAsset!,
                          width: iconSize,
                          height: iconSize,
                          fit: BoxFit.contain,
                        )
                      : Icon(feature.icon, size: iconSize, color: foreground),
                ),
                if (feature.badge != null)
                  Positioned(
                    right: -7,
                    top: -7,
                    child: _Badge(text: feature.badge!),
                  ),
                if (feature.hasNew)
                  Positioned(
                    right: -1,
                    top: -1,
                    child: _NewDot(borderColor: surface),
                  ),
              ],
            ),
            const SizedBox(height: 2),
            SizedBox(
              height: 22 * scale,
              width: double.infinity,
              child: Center(
                child: Text(
                  label,
                  maxLines: 2,
                  softWrap: true,
                  overflow: TextOverflow.visible,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: labelColor,
                    fontWeight: isHighlighted
                        ? FontWeight.w900
                        : FontWeight.w800,
                    fontSize: 8.9 * scale,
                    height: 0.98,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _dialLabel(String label) {
  return switch (label) {
    'Appointments' => 'Appoint-\nments',
    'Departments' => 'Depart-\nments',
    'Tests & Reports' => 'Tests &\nReports',
    'Ask a Doubt' => 'Ask a\nDoubt',
    _ => label,
  };
}

class _CenterLogoButton extends StatelessWidget {
  final VoidCallback onDoubleTap;
  final double iconScale;

  const _CenterLogoButton({required this.onDoubleTap, required this.iconScale});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isLight = theme.brightness == Brightness.light;
    final scale = iconScale.clamp(1.0, 1.2).toDouble();
    final buttonSize = 110.0 * scale;
    final progressSize = 94.0 * scale;
    final logoSize = 82.0 * scale;

    return Tooltip(
      message: 'Health Hub',
      child: Semantics(
        button: true,
        label: 'Health Hub',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onDoubleTap,
          onDoubleTap: onDoubleTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            width: buttonSize,
            height: buttonSize,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  theme.colorScheme.surface,
                  theme.colorScheme.primaryContainer.withValues(
                    alpha: isLight ? 0.88 : 0.34,
                  ),
                ],
              ),
              border: Border.all(
                color: theme.colorScheme.primary.withValues(alpha: 0.36),
                width: 1.5,
              ),
              boxShadow: [
                BoxShadow(
                  color: theme.colorScheme.primary.withValues(
                    alpha: isLight ? 0.20 : 0.30,
                  ),
                  blurRadius: 28,
                  offset: const Offset(0, 10),
                ),
                BoxShadow(
                  color: Colors.black.withValues(alpha: isLight ? 0.08 : 0.26),
                  blurRadius: 16,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Stack(
              alignment: Alignment.center,
              children: [
                SizedBox(
                  width: progressSize,
                  height: progressSize,
                  child: CircularProgressIndicator(
                    value: 0.72,
                    strokeWidth: 3,
                    backgroundColor: theme.colorScheme.primary.withValues(
                      alpha: 0.10,
                    ),
                    valueColor: AlwaysStoppedAnimation<Color>(
                      theme.colorScheme.primary,
                    ),
                  ),
                ),
                SizedBox(
                  width: logoSize,
                  height: logoSize,
                  child: const HeartbeatLogo(),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DialPlatePainter extends CustomPainter {
  final ColorScheme colorScheme;
  final Brightness brightness;
  final int itemCount;

  const _DialPlatePainter({
    required this.colorScheme,
    required this.brightness,
    required this.itemCount,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final outerRadius = size.shortestSide / 2;
    final isLight = brightness == Brightness.light;
    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = colorScheme.primary.withValues(alpha: isLight ? 0.18 : 0.24);
    final softRingPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 18
      ..color = colorScheme.primary.withValues(alpha: isLight ? 0.035 : 0.06);
    final fillPaint = Paint()
      ..shader = RadialGradient(
        colors: [
          colorScheme.primary.withValues(alpha: isLight ? 0.08 : 0.13),
          colorScheme.secondary.withValues(alpha: isLight ? 0.035 : 0.08),
          Colors.transparent,
        ],
      ).createShader(Rect.fromCircle(center: center, radius: outerRadius));

    canvas.drawCircle(center, outerRadius * 0.49, softRingPaint);
    canvas.drawCircle(center, outerRadius * 0.92, fillPaint);
    canvas.drawCircle(center, outerRadius * 0.42, ringPaint);
    canvas.drawCircle(center, outerRadius * 0.66, ringPaint);
    canvas.drawCircle(center, outerRadius * 0.87, ringPaint);

    final tickPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 3
      ..color = colorScheme.primary.withValues(alpha: isLight ? 0.26 : 0.36);
    final dotPaint = Paint()
      ..style = PaintingStyle.fill
      ..color = colorScheme.secondary.withValues(alpha: isLight ? 0.18 : 0.30);

    for (var i = 0; i < itemCount; i++) {
      final angle = -pi / 2 + ((2 * pi) / itemCount) * i;
      final start =
          center + Offset(cos(angle), sin(angle)) * (outerRadius * 0.73);
      final end =
          center + Offset(cos(angle), sin(angle)) * (outerRadius * 0.79);
      canvas.drawLine(start, end, tickPaint);

      final dot =
          center +
          Offset(cos(angle + pi / itemCount), sin(angle + pi / itemCount)) *
              (outerRadius * 0.535);
      canvas.drawCircle(dot, 2.4, dotPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _DialPlatePainter oldDelegate) {
    return oldDelegate.colorScheme != colorScheme ||
        oldDelegate.brightness != brightness ||
        oldDelegate.itemCount != itemCount;
  }
}

class _Badge extends StatelessWidget {
  final String text;

  const _Badge({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 20, minHeight: 20),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
      decoration: BoxDecoration(
        color: Colors.redAccent,
        shape: BoxShape.circle,
        border: Border.all(color: Theme.of(context).colorScheme.surface),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 9,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _NewDot extends StatelessWidget {
  final Color borderColor;

  const _NewDot({required this.borderColor});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 9,
      height: 9,
      decoration: BoxDecoration(
        color: Colors.orangeAccent,
        shape: BoxShape.circle,
        border: Border.all(color: borderColor, width: 1.2),
      ),
    );
  }
}

Color _strongColor(Color color, bool isLight) {
  final hsl = HSLColor.fromColor(color);
  if (!isLight) {
    return hsl
        .withSaturation((hsl.saturation + 0.10).clamp(0.0, 1.0))
        .withLightness(0.72)
        .toColor();
  }
  return hsl
      .withSaturation((hsl.saturation + 0.22).clamp(0.0, 1.0))
      .withLightness(0.38)
      .toColor();
}
