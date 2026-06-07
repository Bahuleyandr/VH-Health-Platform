// lib/core/providers/user_provider.dart
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Centralized user state — the single source of truth for the signed-in
/// patient's identity.
///
/// Provides the current user's phone and name to the widget tree via Provider,
/// and persists them in secure storage. Screens read this through
/// `context.read<UserProvider>()` / `context.watch<UserProvider>()` rather
/// than being threaded `phone`/`name` through their constructors.
///
/// [instance] exposes the live provider to context-free service code
/// (logout, 401 session-expiry) — it is a *reference* to the one provider
/// the widget tree owns, not a parallel copy of its state.
class UserProvider extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();

  /// The live provider instance, for service-layer code with no
  /// `BuildContext`. Set in the constructor; the app builds exactly one.
  static UserProvider? instance;

  UserProvider() {
    instance = this;
  }

  String _phone = '';
  String _name = 'Guest';
  String _hospitalNumber = '';

  String get phone => _phone;
  String get name => _name;
  String get hospitalNumber => _hospitalNumber;

  bool get isGuest => _phone.isEmpty || _phone == 'guest';

  /// Load phone and name from secure storage (called once at app startup).
  Future<void> loadFromStorage() async {
    _phone = await _storage.read(key: 'user_phone') ?? '';
    _name = await _storage.read(key: 'user_name') ?? 'Guest';
    _hospitalNumber = await _storage.read(key: 'hospital_number') ?? '';
    notifyListeners();
  }

  /// Set user data after login and persist to secure storage.
  Future<void> setUser(
    String phone,
    String name, {
    String? hospitalNumber,
  }) async {
    _phone = phone;
    _name = name;
    _hospitalNumber = hospitalNumber ?? '';
    notifyListeners();
    await _storage.write(key: 'user_phone', value: phone);
    await _storage.write(key: 'user_name', value: name);
    if (hospitalNumber != null) {
      await _storage.write(key: 'hospital_number', value: hospitalNumber);
    } else {
      await _storage.delete(key: 'hospital_number');
    }
  }

  /// Start an explicit guest session. Guest sessions can see public app
  /// surfaces, but never carry a JWT or patient identifiers.
  Future<void> setGuest() async {
    _phone = 'guest';
    _name = 'Guest';
    _hospitalNumber = '';
    notifyListeners();
    await Future.wait([
      _storage.delete(key: 'jwt'),
      _storage.write(key: 'user_phone', value: 'guest'),
      _storage.write(key: 'user_name', value: 'Guest'),
      _storage.delete(key: 'user_id'),
      _storage.delete(key: 'patient_id'),
      _storage.delete(key: 'firebase_uid'),
      _storage.delete(key: 'hospital_number'),
      _storage.delete(key: 'isNewUser'),
      _storage.delete(key: 'fetched_dashboard'),
    ]);
  }

  /// Clear user data on logout.
  Future<void> clear() async {
    _phone = '';
    _name = 'Guest';
    _hospitalNumber = '';
    notifyListeners();
    // Note: storage.deleteAll() is called separately during logout
  }
}
