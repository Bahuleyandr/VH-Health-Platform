import 'api_client.dart';

class BiomedCmmsApiService {
  BiomedCmmsApiService._();

  static const _basePath = '/clinical-ai/clinical/biomed-cmms';

  static Future<Map<String, dynamic>> getMyWorkOrders() async {
    final response = await ApiClient.get('$_basePath/work-orders/my');
    final data = response.data;
    if (data is Map<String, dynamic>) return data;
    return <String, dynamic>{};
  }

  static Future<Map<String, dynamic>> startWorkOrder({
    required String workOrderId,
  }) async {
    final response = await ApiClient.post(
      '$_basePath/work-orders/$workOrderId/start',
      body: const <String, dynamic>{},
    );
    final data = response.data;
    return data is Map<String, dynamic> ? data : <String, dynamic>{};
  }

  static Future<Map<String, dynamic>> completeWorkOrder({
    required String workOrderId,
    String? completionNotes,
    List<Map<String, dynamic>> partsUsed = const [],
    double? costAmount,
  }) async {
    final notes = completionNotes?.trim() ?? '';
    final body = <String, dynamic>{
      if (notes.isNotEmpty) 'completion_notes': notes,
      if (partsUsed.isNotEmpty) 'parts_used': partsUsed,
    };
    if (costAmount != null) {
      body['cost_amount'] = costAmount;
    }
    final response = await ApiClient.post(
      '$_basePath/work-orders/$workOrderId/complete',
      body: body,
    );
    final data = response.data;
    return data is Map<String, dynamic> ? data : <String, dynamic>{};
  }
}
