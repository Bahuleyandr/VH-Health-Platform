import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/features/bloodbank/models/blood_request.dart';
import 'package:vhhealth_staff/features/bloodbank/services/blood_bank_gateway.dart';

void main() {
  test('posts a typed request to the canonical endpoint', () async {
    final transport = _FakeTransport();
    final gateway = ApiBloodBankGateway(transport);
    const payload = BloodRequestPayload(
      patientUid: 'a9999999-9999-4999-8999-999999999a03',
      bloodGroup: 'AB-',
      units: 1,
      component: BloodComponent.platelets,
      clinicalIndication: 'Active bleeding',
      urgency: BloodUrgency.emergency,
    );

    final response = await gateway.createRequest(payload);

    expect(response.statusCode, 201);
    expect(transport.posts, [
      _CapturedRequest('/blood-bank/request', payload.toJson()),
    ]);
  });
}

class _FakeTransport implements BloodBankTransport {
  final posts = <_CapturedRequest>[];

  @override
  Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
  }) async => const ApiResponse(statusCode: 200, isSuccess: true, data: []);

  @override
  Future<ApiResponse> post(String path, {Map<String, dynamic>? body}) async {
    posts.add(_CapturedRequest(path, body));
    return const ApiResponse(statusCode: 201, isSuccess: true, data: {});
  }
}

class _CapturedRequest {
  final String path;
  final Map<String, dynamic>? body;

  const _CapturedRequest(this.path, this.body);

  @override
  bool operator ==(Object other) =>
      other is _CapturedRequest &&
      other.path == path &&
      _mapsEqual(other.body, body);

  @override
  int get hashCode => Object.hash(path, body.toString());
}

bool _mapsEqual(Map<String, dynamic>? left, Map<String, dynamic>? right) {
  if (identical(left, right)) return true;
  if (left == null || right == null || left.length != right.length) {
    return false;
  }
  return left.entries.every((entry) => right[entry.key] == entry.value);
}
