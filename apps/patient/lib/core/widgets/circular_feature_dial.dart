// Static circular_feature_dial.dart - No rotation, fixed positions
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/widgets/heartbeat_logo.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';
import 'package:vhhealth/generated/app_localizations.dart';

// Feature Icon Data
class FeatureIconData {
  final IconData icon;
  final String label;
  final void Function(BuildContext) onTap;
  final Color color;
  final bool hasNew;
  final String? badge;
  final String? description;

  /// Optional asset path to a hand-drawn SVG illustration. When set,
  /// the [FeatureGrid] renders the SVG instead of [icon] for a richer
  /// per-category look. Falls back to [icon] when null (so legacy code
  /// + the circular dial keep working unchanged).
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

// Static Circular Feature Dial - No rotation
class CircularFeatureDial extends StatefulWidget {
  final List<FeatureIconData> features;
  final void Function(Color)? onFocusColorChanged;
  final double? size;
  final bool enableHaptics;
  final bool autoRotateToTop; // Kept for API compatibility but unused
  final bool enableParticles;
  final bool enableAccessibility;

  const CircularFeatureDial({
    super.key,
    required this.features,
    this.onFocusColorChanged,
    this.size,
    this.enableHaptics = true,
    this.autoRotateToTop = true, // Ignored in static version
    this.enableParticles = false,
    this.enableAccessibility = true,
  });

  @override
  State<CircularFeatureDial> createState() => _CircularFeatureDialState();
}

class _CircularFeatureDialState extends State<CircularFeatureDial>
    with SingleTickerProviderStateMixin {
  // State
  int? selectedIndex;
  int? hoveredIndex;
  late AnimationController _animationController;
  late List<Animation<double>> _scaleAnimations;

  // Reordered features
  late List<FeatureIconData> _reorderedFeatures;

  @override
  void initState() {
    super.initState();

    // Reorder features to put "health" first
    _reorderedFeatures = _getReordered();

    // Initialize animation controller for tap feedback
    _animationController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );

    // Create scale animations for each feature
    _scaleAnimations = List.generate(
      _reorderedFeatures.length,
      (index) => Tween<double>(begin: 1.0, end: 1.2).animate(
        CurvedAnimation(
          parent: _animationController,
          curve: Curves.easeOutBack,
        ),
      ),
    );

    // Set initial color if callback provided
    if (widget.onFocusColorChanged != null && _reorderedFeatures.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        // "Your Health" is at top, so it's the default focus
        widget.onFocusColorChanged!(_reorderedFeatures[0].color);
      });
    }
  }

  @override
  void dispose() {
    _animationController.dispose();
    super.dispose();
  }

  List<FeatureIconData> _getReordered() {
    if (widget.features.isEmpty) return [];

    // Find "health" feature and put it first (at top position)
    final healthIndex = widget.features.indexWhere(
      (f) => f.label.toLowerCase().contains('health'),
    );

    if (healthIndex > 0) {
      final reordered = List<FeatureIconData>.from(widget.features);
      final healthFeature = reordered.removeAt(healthIndex);
      reordered.insert(0, healthFeature);
      return reordered;
    }

    return widget.features;
  }

  void _onFeatureTap(int index, FeatureIconData feature) {
    // Haptic feedback
    if (widget.enableHaptics) {
      HapticFeedback.selectionClick();
    }

    // Update selected index
    setState(() {
      selectedIndex = index;
    });

    // Trigger scale animation
    _animationController.forward().then((_) {
      _animationController.reverse();
    });

    // Call color change callback
    widget.onFocusColorChanged?.call(feature.color);

    // Navigate to feature
    feature.onTap(context);
  }

  @override
  Widget build(BuildContext context) {
    if (_reorderedFeatures.isEmpty) {
      return Center(child: Text(AppLocalizations.of(context)!.circularDialNoFeatures));
    }

    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;
    final size = MediaQuery.of(context).size;
    final diameter =
        widget.size ?? min(size.width * 0.8, 380.0); // Reduced max size
    final radius = diameter * 0.35; // Conservative radius to ensure no cutoff

    return Center(
      child: SizedBox(
        width: diameter,
        height: diameter,
        child: ClipRect(
          // Add clipping to ensure nothing overflows
          child: Stack(
            alignment: Alignment.center,
            children: [
              // Background gradient (static)
              Container(
                width: diameter * 1.1,
                height: diameter * 1.1,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    colors: [
                      theme.colorScheme.primary.withAlpha(
                        isDarkMode ? 25 : 13, // ✅ More visible in dark mode
                      ),
                      Colors.transparent,
                    ],
                    radius: 1.2,
                  ),
                ),
              ),

              // Center logo
              Container(
                width: 85,
                height: 85,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: theme.colorScheme.surface,
                  boxShadow: [
                    BoxShadow(
                      color: isDarkMode
                          ? Colors.black.withAlpha(
                              64,
                            ) // ✅ Stronger shadow in dark
                          : Colors.black.withAlpha(38),
                      blurRadius: 15,
                      offset: const Offset(0, 3),
                    ),
                  ],
                ),
                child: const HeartbeatLogo(),
              ),

              // Feature items in fixed positions
              ..._buildFeatureItems(diameter, radius, theme, isDarkMode),

              // Top indicator (static)
              Positioned(
                top: 15,
                child: Container(
                  width: 36,
                  height: 3,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary,
                    borderRadius: BorderRadius.circular(1.5),
                    boxShadow: [
                      BoxShadow(
                        color: theme.colorScheme.primary.withAlpha(102),
                        blurRadius: 4,
                        offset: const Offset(0, 1),
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
  }

  List<Widget> _buildFeatureItems(
    double diameter,
    double radius,
    ThemeData theme,
    bool isDarkMode,
  ) {
    final itemCount = _reorderedFeatures.length;
    final angleStep = (2 * pi) / itemCount;

    return List.generate(itemCount, (index) {
      // Calculate position - start from top (-pi/2) and go clockwise
      final angle = -pi / 2 + (angleStep * index);
      final x = radius * cos(angle);
      final y = radius * sin(angle);
      final feature = _reorderedFeatures[index];
      final isSelected = index == selectedIndex;
      final isHovered = index == hoveredIndex;

      // Items at top are slightly larger
      // ignore: unused_local_variable
      final distanceFromTop = (angle + pi / 2).abs();
      final positionScale = index == 0
          ? 1.05
          : 1.0; // Reduced from 1.1 to prevent cutoff

      return Positioned(
        left: diameter / 2 + x - 38, // Center the 76px containers
        top: diameter / 2 + y - 38, // Center the 76px containers
        child: MouseRegion(
          onEnter: (_) => setState(() => hoveredIndex = index),
          onExit: (_) => setState(() => hoveredIndex = null),
          child: GestureDetector(
            onTap: () => _onFeatureTap(index, feature),
            onLongPress: widget.enableAccessibility
                ? () {
                    if (widget.enableHaptics) {
                      HapticFeedback.mediumImpact();
                    }
                    _showFeatureDescription(feature);
                  }
                : null,
            child: AnimatedBuilder(
              animation: _scaleAnimations[index],
              builder: (context, child) {
                final animScale = isSelected
                    ? _scaleAnimations[index].value
                    : 1.0;
                return Transform.scale(
                  scale: positionScale * animScale * (isHovered ? 1.05 : 1.0),
                  child: child,
                );
              },
              child: _buildFeatureItem(
                feature,
                isSelected,
                isHovered,
                index == 0, // First item (health) is always highlighted
                theme,
                isDarkMode,
              ),
            ),
          ),
        ),
      );
    });
  }

  Widget _buildFeatureItem(
    FeatureIconData feature,
    bool isSelected,
    bool isHovered,
    bool isTopItem,
    ThemeData theme,
    bool isDarkMode,
  ) {
    final shadowOpacity = ThemeColors.getShadowOpacity(
      context,
    ); // ✅ Use theme utility
    final isHighlighted = isSelected || isHovered || isTopItem;

    return Stack(
      alignment: Alignment.center,
      children: [
        // Glow effect for highlighted items
        if (isHighlighted)
          Container(
            width: 85, // Reduced to match button size
            height: 85, // Reduced to match button size
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  feature.color.withValues(
                    alpha: isDarkMode ? 0.15 : 0.25, // ✅ Subtler in dark mode
                  ),
                  feature.color.withValues(alpha: 0.0),
                ],
              ),
            ),
          ),

        // Main container
        AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          width: isHighlighted ? 80 : 76, // Slightly reduced
          height: isHighlighted ? 80 : 76, // Slightly reduced
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: theme.colorScheme.surface,
            border: Border.all(
              color: isHighlighted
                  ? feature.color
                  : theme.colorScheme.outline.withValues(alpha: 0.2),
              width: isHighlighted ? 2.5 : 1,
            ),
            boxShadow: [
              BoxShadow(
                color: feature.color.withValues(
                  alpha: isHighlighted ? shadowOpacity : shadowOpacity * 0.5,
                ),
                blurRadius: isHighlighted ? 12 : 8,
                offset: const Offset(0, 3),
              ),
            ],
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // Icon with badge
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Icon(
                    feature.icon,
                    size: isHighlighted
                        ? 28
                        : 26, // Adjusted for smaller containers
                    color: isHighlighted
                        ? feature.color
                        : theme.colorScheme.primary,
                  ),
                  if (feature.badge != null)
                    Positioned(
                      right: -6, // Reduced from -8
                      top: -6, // Reduced from -8
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: Colors.red,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: theme.colorScheme.surface,
                            width: 2,
                          ),
                        ),
                        constraints: const BoxConstraints(
                          minWidth: 20,
                          minHeight: 20,
                        ),
                        child: Text(
                          feature.badge!,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                  if (feature.hasNew)
                    Positioned(
                      right: -2, // Reduced from -4
                      top: -2, // Reduced from -4
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: Colors.orange,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: theme.colorScheme.surface,
                            width: 1,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 4), // Reduced from 6
              // Label
              Text(
                feature.label,
                style: TextStyle(
                  fontSize: isHighlighted ? 10.5 : 9.5, // Slightly smaller text
                  fontWeight: isHighlighted ? FontWeight.bold : FontWeight.w500,
                  color: isHighlighted
                      ? feature.color
                      : theme.colorScheme.onSurface,
                ),
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _showFeatureDescription(FeatureIconData feature) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Row(
          children: [
            Icon(feature.icon, color: feature.color),
            const SizedBox(width: 8),
            Text(feature.label),
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

// Haptic feedback types
enum HapticType { light, selection, medium }
