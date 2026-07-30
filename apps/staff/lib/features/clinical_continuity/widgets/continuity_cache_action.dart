import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../../../l10n/app_strings.dart';

class ContinuityCacheAction extends StatelessWidget {
  const ContinuityCacheAction({super.key});

  @override
  Widget build(BuildContext context) {
    if (!TenantConfig.clinicalContinuityCacheEnabled) {
      return const SizedBox.shrink();
    }
    final label = AppStrings.of(context).lookup('continuity.action.open_cache');
    return IconButton(
      tooltip: label,
      onPressed: () => context.push('/clinical-continuity'),
      icon: const Icon(Icons.health_and_safety_outlined),
    );
  }
}
