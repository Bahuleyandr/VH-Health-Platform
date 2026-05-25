/**
 * DICOM/PACS metadata adapter for Imaging AI.
 *
 * Raw pixels stay inside PACS. This adapter imports only study metadata
 * through DICOMweb QIDO-RS or Orthanc's native /tools/find endpoint so
 * the existing Imaging AI workflow can register a study and wait for a
 * radiologist-reviewed inference result.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const SUPPORTED_PROVIDERS = new Set(['dicomweb', 'orthanc', 'orthanc_native', 'dcm4chee']);

const DICOM_TAGS = {
  accessionNumber: '00080050',
  bodyPart: '00180015',
  modalitiesInStudy: '00080061',
  patientId: '00100020',
  patientName: '00100010',
  seriesCount: '00201206',
  instanceCount: '00201208',
  studyDate: '00080020',
  studyDescription: '00081030',
  studyInstanceUid: '0020000D',
};

function clean(text) {
  return String(text || '').trim();
}

function splitCsv(value) {
  return clean(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRegion(value) {
  return clean(value).toUpperCase();
}

function regionAllowed(tenantRegion, allowedRegions) {
  if (!allowedRegions.length) return true;
  if (!tenantRegion) return false;
  const normalizedTenantRegion = normalizeRegion(tenantRegion);
  return allowedRegions.map(normalizeRegion).includes(normalizedTenantRegion);
}

export function normalizePacsProvider(provider = null) {
  const normalized = clean(provider || process.env.CLINICAL_AI_PACS_PROVIDER || 'none').toLowerCase();
  if (normalized === 'none' || normalized === 'off' || normalized === 'disabled') return 'none';
  if (normalized === 'orthanc-native') return 'orthanc_native';
  if (normalized === 'dicom-web') return 'dicomweb';
  return SUPPORTED_PROVIDERS.has(normalized) ? normalized : 'none';
}

function resolveApiMode(provider, env) {
  const explicit = clean(env.CLINICAL_AI_PACS_API_MODE).toLowerCase();
  if (explicit === 'orthanc_native' || explicit === 'orthanc-native') return 'orthanc_native';
  if (explicit === 'dicomweb' || explicit === 'dicom-web') return 'dicomweb';
  return provider === 'orthanc_native' ? 'orthanc_native' : 'dicomweb';
}

export function resolvePacsConfig({
  provider = null,
  tenantRegion = null,
  env = process.env,
} = {}) {
  const normalizedProvider = normalizePacsProvider(provider || env.CLINICAL_AI_PACS_PROVIDER);
  const baseUrl = clean(env.CLINICAL_AI_PACS_BASE_URL || env.ORTHANC_URL || env.DCM4CHEE_URL).replace(/\/+$/, '');
  const allowedRegions = splitCsv(env.CLINICAL_AI_PACS_ALLOWED_REGIONS || env.CLINICAL_AI_PACS_REGIONS);
  const isRegionAllowed = regionAllowed(tenantRegion, allowedRegions);

  if (normalizedProvider === 'none') {
    return {
      configured: false,
      reason: 'pacs_provider_not_configured',
      provider: 'none',
      api_mode: 'none',
      base_url_configured: Boolean(baseUrl),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
    };
  }
  if (!baseUrl) {
    return {
      configured: false,
      reason: 'pacs_base_url_not_configured',
      provider: normalizedProvider,
      api_mode: resolveApiMode(normalizedProvider, env),
      base_url_configured: false,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
    };
  }
  if (!isRegionAllowed) {
    return {
      configured: false,
      reason: 'tenant_region_not_allowed_for_pacs',
      provider: normalizedProvider,
      api_mode: resolveApiMode(normalizedProvider, env),
      base_url_configured: true,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
    };
  }

  return {
    configured: true,
    provider: normalizedProvider,
    api_mode: resolveApiMode(normalizedProvider, env),
    base_url: baseUrl,
    base_url_configured: true,
    username: env.CLINICAL_AI_PACS_USERNAME || env.ORTHANC_USERNAME || '',
    password: env.CLINICAL_AI_PACS_PASSWORD || env.ORTHANC_PASSWORD || '',
    timeout_ms: Math.max(Number.parseInt(env.CLINICAL_AI_PACS_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS, 1000),
    tenant_region: tenantRegion || null,
    allowed_regions: allowedRegions,
  };
}

export function describePacsConfig(options = {}) {
  const config = resolvePacsConfig(options);
  return {
    configured: config.configured,
    reason: config.reason || null,
    provider: config.provider,
    api_mode: config.api_mode,
    base_url_configured: config.base_url_configured,
    auth_configured: Boolean(config.username && config.password),
    timeout_ms: config.timeout_ms || null,
    tenant_region: config.tenant_region || null,
    allowed_regions: config.allowed_regions || [],
  };
}

function valueAt(dataset, tag) {
  const raw = dataset?.[tag]?.Value ?? dataset?.[tag]?.value ?? dataset?.[tag];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function dicomText(value) {
  if (Array.isArray(value)) return dicomText(value[0]);
  if (value && typeof value === 'object') {
    return clean(value.Alphabetic || value.alphabetic || value.Ideographic || value.Phonetic || JSON.stringify(value));
  }
  return clean(value);
}

function dicomNumber(value, fallback = 1) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dicomDate(value) {
  const raw = clean(Array.isArray(value) ? value[0] : value);
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw || null;
}

function firstModality(value) {
  const raw = Array.isArray(value) ? value : [value];
  const first = raw.map(dicomText).find(Boolean);
  if (!first) return null;
  return first.split('\\').map((part) => part.trim()).filter(Boolean)[0]?.toUpperCase() || null;
}

export function normalizeDicomwebStudyMetadata(payload) {
  const dataset = Array.isArray(payload) ? payload[0] : payload;
  if (!dataset || typeof dataset !== 'object') return null;
  const studyInstanceUid = dicomText(valueAt(dataset, DICOM_TAGS.studyInstanceUid));
  if (!studyInstanceUid) return null;

  return {
    study_instance_uid: studyInstanceUid,
    accession_number: dicomText(valueAt(dataset, DICOM_TAGS.accessionNumber)) || null,
    modality: firstModality(valueAt(dataset, DICOM_TAGS.modalitiesInStudy)) || 'OT',
    body_part: dicomText(valueAt(dataset, DICOM_TAGS.bodyPart)) || null,
    study_date: dicomDate(valueAt(dataset, DICOM_TAGS.studyDate)),
    series_count: dicomNumber(valueAt(dataset, DICOM_TAGS.seriesCount), 1),
    instance_count: dicomNumber(valueAt(dataset, DICOM_TAGS.instanceCount), 1),
    study_description: dicomText(valueAt(dataset, DICOM_TAGS.studyDescription)) || null,
    dicom_patient_identifier: dicomText(valueAt(dataset, DICOM_TAGS.patientId)) || null,
    dicom_patient_name_present: Boolean(dicomText(valueAt(dataset, DICOM_TAGS.patientName))),
    source_format: 'dicomweb',
  };
}

export function normalizeOrthancStudyMetadata(payload) {
  const study = Array.isArray(payload) ? payload[0] : payload;
  if (!study || typeof study !== 'object') return null;
  const tags = study.MainDicomTags || study.mainDicomTags || {};
  const patientTags = study.PatientMainDicomTags || study.patientMainDicomTags || {};
  const studyInstanceUid = clean(tags.StudyInstanceUID || study.StudyInstanceUID || study.studyInstanceUid);
  if (!studyInstanceUid) return null;

  return {
    study_instance_uid: studyInstanceUid,
    accession_number: clean(tags.AccessionNumber) || null,
    modality: firstModality(tags.ModalitiesInStudy || tags.Modality || study.Modality) || 'OT',
    body_part: clean(tags.BodyPartExamined) || null,
    study_date: dicomDate(tags.StudyDate),
    series_count: Array.isArray(study.Series) ? Math.max(study.Series.length, 1) : dicomNumber(study.SeriesCount, 1),
    instance_count: Array.isArray(study.Instances) ? Math.max(study.Instances.length, 1) : dicomNumber(study.InstanceCount, 1),
    study_description: clean(tags.StudyDescription) || null,
    dicom_patient_identifier: clean(patientTags.PatientID || study.PatientID) || null,
    dicom_patient_name_present: Boolean(clean(patientTags.PatientName || study.PatientName)),
    source_format: 'orthanc_native',
    pacs_study_id: clean(study.ID || study.id) || null,
  };
}

export function buildDicomwebStudyQueryUrl({ baseUrl, studyInstanceUid = null, accessionNumber = null } = {}) {
  const url = new URL(`${clean(baseUrl).replace(/\/+$/, '')}/studies`);
  if (studyInstanceUid) url.searchParams.set('StudyInstanceUID', studyInstanceUid);
  if (accessionNumber) url.searchParams.set('AccessionNumber', accessionNumber);
  return url.toString();
}

function buildOrthancFindBody({ studyInstanceUid = null, accessionNumber = null } = {}) {
  return {
    Level: 'Study',
    Expand: true,
    Query: {
      ...(studyInstanceUid ? { StudyInstanceUID: studyInstanceUid } : {}),
      ...(accessionNumber ? { AccessionNumber: accessionNumber } : {}),
    },
  };
}

function authHeaders(config) {
  if (!config.username || !config.password) return {};
  const encoded = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

async function fetchJsonWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, payload: null };
    }
    return { ok: true, status: response.status, payload: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPacsStudyMetadata({
  studyInstanceUid = null,
  accessionNumber = null,
  provider = null,
  tenantRegion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resolvePacsConfig({ provider, tenantRegion, env });
  if (!config.configured) {
    return { status: 'skipped', reason: config.reason, config: describePacsConfig({ provider, tenantRegion, env }) };
  }
  if (!studyInstanceUid && !accessionNumber) {
    return { status: 'skipped', reason: 'study_instance_uid_or_accession_required', config: describePacsConfig({ provider, tenantRegion, env }) };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 'skipped', reason: 'fetch_unavailable', config: describePacsConfig({ provider, tenantRegion, env }) };
  }

  const headers = {
    Accept: 'application/dicom+json, application/json',
    ...authHeaders(config),
  };
  const request = config.api_mode === 'orthanc_native'
    ? {
      url: `${config.base_url}/tools/find`,
      options: {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOrthancFindBody({ studyInstanceUid, accessionNumber })),
      },
    }
    : {
      url: buildDicomwebStudyQueryUrl({ baseUrl: config.base_url, studyInstanceUid, accessionNumber }),
      options: { method: 'GET', headers },
    };

  try {
    const response = await fetchJsonWithTimeout(fetchImpl, request.url, request.options, config.timeout_ms);
    if (!response.ok) {
      return {
        status: 'failed',
        reason: 'pacs_request_failed',
        http_status: response.status,
        provider: config.provider,
        api_mode: config.api_mode,
      };
    }
    const study = config.api_mode === 'orthanc_native'
      ? normalizeOrthancStudyMetadata(response.payload)
      : normalizeDicomwebStudyMetadata(response.payload);
    if (!study) {
      return {
        status: 'not_found',
        reason: 'pacs_study_not_found',
        provider: config.provider,
        api_mode: config.api_mode,
      };
    }
    return {
      status: 'found',
      provider: config.provider,
      api_mode: config.api_mode,
      query_url: config.api_mode === 'orthanc_native' ? null : request.url,
      study,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: err?.name === 'AbortError' ? 'pacs_request_timeout' : 'pacs_request_failed',
      provider: config.provider,
      api_mode: config.api_mode,
      error: clean(err?.message),
    };
  }
}

export default {
  buildDicomwebStudyQueryUrl,
  describePacsConfig,
  fetchPacsStudyMetadata,
  normalizeDicomwebStudyMetadata,
  normalizeOrthancStudyMetadata,
  normalizePacsProvider,
  resolvePacsConfig,
};
