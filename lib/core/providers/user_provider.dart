// lib/core/providers/user_provider.dart
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Centralized user state that replaces the static fields on AppRouter.
///
/// Provides the current user's phone and name to the widget tree via Provider,
/// and persists them in secure storage.
class UserProvider extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();

  String _phone = '';
  String _name = 'Guest';

  String get phone => _phone;
  String get name => _name;

  bool get isGuest => _phone.isEmpty || _phone == 'guest';

  /// Load phone and name from secure storage (called once at app startup).
  Future<void> loadFromStorage() async {
    _phone = await _storage.read(key: 'user_phone') ?? '';
    _name = await _storage.read(key: 'user_name') ?? 'Guest';
    notifyListeners();
  }

  /// Set user data after login and persist to secure storage.
  Future<void> setUser(String phone, String name) async {
    _phone = phone;
    _name = name;
    notifyListeners();
    await _storage.write(key: 'user_phone', value: phone);
    await _storage.write(key: 'user_name', value: name);
  }

  /// Clear user data on logout.
  Future<void> clear() async {
    _phone = '';
    _name = 'Guest';
    notifyListeners();
    // Note: storage.deleteAll() is called separately during logout
  }
}
