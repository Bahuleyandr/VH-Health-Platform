// lib/api/vh_auth_interceptor.dart
//
// Chopper interceptor that mirrors VHHttpClient's auth behaviour:
//   * Injects `x-api-key` + `Authorization: Bearer <jwt>` on every request.
//   * On 401, delegates to VHHttpClient.refreshAuthToken() (shared single-
//     flight refresh), then retries the request once with the rotated JWT.
//
// Install on the generated client:
//
//   final api = Openapi.create(
//     baseUrl: Uri.parse(ApiConfig.baseUrl),
//     interceptors: [VHAuthInterceptor()],
//   );

import 'package:chopper/chopper.dart';

import '../config/api_config.dart';
import '../services/auth_service.dart';
import '../services/http_client.dart';

class VHAuthInterceptor implements Interceptor {
  const VHAuthInterceptor();

  @override
  Future<Response<BodyType>> intercept<BodyType>(Chain<BodyType> chain) async {
    var request = await _attachHeaders(chain.request);
    var response = await chain.proceed(request);

    if (response.statusCode == 401) {
      final refreshed = await VHHttpClient.refreshAuthToken();
      if (refreshed) {
        request = await _attachHeaders(chain.request);
        response = await chain.proceed(request);
      }
      // If refresh failed, VHHttpClient has already fired onSessionExpired;
      // return the 401 so the caller can surface the error state.
    }
    return response;
  }

  Future<Request> _attachHeaders(Request request) async {
    final jwt = await AuthService.getJwt();
    final headers = {
      ...request.headers,
      if (ApiConfig.apiKey.isNotEmpty) 'x-api-key': ApiConfig.apiKey,
      if (jwt != null && jwt.isNotEmpty) 'Authorization': 'Bearer $jwt',
    };
    return request.copyWith(headers: headers);
  }
}
