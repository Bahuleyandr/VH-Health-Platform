import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/models/whats_next_item.dart';

abstract class WhatsNextRepository {
  const WhatsNextRepository();

  Future<WhatsNextBundle> getWhatsNext();
}

class ApiWhatsNextRepository implements WhatsNextRepository {
  const ApiWhatsNextRepository();

  @override
  Future<WhatsNextBundle> getWhatsNext() async {
    final response = await ApiClient.get('/portal/care-plans/whats-next');
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Failed to load care plan');
    }

    return WhatsNextBundle.fromJson(response.dataAsMap());
  }
}
