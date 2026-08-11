import '../../../core/services/api_client.dart';
import '../models/blood_request.dart';

abstract interface class BloodBankTransport {
  Future<ApiResponse> get(String path, {Map<String, String>? queryParameters});

  Future<ApiResponse> post(String path, {Map<String, dynamic>? body});
}

class ApiClientBloodBankTransport implements BloodBankTransport {
  const ApiClientBloodBankTransport();

  @override
  Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
  }) => ApiClient.get(path, queryParameters: queryParameters);

  @override
  Future<ApiResponse> post(String path, {Map<String, dynamic>? body}) =>
      ApiClient.post(path, body: body);
}

abstract interface class BloodBankGateway {
  Future<ApiResponse> getInventory();

  Future<ApiResponse> getIssuedUnits();

  Future<ApiResponse> createRequest(BloodRequestPayload payload);
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
  Future<ApiResponse> createRequest(BloodRequestPayload payload) =>
      _transport.post('/blood-bank/request', body: payload.toJson());
}
