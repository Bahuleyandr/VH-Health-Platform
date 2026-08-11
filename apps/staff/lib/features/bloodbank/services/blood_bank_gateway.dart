import '../../../core/services/api_client.dart';
import '../models/blood_request.dart';

abstract interface class BloodBankTransport {
  Future<ApiResponse> get(String path, {Map<String, String>? queryParameters});

  Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    String? idempotencyKey,
  });
}

class ApiClientBloodBankTransport implements BloodBankTransport {
  const ApiClientBloodBankTransport();

  @override
  Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
  }) => ApiClient.get(path, queryParameters: queryParameters);

  @override
  Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    String? idempotencyKey,
  }) => ApiClient.post(path, body: body, idempotencyKey: idempotencyKey);
}

abstract interface class BloodBankGateway {
  Future<ApiResponse> getInventory();

  Future<ApiResponse> getIssuedUnits();

  Future<ApiResponse> createRequest(
    BloodRequestPayload payload, {
    required String idempotencyKey,
  });
}

class ApiBloodBankGateway implements BloodBankGateway {
  final BloodBankTransport _transport;

  const ApiBloodBankGateway([
    this._transport = const ApiClientBloodBankTransport(),
  ]);

  @override
  Future<ApiResponse> getInventory() => _transport.get('/blood-bank/inventory');

  @override
  Future<ApiResponse> getIssuedUnits() => _transport.get(
    '/blood-bank/units',
    queryParameters: const {'status': 'issued'},
  );

  @override
  Future<ApiResponse> createRequest(
    BloodRequestPayload payload, {
    required String idempotencyKey,
  }) {
    final key = idempotencyKey.trim();
    if (key.isEmpty || key.length > 200) {
      throw ArgumentError.value(
        idempotencyKey,
        'idempotencyKey',
        'must contain between 1 and 200 characters',
      );
    }
    return _transport.post(
      '/blood-bank/request',
      body: payload.toJson(),
      idempotencyKey: key,
    );
  }
}
