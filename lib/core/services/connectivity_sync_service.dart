// lib/core/services/connectivity_sync_service.dart
//
// Thin re-export of the core implementation. The real code lives in
// `vhhealth_core` (Phase 5.5) so the patient app shares the same queue +
// badge UX. Existing staff imports continue to resolve; new code should
// prefer importing from `vhhealth_core` directly.

export 'package:vhhealth_core/services/connectivity_sync_service.dart';
