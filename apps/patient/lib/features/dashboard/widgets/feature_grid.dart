import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart'
    show FeatureIconData;

/// 2-column grid of feature cards. Replaces the legacy circular dial
/// — easier to scan, much bigger tap targets, and each card can carry
/// an optional badge (e.g. "3 active") so the dashboard surfaces state
/// instead of being purely navigational.
///
/// The visual treatment is brightness-aware: in dark mode tints sit
/// around 0.18-0.30 alpha (subtle glow over a dark surface); in light
/// mode they go to 0.35-0.55 (so the card has weight against white).
/// Each tile also carries a large faded "echo" of its icon in the
/// bottom-right corner — turns the card into a recognisable visual
/// territory rather than a flat badge.
class FeatureGrid extends StatelessWidget {
  final List<FeatureIconData> features;
  final bool compact;

  /// Per-feature badge labels keyed by [FeatureIconData.label]. Pass an
  /// empty map (or omit) for no badges. Keep labels short — they render
  /// in a small pill in the top-right of each card.
  final Map<String, String> badges;

  const FeatureGrid({
    super.key,
    required this.features,
    this.badges = const {},
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final horizontalPadding = compact ? 12.0 : 16.0;
        final spacing = compact ? 8.0 : 14.0;
        final availableWidth = constraints.maxWidth - (horizontalPadding * 2);

        final columns = compact ? _compactColumnCount(availableWidth) : 2;
        final tileWidth =
            (availableWidth - (spacing * (columns - 1))) / columns;
        final tileHeight = compact
            ? (tileWidth < 132 ? 88.0 : 82.0)
            : tileWidth / 1.3;
        final aspectRatio = tileWidth / tileHeight;

        return GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: EdgeInsets.symmetric(horizontal: horizontalPadding),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            mainAxisSpacing: spacing,
            crossAxisSpacing: spacing,
            childAspectRatio: aspectRatio,
          ),
          itemCount: features.length,
          itemBuilder: (context, i) {
            final f = features[i];
            return compact
                ? _CompactFeatureTile(feature: f, badge: badges[f.label])
                : _FeatureCard(feature: f, badge: badges[f.label]);
          },
        );
      },
    );
  }

  int _compactColumnCount(double width) {
    if (width >= 1160) return 6;
    if (width >= 920) return 5;
    if (width >= 640) return 4;
    if (width >= 430) return 3;
    return 2;
  }
}

class _CompactFeatureTile extends StatelessWidget {
  final FeatureIconData feature;
  final String? badge;

  const _CompactFeatureTile({required this.feature, this.badge});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final isLight = theme.brightness == Brightness.light;
    final tint = feature.color;
    final foreground = isLight
        ? HSLColor.fromColor(tint)
              .withSaturation(
                (HSLColor.fromColor(tint).saturation + 0.18).clamp(0.0, 1.0),
              )
              .withLightness(0.42)
              .toColor()
        : tint;

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => feature.onTap(context),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          decoration: BoxDecoration(
            color: tint.withValues(alpha: isLight ? 0.20 : 0.10),
            border: Border.all(
              color: tint.withValues(alpha: isLight ? 0.45 : 0.30),
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Stack(
            children: [
              Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(
                          alpha: isLight ? 0.70 : 0.18,
                        ),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: tint.withValues(alpha: isLight ? 0.32 : 0.24),
                        ),
                      ),
                      child: feature.svgAsset != null
                          ? SvgPicture.asset(
                              feature.svgAsset!,
                              width: 26,
                              height: 26,
                              fit: BoxFit.contain,
                            )
                          : Icon(feature.icon, size: 19, color: foreground),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      feature.label,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: colors.onSurface,
                        fontWeight: FontWeight.w700,
                        height: 1.05,
                      ),
                    ),
                  ],
                ),
              ),
              if (badge != null)
                Positioned(
                  top: 0,
                  right: 0,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: foreground,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text(
                      badge!,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 9,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FeatureCard extends StatelessWidget {
  final FeatureIconData feature;
  final String? badge;

  const _FeatureCard({required this.feature, this.badge});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isLight = theme.brightness == Brightness.light;
    final tint = feature.color;

    // Feature tints are Material-200-style pastels (e.g. 0xFFA8E6CF
    // mint) — they read fine in dark mode but in light mode the
    // icon circle would be a light pastel and a white icon on it
    // would be nearly invisible. Derive a saturated variant for the
    // icon circle in light mode so the white glyph has real contrast.
    final saturatedTint = isLight
        ? HSLColor.fromColor(tint)
              .withSaturation(
                (HSLColor.fromColor(tint).saturation + 0.15).clamp(0.0, 1.0),
              )
              .withLightness(
                (HSLColor.fromColor(tint).lightness * 0.55).clamp(0.32, 0.55),
              )
              .toColor()
        : tint;

    // Brightness-aware tints. Light mode needs stronger fills against
    // a white surface; dark mode is already contrasty so tints stay
    // subtle. Tile background keeps the LIGHT pastel for visual
    // hierarchy; icon circle uses the SATURATED variant.
    final gradientStart = tint.withValues(alpha: isLight ? 0.55 : 0.28);
    final gradientEnd = tint.withValues(alpha: isLight ? 0.25 : 0.08);
    final borderColor = tint.withValues(alpha: isLight ? 0.55 : 0.35);
    final iconCircleStart = isLight
        ? saturatedTint
        : tint.withValues(alpha: 0.55);
    final iconCircleEnd = isLight
        ? saturatedTint.withValues(alpha: 0.85)
        : tint.withValues(alpha: 0.30);
    final iconColor = Colors.white;
    final echoColor = tint.withValues(alpha: isLight ? 0.22 : 0.10);

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(22),
      clipBehavior: Clip.antiAlias,
      child: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [gradientStart, gradientEnd],
          ),
          border: Border.all(color: borderColor, width: 1.2),
          borderRadius: BorderRadius.circular(22),
          boxShadow: [
            BoxShadow(
              color: tint.withValues(alpha: isLight ? 0.18 : 0.08),
              blurRadius: 14,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: InkWell(
          onTap: () => feature.onTap(context),
          borderRadius: BorderRadius.circular(22),
          splashColor: tint.withValues(alpha: 0.18),
          highlightColor: tint.withValues(alpha: 0.08),
          child: Stack(
            children: [
              // Decorative "echo" of the icon in the bottom-right —
              // makes the card recognisable from across the screen.
              // SVG illustrations get a larger echo (they're more
              // distinctive at scale); fallback Lucide icons use the
              // same icon at lower opacity.
              Positioned(
                right: feature.svgAsset != null ? -8 : -12,
                bottom: feature.svgAsset != null ? -10 : -16,
                child: feature.svgAsset != null
                    ? Opacity(
                        opacity: isLight ? 0.18 : 0.12,
                        child: SvgPicture.asset(
                          feature.svgAsset!,
                          width: 110,
                          height: 110,
                          fit: BoxFit.contain,
                        ),
                      )
                    : Icon(feature.icon, size: 96, color: echoColor),
              ),
              // Foreground content
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Icon in a circular image plate with its own glow.
                    // SVG assets render in full color so the tile feels
                    // like a pictorial service shortcut, not a flat glyph.
                    Container(
                      padding: EdgeInsets.all(
                        feature.svgAsset != null ? 6 : 11,
                      ),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: feature.svgAsset != null
                              ? [
                                  Colors.white.withValues(
                                    alpha: isLight ? 0.92 : 0.26,
                                  ),
                                  tint.withValues(alpha: isLight ? 0.18 : 0.22),
                                ]
                              : [iconCircleStart, iconCircleEnd],
                        ),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: Colors.white.withValues(
                            alpha: isLight ? 0.72 : 0.18,
                          ),
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: tint.withValues(
                              alpha: isLight ? 0.40 : 0.25,
                            ),
                            blurRadius: 8,
                            offset: const Offset(0, 3),
                          ),
                        ],
                      ),
                      child: feature.svgAsset != null
                          ? SvgPicture.asset(
                              feature.svgAsset!,
                              width: 38,
                              height: 38,
                              fit: BoxFit.contain,
                            )
                          : Icon(feature.icon, color: iconColor, size: 22),
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          feature.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w800,
                            height: 1.1,
                            color: cs.onSurface,
                          ),
                        ),
                        if (feature.description != null &&
                            feature.description!.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            feature.description!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.70),
                              fontSize: 11,
                              height: 1.2,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              // Badge in the top-right
              if (badge != null)
                Positioned(
                  top: 10,
                  right: 10,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: tint,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: [
                        BoxShadow(
                          color: tint.withValues(alpha: 0.45),
                          blurRadius: 6,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    child: Text(
                      badge!,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
