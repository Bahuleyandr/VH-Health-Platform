// Fixed circular_feature_dial.dart with proper animation initialization
import 'dart:math';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/widgets/heartbeat_logo.dart';

class FeatureIconData {
  final IconData icon;
  final String label;
  final void Function(BuildContext) onTap;
  final Color color;
  final bool hasNew;
  final String? badge;

  FeatureIconData({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.color,
    this.hasNew = false,
    this.badge,
  });
}

class CircularFeatureDial extends StatefulWidget {
  final List<FeatureIconData> features;
  final void Function(Color)? onFocusColorChanged;
  final double? size;
  final bool enableHaptics;

  const CircularFeatureDial({
    super.key,
    required this.features,
    this.onFocusColorChanged,
    this.size,
    this.enableHaptics = true,
  });

  @override
  State<CircularFeatureDial> createState() => _CircularFeatureDialState();
}

class _CircularFeatureDialState extends State<CircularFeatureDial>
    with TickerProviderStateMixin, AutomaticKeepAliveClientMixin {
  // Constants
  static const double _itemSize = 80.0;
  static const double _iconSize = 56.0;
  static const double _selectedIconSize = 68.0;
  static const double _iconSizeSmall = 28.0;
  static const double _iconSizeLarge = 32.0;
  static const double _vibrateInterval = pi / 20;
  static const double _radiusOffset = 55.0;
  static const double _itemCenterOffset = 40.0;
  static const double _parallaxMultiplier = 15.0;
  static const double _watermarkSize = 140.0;
  static const double _watermarkBottom = 50.0;
  static const double _glowSize = 80.0;
  static const double _rotationSensitivity = 100.0;
  static const double _velocityDamping = 8.0;
  static const double _friction = 0.0001;
  static const double _velocityMultiplier = 0.5;
  static const int _minSpinDuration = 300;
  static const int _maxSpinDuration = 2000;
  static const int _snapDuration = 400;
  static const Duration _updateThreshold = Duration(milliseconds: 16); // 60 FPS

  // State
  double rotation = 0.0;
  double velocity = 0.0;
  int? selectedIndex;
  int? hoveredIndex;
  double _lastVibrateAngle = 0.0;
  DateTime _lastUpdateTime = DateTime.now();
  Color _currentColor = Colors.transparent;
  bool _isDragging = false;

  // Animation controllers
  late AnimationController spinController;
  late AnimationController pulseController;
  late AnimationController glowController;
  
  // Animations
  late Animation<double> spinAnimation = AlwaysStoppedAnimation(rotation);
  late Animation<double> pulseAnimation;
  late Animation<double> glowAnimation;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _initializeAnimations();
    _scheduleInitialAnimation();
  }

  void _initializeAnimations() {
    spinController = AnimationController(vsync: this);
    
    pulseController = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    )..repeat(reverse: true);
    
    pulseAnimation = Tween<double>(
      begin: 1.0,
      end: 1.1,
    ).animate(CurvedAnimation(
      parent: pulseController,
      curve: Curves.easeInOut,
    ));

    glowController = AnimationController(
      duration: const Duration(seconds: 1),
      vsync: this,
    )..repeat(reverse: true);
    
    glowAnimation = Tween<double>(
      begin: 0.5,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: glowController,
      curve: Curves.easeInOut,
    ));
  }

  void _scheduleInitialAnimation() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _animateSelectedToTop(0);
      }
    });
  }

  @override
  void dispose() {
    spinController.dispose();
    pulseController.dispose();
    glowController.dispose();
    super.dispose();
  }

  void _hapticFeedback(HapticType type) {
    if (!widget.enableHaptics) return;
    
    switch (type) {
      case HapticType.light:
        HapticFeedback.lightImpact();
        break;
      case HapticType.selection:
        HapticFeedback.selectionClick();
        break;
      case HapticType.medium:
        HapticFeedback.mediumImpact();
        break;
    }
  }

  void _updateRotation(double delta) {
    final now = DateTime.now();
    if (now.difference(_lastUpdateTime) < _updateThreshold) return;
    _lastUpdateTime = now;
    
    setState(() {
      rotation += delta;
      final deltaAngle = (rotation - _lastVibrateAngle).abs();
      if (deltaAngle >= _vibrateInterval) {
        _hapticFeedback(HapticType.light);
        _lastVibrateAngle = rotation;
      }
      _updateFocusedColor();
    });
  }

  void _startInertialSpin(double velocity) {
    final duration = Duration(
      milliseconds: (velocity.abs() / _friction).clamp(_minSpinDuration, _maxSpinDuration).toInt()
    );

    spinAnimation = Tween<double>(
      begin: rotation,
      end: rotation + velocity * _velocityMultiplier,
    ).animate(CurvedAnimation(
      parent: spinController,
      curve: Curves.decelerate,
    ));

    spinController
      ..duration = duration
      ..reset()
      ..forward();

    spinAnimation.addListener(_onSpinUpdate);
    spinAnimation.addStatusListener(_onSpinStatusChanged);
  }

  void _onSpinUpdate() {
    if (mounted) {
      setState(() {
        rotation = spinAnimation.value;
        _updateFocusedColor();
      });
    }
  }

  void _onSpinStatusChanged(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) {
      _snapToNearest();
    }
  }

  void _snapToNearest() {
    final reordered = _getReordered();
    final anglePerItem = (2 * pi / reordered.length);
    final normalized = (rotation + pi / 2) % (2 * pi);
    final index = (normalized / anglePerItem).round() % reordered.length;
    _animateSelectedToTop(index);
    _hapticFeedback(HapticType.medium);
  }

  void _animateSelectedToTop(int index) {
    final anglePerItem = (2 * pi / widget.features.length);
    final targetAngle = index * anglePerItem - pi / 2;
    
    double diff = targetAngle - rotation;
    while (diff > pi) diff -= 2 * pi;
    while (diff < -pi) diff += 2 * pi;
    final finalAngle = rotation + diff;

    spinAnimation = Tween<double>(
      begin: rotation,
      end: finalAngle,
    ).animate(CurvedAnimation(
      parent: spinController,
      curve: Curves.easeInOutCubic,
    ));

    spinController
      ..duration = Duration(milliseconds: _snapDuration)
      ..reset()
      ..forward();

    spinAnimation.addListener(_onSpinUpdate);
  }

  void _updateFocusedColor() {
    final reordered = _getReordered();
    if (reordered.isEmpty) return;
    
    final anglePerItem = (2 * pi / reordered.length);
    final normalized = (rotation + pi / 2) % (2 * pi);
    final index = (normalized / anglePerItem).round() % reordered.length;
    final newColor = reordered[index].color;
    
    if (_currentColor != newColor) {
      _currentColor = newColor;
      widget.onFocusColorChanged?.call(newColor);
    }
  }

  List<FeatureIconData> _getReordered() {
    try {
      return [
        widget.features.firstWhere((f) => f.label.toLowerCase().contains('health')),
        ...widget.features.where((f) => !f.label.toLowerCase().contains('health')),
      ];
    } catch (e) {
      return widget.features;
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final theme = Theme.of(context);
    final size = MediaQuery.of(context).size;
    final diameter = widget.size ?? size.width * 0.85;
    final center = diameter / 2;
    final radius = center - _radiusOffset;

    final reordered = _getReordered();
    if (reordered.isEmpty) {
      return const SizedBox.shrink();
    }

    return Center(
      child: GestureDetector(
        onPanStart: (_) => _onPanStart(),
        onPanUpdate: (details) => _onPanUpdate(details),
        onPanEnd: (_) => _onPanEnd(),
        child: Stack(
          alignment: Alignment.center,
          children: [
            _buildBackgroundGradient(diameter),
            _buildParallaxWatermark(reordered),
            _buildMainDial(diameter, center, radius, reordered, theme),
          ],
        ),
      ),
    );
  }

  void _onPanStart() {
    spinController.stop();
    _lastVibrateAngle = rotation;
    setState(() => _isDragging = true);
  }

  void _onPanUpdate(DragUpdateDetails details) {
    _updateRotation(details.delta.dx / _rotationSensitivity);
    velocity = details.delta.dx / _velocityDamping;
  }

  void _onPanEnd() {
    setState(() => _isDragging = false);
    _startInertialSpin(velocity);
  }

  Widget _buildBackgroundGradient(double diameter) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 800),
      curve: Curves.easeInOut,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            _currentColor.withValues(alpha: 0.05),
            Colors.transparent,
          ],
          radius: 1.5,
        ),
      ),
      width: diameter * 1.2,
      height: diameter * 1.2,
    );
  }

  Widget _buildParallaxWatermark(List<FeatureIconData> reordered) {
    return Positioned(
      bottom: _watermarkBottom,
      child: Transform.translate(
        offset: Offset(rotation * _parallaxMultiplier, 0),
        child: Icon(
          reordered[(rotation.round().abs()) % reordered.length].icon,
          size: _watermarkSize,
          color: _currentColor.withValues(alpha: 0.08),
        ),
      ),
    );
  }

  Widget _buildMainDial(double diameter, double center, double radius, 
      List<FeatureIconData> reordered, ThemeData theme) {
    return SizedBox(
      height: diameter,
      width: diameter,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AnimatedScale(
            duration: const Duration(milliseconds: 300),
            scale: _isDragging ? 0.9 : 1.0,
            child: const HeartbeatLogo(),
          ),
          ...List.generate(reordered.length, (i) => 
            _buildFeatureItem(i, reordered, radius, center, theme)),
        ],
      ),
    );
  }

  Widget _buildFeatureItem(int index, List<FeatureIconData> reordered, 
      double radius, double center, ThemeData theme) {
    final angle = (2 * pi / reordered.length) * index - pi / 2 + rotation;
    final x = radius * cos(angle);
    final y = radius * sin(angle);
    final isSelected = index == selectedIndex;
    final isHovered = index == hoveredIndex;
    final feature = reordered[index];

    return Positioned(
      left: center + x - _itemCenterOffset,
      top: center + y - _itemCenterOffset,
      child: MouseRegion(
        onEnter: (_) => setState(() => hoveredIndex = index),
        onExit: (_) => setState(() => hoveredIndex = null),
        child: GestureDetector(
          onTap: () => _onFeatureTap(index, feature),
          child: _buildFeatureContent(feature, isSelected, isHovered, theme),
        ),
      ),
    );
  }

  void _onFeatureTap(int index, FeatureIconData feature) {
    setState(() => selectedIndex = index);
    _hapticFeedback(HapticType.selection);
    _animateSelectedToTop(index);
    Future.delayed(Duration(milliseconds: _snapDuration), () {
      if (mounted) {
        feature.onTap(context);
      }
    });
  }

  Widget _buildFeatureContent(FeatureIconData feature, bool isSelected, 
      bool isHovered, ThemeData theme) {
    return AnimatedBuilder(
      animation: Listenable.merge([pulseAnimation, glowAnimation]),
      builder: (context, child) {
        return AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOutBack,
          transform: Matrix4.identity()
            ..scale(isSelected ? pulseAnimation.value : (isHovered ? 1.1 : 1.0)),
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (feature.hasNew) _buildGlowEffect(feature),
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildIconContainer(feature, isSelected, theme),
                  const SizedBox(height: 8),
                  _buildLabel(feature, isSelected, theme),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildGlowEffect(FeatureIconData feature) {
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 300),
      opacity: glowAnimation.value,
      child: Container(
        width: _glowSize,
        height: _glowSize,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              feature.color.withValues(alpha: 0.4),
              feature.color.withValues(alpha: 0.0),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildIconContainer(FeatureIconData feature, bool isSelected, ThemeData theme) {
    return Stack(
      children: [
        AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          width: isSelected ? _selectedIconSize : _iconSize,
          height: isSelected ? _selectedIconSize : _iconSize,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: theme.colorScheme.surface,
            boxShadow: [
              BoxShadow(
                color: feature.color.withValues(alpha: isSelected ? 0.3 : 0.15),
                blurRadius: isSelected ? 12 : 8,
                offset: const Offset(0, 4),
              ),
            ],
            border: Border.all(
              color: isSelected 
                ? feature.color 
                : theme.colorScheme.outline.withValues(alpha: 0.2),
              width: isSelected ? 2 : 1,
            ),
          ),
          child: Icon(
            feature.icon,
            size: isSelected ? _iconSizeLarge : _iconSizeSmall,
            color: isSelected ? feature.color : theme.colorScheme.primary,
          ),
        ),
        if (feature.badge != null) _buildBadge(feature.badge!, theme),
      ],
    );
  }

  Widget _buildBadge(String badge, ThemeData theme) {
    return Positioned(
      right: 0,
      top: 0,
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
          badge,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 10,
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
        ),
      ),
    );
  }

  Widget _buildLabel(FeatureIconData feature, bool isSelected, ThemeData theme) {
    return AnimatedDefaultTextStyle(
      duration: const Duration(milliseconds: 200),
      style: theme.textTheme.bodySmall!.copyWith(
        fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
        color: isSelected ? feature.color : theme.colorScheme.onSurface,
        fontSize: isSelected ? 13 : 12,
      ),
      child: Text(
        feature.label,
        textAlign: TextAlign.center,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

enum HapticType { light, selection, medium }