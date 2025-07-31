// Enhanced circular_feature_dial.dart with all suggested improvements
import 'dart:math';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/widgets/heartbeat_logo.dart';

// Feature Preview Dialog
class FeaturePreviewDialog extends StatelessWidget {
  final FeatureIconData feature;

  const FeaturePreviewDialog({super.key, required this.feature});

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
        child: Container(
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.9),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(
              color: feature.color.withValues(alpha: 0.3),
              width: 2,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: feature.color.withValues(alpha: 0.1),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  feature.icon,
                  size: 48,
                  color: feature.color,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                feature.label,
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  color: feature.color,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Long press to access quick actions',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// Particle System for selection effects
class ParticleSystem extends StatefulWidget {
  final Offset position;
  final Color color;
  final int count;
  final VoidCallback onComplete;

  const ParticleSystem({
    super.key,
    required this.position,
    required this.color,
    required this.count,
    required this.onComplete,
  });

  @override
  State<ParticleSystem> createState() => _ParticleSystemState();
}

class _ParticleSystemState extends State<ParticleSystem>
    with SingleTickerProviderStateMixin {
  late AnimationController controller;
  late List<Particle> particles;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );
    
    particles = List.generate(widget.count, (index) {
      final angle = (2 * pi / widget.count) * index;
      return Particle(
        angle: angle,
        speed: 100 + Random().nextDouble() * 50,
        size: 4 + Random().nextDouble() * 4,
      );
    });
    
    controller.forward().then((_) {
      widget.onComplete();
    });
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) {
        return CustomPaint(
          painter: ParticlePainter(
            particles: particles,
            progress: controller.value,
            color: widget.color,
            origin: widget.position,
          ),
        );
      },
    );
  }
}

class Particle {
  final double angle;
  final double speed;
  final double size;

  Particle({
    required this.angle,
    required this.speed,
    required this.size,
  });
}

class ParticlePainter extends CustomPainter {
  final List<Particle> particles;
  final double progress;
  final Color color;
  final Offset origin;

  ParticlePainter({
    required this.particles,
    required this.progress,
    required this.color,
    required this.origin,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..style = PaintingStyle.fill;
    
    for (final particle in particles) {
      final opacity = 1.0 - progress;
      paint.color = color.withValues(alpha: opacity * 0.8);
      
      final distance = particle.speed * progress;
      final x = origin.dx + cos(particle.angle) * distance;
      final y = origin.dy + sin(particle.angle) * distance;
      
      final currentSize = particle.size * (1.0 - progress * 0.5);
      canvas.drawCircle(Offset(x, y), currentSize, paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}

// Custom Animation Curves
class ElasticInOutCurve extends Curve {
  @override
  double transform(double t) {
    if (t < 0.5) {
      return 0.5 * Curves.elasticIn.transform(t * 2);
    } else {
      return 0.5 + 0.5 * Curves.elasticOut.transform((t - 0.5) * 2);
    }
  }
}

class FeatureIconData {
  final IconData icon;
  final String label;
  final void Function(BuildContext) onTap;
  final Color color;
  final bool hasNew;
  final String? badge;
  final String? description;

  FeatureIconData({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.color,
    this.hasNew = false,
    this.badge,
    this.description,
  });
}

class CircularFeatureDial extends StatefulWidget {
  final List<FeatureIconData> features;
  final void Function(Color)? onFocusColorChanged;
  final double? size;
  final bool enableHaptics;
  final bool autoRotateToTop;
  final bool enableParticles;
  final bool enableAccessibility;

  const CircularFeatureDial({
    super.key,
    required this.features,
    this.onFocusColorChanged,
    this.size,
    this.enableHaptics = true,
    this.autoRotateToTop = true,
    this.enableParticles = true,
    this.enableAccessibility = true,
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
  static const double _itemCenterOffset = 40.0;
  static const double _parallaxMultiplier = 15.0;
  static const double _watermarkSize = 140.0;
  static const double _watermarkBottom = 50.0;
  static const double _glowSize = 80.0;
  static const double _rotationSensitivity = 100.0;
  static const double _velocityDamping = 8.0;
  static const double _friction = 0.0001;
  static const double _velocityMultiplier = 0.5;
  static const double _snapVelocityThreshold = 0.5;
  static const int _minSpinDuration = 300;
  static const int _maxSpinDuration = 2000;
  static const int _snapDuration = 600;
  static const Duration _updateThreshold = Duration(milliseconds: 16);

  // State
  double rotation = 0.0;
  double velocity = 0.0;
  double dialScale = 1.0;
  int? selectedIndex;
  int? hoveredIndex;
  int? focusedIndex;
  double _lastVibrateAngle = 0.0;
  DateTime _lastUpdateTime = DateTime.now();
  Color _currentColor = Colors.transparent;
  bool _isDragging = false;
  bool _isAnimating = false;
  List<Widget> particles = [];

  // Animation controllers
  late AnimationController spinController;
  late AnimationController pulseController;
  late AnimationController glowController;
  late AnimationController selectionController;
  late AnimationController scaleController;
  
  // Animations
  late Animation<double> spinAnimation = AlwaysStoppedAnimation(rotation);
  late Animation<double> pulseAnimation;
  late Animation<double> glowAnimation;
  late Animation<double> selectionAnimation;
  late Animation<double> scaleAnimation;

  // Custom curves
  final elasticCurve = ElasticInOutCurve();

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

    selectionController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    
    selectionAnimation = CurvedAnimation(
      parent: selectionController,
      curve: Curves.easeOutBack,
    );

    scaleController = AnimationController(
      duration: const Duration(milliseconds: 200),
      vsync: this,
    );
    
    scaleAnimation = Tween<double>(
      begin: 1.0,
      end: dialScale,
    ).animate(CurvedAnimation(
      parent: scaleController,
      curve: Curves.easeOutCubic,
    ));
  }

  void _scheduleInitialAnimation() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        setState(() {
          focusedIndex = 0;
        });
        _animateSelectedToTop(0, immediate: true);
      }
    });
  }

  @override
  void dispose() {
    spinController.dispose();
    pulseController.dispose();
    glowController.dispose();
    selectionController.dispose();
    scaleController.dispose();
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
    if (_isAnimating) return;
    
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
      _updateFocusedItem();
    });
  }

  void _updateFocusedItem() {
    final reordered = _getReordered();
    if (reordered.isEmpty) return;
    
    final anglePerItem = (2 * pi / reordered.length);
    final normalized = (rotation + pi / 2) % (2 * pi);
    final index = (normalized / anglePerItem).round() % reordered.length;
    
    if (focusedIndex != index) {
      setState(() {
        focusedIndex = index;
      });
      _updateFocusedColor();
    }
  }

  void _startInertialSpin(double velocity) {
    if (_isAnimating) return;
    
    // Check for momentum-based snapping
    if (velocity.abs() < _snapVelocityThreshold) {
      _snapToNearest();
      return;
    }
    
    final duration = Duration(
      milliseconds: (velocity.abs() / _friction).clamp(_minSpinDuration, _maxSpinDuration).toInt()
    );

    setState(() => _isAnimating = true);

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
        _updateFocusedItem();
      });
    }
  }

  void _onSpinStatusChanged(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) {
      setState(() => _isAnimating = false);
      _snapToNearest();
    }
  }

  void _snapToNearest() {
    final reordered = _getReordered();
    final anglePerItem = (2 * pi / reordered.length);
    final normalized = (rotation + pi / 2) % (2 * pi);
    final index = (normalized / anglePerItem).round() % reordered.length;
    _animateSelectedToTop(index, isSnap: true);
  }

  void _animateSelectedToTop(int index, {bool immediate = false, bool isSnap = false}) {
    if (_isAnimating && !immediate) return;
    
    setState(() => _isAnimating = true);
    
    final anglePerItem = (2 * pi / widget.features.length);
    final currentNormalized = rotation % (2 * pi);
    final targetAngle = -index * anglePerItem + pi / 2;
    
    double diff = targetAngle - currentNormalized;
    while (diff > pi) diff -= 2 * pi;
    while (diff < -pi) diff += 2 * pi;
    
    final finalAngle = rotation + diff;

    final curve = immediate 
        ? Curves.easeOut 
        : (isSnap ? Curves.easeInOutCubic : elasticCurve);
    
    final duration = immediate 
        ? 200 
        : (isSnap ? _snapDuration ~/ 2 : _snapDuration);

    spinAnimation = Tween<double>(
      begin: rotation,
      end: finalAngle,
    ).animate(CurvedAnimation(
      parent: spinController,
      curve: curve,
    ));

    spinController
      ..duration = Duration(milliseconds: duration)
      ..reset()
      ..forward();

    spinAnimation.addListener(_onSpinUpdate);
    spinAnimation.addStatusListener((status) {
      if (status == AnimationStatus.completed && mounted) {
        setState(() {
          rotation = finalAngle;
          _isAnimating = false;
          focusedIndex = index;
        });
        _updateFocusedColor();
        if (!isSnap) {
          _hapticFeedback(HapticType.medium);
        }
      }
    });
  }

  void _updateFocusedColor() {
    final reordered = _getReordered();
    if (reordered.isEmpty || focusedIndex == null) return;
    
    final newColor = reordered[focusedIndex!].color;
    
    if (_currentColor != newColor) {
      _currentColor = newColor;
      widget.onFocusColorChanged?.call(newColor);
    }
  }

  double _calculateOptimalRadius(int itemCount) {
    final size = MediaQuery.of(context).size;
    final diameter = widget.size ?? size.width * 0.85;
    final center = diameter / 2;
    
    final minRadius = center * 0.5;
    final maxRadius = center * 0.8;
    final factor = min(1.0, itemCount / 8.0);
    
    return minRadius + (maxRadius - minRadius) * factor;
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

  void _showParticles(Offset position, Color color) {
    if (!widget.enableParticles) return;
    
    final particle = ParticleSystem(
      position: position,
      color: color,
      count: 10,
      onComplete: () {
        setState(() {
          particles.removeWhere((p) => (p as ParticleSystem).position == position);
        });
      },
    );
    
    setState(() {
      particles.add(particle);
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;
    final size = MediaQuery.of(context).size;
    final diameter = widget.size ?? size.width * 0.85;
    final center = diameter / 2;

    final reordered = _getReordered();
    if (reordered.isEmpty) {
      return const SizedBox.shrink();
    }

    final radius = _calculateOptimalRadius(reordered.length);

    return Center(
      child: Stack(
        children: [
          GestureDetector(
            onPanStart: (_) => _onPanStart(),
            onPanUpdate: (details) => _onPanUpdate(details),
            onPanEnd: (_) => _onPanEnd(),
            onDoubleTap: () => _onDoubleTap(),
            onScaleUpdate: (details) => _onScaleUpdate(details),
            onScaleEnd: (_) => _onScaleEnd(),
            child: AnimatedBuilder(
              animation: scaleAnimation,
              builder: (context, child) {
                return Transform.scale(
                  scale: scaleAnimation.value,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      _buildBackgroundGradient(diameter, isDarkMode),
                      _buildParallaxWatermark(reordered),
                      _buildMainDial(diameter, center, radius, reordered, theme, isDarkMode),
                      _buildTopIndicator(theme, isDarkMode),
                    ],
                  ),
                );
              },
            ),
          ),
          ...particles,
        ],
      ),
    );
  }

  Widget _buildTopIndicator(ThemeData theme, bool isDarkMode) {
    final glowIntensity = isDarkMode ? 0.6 : 0.3;
    
    return Positioned(
      top: 20,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 300),
        opacity: _isAnimating ? 1.0 : 0.7,
        child: Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
            color: _currentColor,
            borderRadius: BorderRadius.circular(2),
            boxShadow: [
              BoxShadow(
                color: _currentColor.withValues(alpha: glowIntensity),
                blurRadius: 8,
                offset: const Offset(0, 2),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _onPanStart() {
    if (_isAnimating) return;
    
    spinController.stop();
    _lastVibrateAngle = rotation;
    setState(() => _isDragging = true);
  }

  void _onPanUpdate(DragUpdateDetails details) {
    if (_isAnimating) return;
    
    _updateRotation(details.delta.dx / _rotationSensitivity);
    velocity = details.delta.dx / _velocityDamping;
  }

  void _onPanEnd() {
    setState(() => _isDragging = false);
    if (!_isAnimating) {
      _startInertialSpin(velocity);
    }
  }

  void _onDoubleTap() {
    if (focusedIndex != null) {
      _animateSelectedToTop(focusedIndex!, immediate: true);
      _hapticFeedback(HapticType.medium);
    }
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    setState(() {
      dialScale = details.scale.clamp(0.8, 1.2);
    });
    
    scaleAnimation = Tween<double>(
      begin: scaleAnimation.value,
      end: dialScale,
    ).animate(CurvedAnimation(
      parent: scaleController,
      curve: Curves.easeOutCubic,
    ));
    
    scaleController
      ..duration = const Duration(milliseconds: 100)
      ..reset()
      ..forward();
  }

  void _onScaleEnd() {
    scaleAnimation = Tween<double>(
      begin: dialScale,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: scaleController,
      curve: Curves.elasticOut,
    ));
    
    scaleController
      ..duration = const Duration(milliseconds: 500)
      ..reset()
      ..forward();
    
    setState(() {
      dialScale = 1.0;
    });
  }

  Widget _buildBackgroundGradient(double diameter, bool isDarkMode) {
    final glowIntensity = isDarkMode ? 0.08 : 0.05;
    
    return AnimatedContainer(
      duration: const Duration(milliseconds: 800),
      curve: Curves.easeInOut,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            _currentColor.withValues(alpha: glowIntensity),
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
    if (focusedIndex == null || focusedIndex! >= reordered.length) {
      return const SizedBox.shrink();
    }
    
    return Positioned(
      bottom: _watermarkBottom,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 400),
        child: Transform.translate(
          key: ValueKey(focusedIndex),
          offset: Offset(rotation * _parallaxMultiplier, 0),
          child: Icon(
            reordered[focusedIndex!].icon,
            size: _watermarkSize,
            color: _currentColor.withValues(alpha: 0.08),
          ),
        ),
      ),
    );
  }

  Widget _buildMainDial(double diameter, double center, double radius, 
      List<FeatureIconData> reordered, ThemeData theme, bool isDarkMode) {
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
            _buildFeatureItem(i, reordered, radius, center, theme, isDarkMode)),
        ],
      ),
    );
  }

  Widget _buildFeatureItem(int index, List<FeatureIconData> reordered, 
      double radius, double center, ThemeData theme, bool isDarkMode) {
    final angle = (2 * pi / reordered.length) * index - pi / 2 + rotation;
    final x = radius * cos(angle);
    final y = radius * sin(angle);
    final isSelected = index == selectedIndex;
    final isHovered = index == hoveredIndex;
    final isFocused = index == focusedIndex;
    final feature = reordered[index];

    final normalizedAngle = (angle + pi / 2) % (2 * pi);
    final distanceFromTop = min(normalizedAngle, 2 * pi - normalizedAngle);
    final scaleFactor = 1.0 + (0.15 * (1 - distanceFromTop / pi));

    final itemWidget = MouseRegion(
      onEnter: (_) => setState(() => hoveredIndex = index),
      onExit: (_) => setState(() => hoveredIndex = null),
      child: GestureDetector(
        onTap: () => _onFeatureTap(index, feature, Offset(center + x, center + y)),
        onLongPress: () => _onLongPress(feature),
        onDoubleTap: () => _onItemDoubleTap(index),
        child: Transform.scale(
          scale: isFocused ? scaleFactor : 1.0,
          child: _buildFeatureContent(
            feature, 
            isSelected, 
            isHovered, 
            isFocused,
            theme,
            isDarkMode,
          ),
        ),
      ),
    );

    return Positioned(
      left: center + x - _itemCenterOffset,
      top: center + y - _itemCenterOffset,
      child: widget.enableAccessibility
          ? Semantics(
              button: true,
              label: '${feature.label}${isFocused ? ", currently selected" : ""}${feature.badge != null ? ", ${feature.badge} notifications" : ""}',
              hint: 'Double tap to select and rotate to top',
              child: itemWidget,
            )
          : itemWidget,
    );
  }

  void _onFeatureTap(int index, FeatureIconData feature, Offset position) {
    if (_isAnimating) return;
    
    setState(() {
      selectedIndex = index;
    });
    
    selectionController.forward().then((_) {
      selectionController.reverse();
    });
    
    _hapticFeedback(HapticType.selection);
    _showParticles(position, feature.color);
    
    feature.onTap(context);
    
    if (widget.autoRotateToTop) {
      _animateSelectedToTop(index);
    }
  }

  void _onLongPress(FeatureIconData feature) {
    _hapticFeedback(HapticType.medium);
    showDialog(
      context: context,
      builder: (_) => FeaturePreviewDialog(feature: feature),
    );
  }

  void _onItemDoubleTap(int index) {
    _animateSelectedToTop(index, immediate: true);
    _hapticFeedback(HapticType.medium);
  }

  Widget _buildFeatureContent(FeatureIconData feature, bool isSelected, 
      bool isHovered, bool isFocused, ThemeData theme, bool isDarkMode) {
    return AnimatedBuilder(
      animation: Listenable.merge([pulseAnimation, glowAnimation, selectionAnimation]),
      builder: (context, child) {
        final scale = isSelected 
            ? pulseAnimation.value * (1 + selectionAnimation.value * 0.2)
            : (isHovered ? 1.1 : 1.0);
            
        return AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOutBack,
          transform: Matrix4.identity()..scale(scale),
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (feature.hasNew || isFocused) 
                _buildGlowEffect(feature, isFocused, isDarkMode),
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildIconContainer(feature, isSelected, isFocused, theme, isDarkMode),
                  const SizedBox(height: 8),
                  _buildLabel(feature, isSelected, isFocused, theme),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildGlowEffect(FeatureIconData feature, bool isFocused, bool isDarkMode) {
    final glowIntensity = isDarkMode ? 0.6 : 0.4;
    
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 300),
      opacity: isFocused ? 0.8 : glowAnimation.value,
      child: Container(
        width: _glowSize,
        height: _glowSize,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              feature.color.withValues(alpha: isFocused ? glowIntensity : glowIntensity * 0.8),
              feature.color.withValues(alpha: 0.0),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildIconContainer(FeatureIconData feature, bool isSelected, 
      bool isFocused, ThemeData theme, bool isDarkMode) {
    final shadowOpacity = isDarkMode ? 0.4 : 0.2;
    
    return Stack(
      children: [
        AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          width: isSelected || isFocused ? _selectedIconSize : _iconSize,
          height: isSelected || isFocused ? _selectedIconSize : _iconSize,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: theme.colorScheme.surface,
            boxShadow: [
              BoxShadow(
                color: feature.color.withValues(
                  alpha: (isSelected || isFocused) ? shadowOpacity : shadowOpacity * 0.75
                ),
                blurRadius: isSelected || isFocused ? 12 : 8,
                offset: const Offset(0, 4),
              ),
            ],
            border: Border.all(
              color: isSelected || isFocused
                ? feature.color 
                : theme.colorScheme.outline.withValues(alpha: 0.2),
              width: isSelected || isFocused ? 2 : 1,
            ),
          ),
          child: Icon(
            feature.icon,
            size: isSelected || isFocused ? _iconSizeLarge : _iconSizeSmall,
            color: isSelected || isFocused 
                ? feature.color 
                : theme.colorScheme.primary,
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

  Widget _buildLabel(FeatureIconData feature, bool isSelected, 
      bool isFocused, ThemeData theme) {
    return AnimatedDefaultTextStyle(
      duration: const Duration(milliseconds: 200),
      style: theme.textTheme.bodySmall!.copyWith(
        fontWeight: isSelected || isFocused ? FontWeight.bold : FontWeight.w500,
        color: isSelected || isFocused ? feature.color : theme.colorScheme.onSurface,
        fontSize: isSelected || isFocused ? 13 : 12,
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