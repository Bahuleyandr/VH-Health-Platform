// lib/core/providers/dependents_provider.dart
//
// Holds the list of minor dependents the logged-in guardian has linked
// (migration 202: `users.guardian_user_id`), plus the currently-active
// profile. `activeDependent == null` means the guardian is viewing their
// own profile.
//
// When `activeDependent` is non-null, every authenticated HTTP call made
// through `VHHttpClient` automatically attaches the `X-Acting-As-Uid`
// header. The backend's `jwtMiddleware` verifies guardianship + tenant
// parity, then rewrites `req.user` to the dependent's identity for the
// remainder of the request — so dashboard / appointments / records /
// prescriptions / pharmacy / etc. all return the *dependent's* data
// without per-endpoint plumbing. Switching back to the guardian's
// profile clears the resolver and subsequent calls drop the header.

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';

@immutable
class Dependent {
  final int id;
  final String uid;
  final String name;
  final String? phone;
  final String? birthday;
  final String? gender;
  final bool isMinor;
  final double? weightKg;
  final String? relationship;
  final String? linkedAt;

  const Dependent({
    required this.id,
    required this.uid,
    required this.name,
    this.phone,
    this.birthday,
    this.gender,
    required this.isMinor,
    this.weightKg,
    this.relationship,
    this.linkedAt,
  });

  factory Dependent.fromJson(Map<String, dynamic> json) {
    return Dependent(
      id: (json['id'] as num).toInt(),
      uid: json['uid'] as String,
      name: json['name'] as String? ?? 'Dependent',
      phone: json['phone'] as String?,
      birthday: json['birthday']?.toString(),
      gender: json['gender'] as String?,
      isMinor: json['is_minor'] as bool? ?? false,
      weightKg: (json['weight_kg'] as num?)?.toDouble(),
      relationship: json['guardian_relationship'] as String?,
      linkedAt: json['linked_at']?.toString(),
    );
  }
}

class DependentsProvider extends ChangeNotifier {
  /// The live provider instance, for service-layer code with no
  /// `BuildContext` (LogoutService clears it on EVERY logout path — the
  /// automatic paths have no context, and a survivor here both shows the
  /// prior guardian's roster to the next account and keeps attaching a
  /// stale `X-Acting-As-Uid` header that 403s the new session). Mirrors
  /// [UserProvider.instance]: a reference to the one provider the widget
  /// tree owns, not a parallel copy of its state.
  static DependentsProvider? instance;

  DependentsProvider() {
    instance = this;
    // Register the acting-as resolver with the shared HTTP client so every
    // authenticated request the patient app makes attaches the right header
    // based on the currently-active profile. The closure captures `this`,
    // so the resolver always reflects the latest `_active` without needing
    // explicit re-registration on every switch.
    VHHttpClient.actingAsUidProvider = () => _active?.uid;
  }

  List<Dependent> _dependents = const [];
  Dependent? _active;
  bool _loading = false;
  String? _error;
  bool _loadedOnce = false;
  bool _disposed = false;

  List<Dependent> get dependents => _dependents;
  Dependent? get activeDependent => _active;
  bool get loading => _loading;
  String? get error => _error;
  bool get hasDependents => _dependents.isNotEmpty;
  bool get isViewingDependent => _active != null;

  /// Load (or reload) the dependents list from the backend.
  ///
  /// Safe to call repeatedly — concurrent calls coalesce via the loading
  /// flag. The active selection is preserved across reloads when the
  /// previously-active dependent is still in the new list.
  Future<void> loadDependents({
    bool force = false,
    required String failureMessage,
  }) async {
    if (_disposed) return;
    if (_loading) return;
    if (_loadedOnce && !force) return;
    _loading = true;
    _error = null;
    notifyListeners();

    try {
      final response = await ApiClient.get('/users/dependents');
      if (_disposed) return;
      if (response.isSuccess) {
        final raw = response.data;
        List<dynamic> list = const [];
        if (raw is Map<String, dynamic>) {
          final inner = raw['dependents'];
          if (inner is List) list = inner;
        } else if (raw is List) {
          list = raw;
        }
        _dependents = list
            .whereType<Map<String, dynamic>>()
            .map(Dependent.fromJson)
            .toList(growable: false);
        _loadedOnce = true;

        // Preserve active selection if the dependent is still linked;
        // otherwise drop it back to "self" rather than leaving a dangling
        // reference.
        final activeUid = _active?.uid;
        if (activeUid != null) {
          final match = _dependents.where((d) => d.uid == activeUid).toList();
          _active = match.isEmpty ? null : match.first;
        }
      } else {
        _error = response.failureMessage(failureMessage);
      }
    } catch (e) {
      if (_disposed) return;
      if (kDebugMode) debugPrint('DependentsProvider.loadDependents: $e');
      _error = failureMessage;
    } finally {
      if (!_disposed) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  /// Switch the active profile. Pass `null` to revert to the guardian's
  /// own profile.
  void switchTo(Dependent? dep) {
    if (_disposed) return;
    if (dep != null && !_dependents.any((d) => d.uid == dep.uid)) {
      // Refuse to switch to a dependent not in the loaded list — protects
      // against stale UI state after an unlink.
      return;
    }
    if (_active?.uid == dep?.uid) return;
    _active = dep;
    notifyListeners();
  }

  /// Link a new dependent by phone or UID. Returns the freshly-linked
  /// Dependent on success and rethrows the parsed error message on failure
  /// (so the caller can surface it in a SnackBar / inline form error).
  Future<Dependent> linkDependent({
    required String dependentUidOrPhone,
    required String failureMessage,
    String? relationship,
  }) async {
    if (_disposed) {
      throw const DependentApiException('Dependents provider is disposed');
    }
    final response = await ApiClient.post(
      '/users/dependents/link',
      body: {
        'dependent_uid_or_phone': dependentUidOrPhone.trim(),
        if (relationship != null && relationship.isNotEmpty)
          'relationship': relationship,
      },
    );

    if (!response.isSuccess) {
      throw DependentApiException(response.failureMessage(failureMessage));
    }

    final raw = response.data;
    if (_disposed) {
      throw const DependentApiException('Dependents provider is disposed');
    }
    Map<String, dynamic>? depJson;
    if (raw is Map<String, dynamic>) {
      final inner = raw['dependent'];
      if (inner is Map<String, dynamic>) depJson = inner;
    }
    if (depJson == null) {
      throw DependentApiException('Backend returned no dependent payload');
    }
    await PatientCacheInvalidation.afterDependentMutation();
    if (_disposed) {
      throw const DependentApiException('Dependents provider is disposed');
    }
    final dep = Dependent.fromJson(depJson);

    final existingIdx = _dependents.indexWhere((d) => d.uid == dep.uid);
    if (existingIdx == -1) {
      _dependents = [..._dependents, dep];
    } else {
      final next = [..._dependents];
      next[existingIdx] = dep;
      _dependents = next;
    }
    _loadedOnce = true;
    notifyListeners();
    return dep;
  }

  /// Unlink a dependent and remove it from the local list.
  Future<void> unlinkDependent(
    int dependentId, {
    required String failureMessage,
  }) async {
    if (_disposed) return;
    final response = await ApiClient.delete('/users/dependents/$dependentId');
    if (_disposed) return;
    if (!response.isSuccess) {
      throw DependentApiException(response.failureMessage(failureMessage));
    }
    await PatientCacheInvalidation.afterDependentMutation();
    if (_disposed) return;
    _dependents = _dependents
        .where((d) => d.id != dependentId)
        .toList(growable: false);
    if (_active?.id == dependentId) {
      _active = null;
    }
    notifyListeners();
  }

  void clear() {
    if (_disposed) return;
    _dependents = const [];
    _active = null;
    _loading = false;
    _error = null;
    _loadedOnce = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    if (identical(instance, this)) instance = null;
    // Tear down the resolver so a torn-down provider doesn't keep
    // returning a stale uid into a still-running HTTP client (matters
    // mainly for tests; the production app keeps one provider alive).
    VHHttpClient.actingAsUidProvider = null;
    super.dispose();
  }
}

class DependentApiException implements Exception {
  final String message;
  const DependentApiException(this.message);

  @override
  String toString() => message;
}
