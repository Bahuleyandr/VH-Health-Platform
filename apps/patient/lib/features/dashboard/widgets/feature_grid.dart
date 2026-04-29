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

  /// Per-feature badge labels keyed by [FeatureIconData.label]. Pass an
  /// empty map (or omit) for no badges. Keep labels short — they render
  /// in a small pill in the top-right of each card.
  final Map<String, String> badges;

  const FeatureGrid({
    super.key,
    required this.features,
    this.badges = const {},
  });

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 14,
        crossAxisSpacing: 14,
        // Slightly taller than wide — leaves room for icon + label + badge
        childAspectRatio: 1.3,
      ),
      itemCount: features.length,
      itemBuilder: (context, i) {
        final f = features[i];
        return _FeatureCard(feature: f, badge: badges[f.label]);
      },
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
                    ? SvgPicture.asset(
                        feature.svgAsset!,
                        width: 110,
                        height: 110,
                        colorFilter: ColorFilter.mode(
                          echoColor,
                          BlendMode.srcIn,
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
                    // Icon in a colored circle with its own gradient +
                    // glow. Foreground glyph is either the hand-drawn
                    // SVG (when supplied) tinted white, or the legacy
                    // Lucide icon. SVG gets slightly more padding +
                    // bigger render size since the illustrations are
                    // more detailed than icon glyphs.
                    Container(
                      padding: EdgeInsets.all(
                        feature.svgAsset != null ? 9 : 11,
                      ),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [iconCircleStart, iconCircleEnd],
                        ),
                        shape: BoxShape.circle,
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
                              width: 28,
                              height: 28,
                              colorFilter: ColorFilter.mode(
                                iconColor,
                                BlendMode.srcIn,
                              ),
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
