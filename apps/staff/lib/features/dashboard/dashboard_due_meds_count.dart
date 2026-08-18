/// Parse the nurse "due meds" count from a `GET /clinical/mar/due` response.
///
/// The backend returns the due list directly under the `data` envelope key
/// (`success(res, records)` — a List), but older/degraded shapes may wrap it
/// in a map. Returns `null` when the shape is unrecognised so the caller can
/// preserve the "never show a false 0" design (an unknown response leaves the
/// tile blank rather than reporting zero due meds).
int? dashboardDueMedsCountFromRaw(Object? raw) {
  if (raw is List) return raw.length;
  if (raw is Map) {
    final data = raw['data'];
    if (data is List) return data.length;
    if (data is Map) {
      final list = data['due'] ?? data['medications'] ?? data['items'];
      if (list is List) return list.length;
    }
  }
  return null;
}
