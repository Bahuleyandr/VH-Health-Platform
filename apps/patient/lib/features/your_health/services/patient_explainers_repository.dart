import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/models/patient_explainer.dart';

abstract class PatientExplainersRepository {
  const PatientExplainersRepository();

  Future<List<PatientExplainer>> listExplainers();

  Future<PatientExplainer> getExplainer(int reviewId);
}

class ApiPatientExplainersRepository implements PatientExplainersRepository {
  const ApiPatientExplainersRepository();

  @override
  Future<List<PatientExplainer>> listExplainers() async {
    final response = await ApiClient.get('/portal/explainers');
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Failed to load explainers'));
    }

    return response.dataAsList().whereType<Map>().map((row) {
      return PatientExplainer.fromJson(row.cast<String, dynamic>());
    }).toList();
  }

  @override
  Future<PatientExplainer> getExplainer(int reviewId) async {
    final response = await ApiClient.get('/portal/explainers/$reviewId');
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Failed to load explainer'));
    }

    return PatientExplainer.fromJson(response.dataAsMap());
  }
}
