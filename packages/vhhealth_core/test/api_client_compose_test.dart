// test/api_client_compose_test.dart
//
// Phase-4 compose smoke test. NOT a behavioral test — no network.
//
// Proves the OpenAPI-generated chopper client (`Openapi`) and the hand-written
// `VHAuthInterceptor` wrapper still compose: the client's `.create(...)`
// signature accepts our interceptor list, the result is a real
// `ChopperService`, and `VHAuthInterceptor` still satisfies chopper's
// `Interceptor` contract. If the generated `.create(...)` signature or the
// interceptor contract ever drift apart, this fails fast at compile time.
//
// The generated client lives in `lib/api/generated/` and is GITIGNORED —
// regenerate it (`melos run codegen`) before running this test.

import 'package:chopper/chopper.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/api/vh_auth_interceptor.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';

void main() {
  group('generated client + VHAuthInterceptor compose', () {
    test(
      'Openapi.create accepts the interceptor and yields a ChopperService',
      () {
        // No network: a base URL + interceptor list, never a request.
        final client = Openapi.create(
          baseUrl: Uri.parse('http://localhost:5000/api/v1'),
          interceptors: const [VHAuthInterceptor()],
        );

        expect(client, isA<ChopperService>());
      },
    );

    test('VHAuthInterceptor satisfies chopper\'s Interceptor contract', () {
      expect(const VHAuthInterceptor(), isA<Interceptor>());
    });
  });
}
