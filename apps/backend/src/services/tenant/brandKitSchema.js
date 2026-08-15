import { isScanStatusServable, resolveFileScanPolicy } from '../../config/fileScanPolicy.js';
import { AppError } from '../../utils/AppError.js';

export const BRAND_KIT_SCHEMA_VERSION = 1;

export const MOBILE_BRANDING_CONTRACT = Object.freeze({
  identityMode: 'stamped_build',
  tokenColorSource: 'VH_TENANT_PRIMARY',
});

export const BRAND_ASSET_POLICY = Object.freeze({
  logo: {
    label: 'Logo',
    maxBytes: 2 * 1024 * 1024,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  },
  documentLetterhead: {
    label: 'Document letterhead',
    maxBytes: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'],
  },
});

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value, field, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw AppError.badRequest(`${field} must be a string`, 'BRAND_KIT_FIELD_INVALID', { field });
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw AppError.badRequest(`${field} must be ${maxLength} characters or fewer`, 'BRAND_KIT_FIELD_TOO_LONG', { field, maxLength });
  }
  return text;
}

function optionalUrl(value, field, maxLength = 500) {
  const text = optionalText(value, field, maxLength);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    throw AppError.badRequest(`${field} must be a valid HTTP(S) URL`, 'BRAND_KIT_URL_INVALID', { field });
  }
}

function optionalEmail(value, field) {
  const text = optionalText(value, field, 254);
  if (!text) return null;
  if (!EMAIL_RE.test(text)) {
    throw AppError.badRequest(`${field} must be a valid email address`, 'BRAND_KIT_EMAIL_INVALID', { field });
  }
  return text.toLowerCase();
}

function optionalColor(value, field) {
  const text = optionalText(value, field, 16);
  if (!text) return null;
  if (!HEX_COLOR_RE.test(text)) {
    throw AppError.badRequest(`${field} must be a hex color like #007A64`, 'BRAND_KIT_COLOR_INVALID', { field });
  }
  return text.length === 4
    ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toUpperCase()
    : text.toUpperCase();
}

function optionalStorageKey(value, field) {
  const text = optionalText(value, field, 700);
  if (!text) return null;
  if (!text.startsWith('uploads/') || text.includes('..') || text.includes('\\') || text.includes('\0')) {
    throw AppError.badRequest(`${field} must reference a validated upload storage key`, 'BRAND_ASSET_STORAGE_KEY_INVALID', { field });
  }
  return text;
}

function optionalInteger(value, field) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'BRAND_KIT_FIELD_INVALID', { field });
  }
  return num;
}

export function normalizeBrandAsset(value, field) {
  if (value == null || value === '') return null;
  const raw = typeof value === 'string' ? { storageKey: value } : value;
  if (!isObject(raw)) {
    throw AppError.badRequest(`${field} must be an object`, 'BRAND_ASSET_INVALID', { field });
  }
  const storageKey = optionalStorageKey(raw.storageKey ?? raw.storage_key, `${field}.storageKey`);
  if (!storageKey) return null;
  return {
    storageKey,
    mimeType: optionalText(raw.mimeType ?? raw.mime_type, `${field}.mimeType`, 120),
    fileSize: optionalInteger(raw.fileSize ?? raw.file_size, `${field}.fileSize`),
    altText: optionalText(raw.altText ?? raw.alt_text, `${field}.altText`, 160),
    url: optionalUrl(raw.url, `${field}.url`),
  };
}

export function normalizeBrandKit(value = {}, options = {}) {
  const raw = isObject(value) ? value : {};
  const assets = isObject(raw.assets) ? raw.assets : {};
  const document = isObject(raw.document) ? raw.document : {};
  const email = isObject(raw.email) ? raw.email : {};
  const fallbackName = options.fallbackName ? optionalText(options.fallbackName, 'fallbackName', 200) : null;

  const name = optionalText(raw.name, 'branding.name', 120) || fallbackName;
  const legalName = optionalText(raw.legalName ?? raw.legal_name, 'branding.legalName', 200);
  const supportEmail = optionalEmail(raw.supportEmail ?? raw.support_email, 'branding.supportEmail');
  const replyTo = optionalEmail(email.replyTo ?? email.reply_to ?? raw.replyTo ?? raw.reply_to, 'branding.email.replyTo');
  const logoAsset = normalizeBrandAsset(assets.logo ?? raw.logoAsset ?? raw.logo_asset ?? raw.logoStorageKey, 'branding.assets.logo');
  const letterheadAsset = normalizeBrandAsset(
    assets.documentLetterhead ?? assets.document_letterhead ?? document.letterheadAsset ?? raw.documentLetterheadAsset,
    'branding.assets.documentLetterhead',
  );

  return {
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    name,
    primaryColor: optionalColor(raw.primaryColor ?? raw.primary_color, 'branding.primaryColor'),
    logoUrl: optionalUrl(raw.logoUrl ?? raw.logo_url, 'branding.logoUrl'),
    supportEmail,
    legalName,
    legalFooter: optionalText(raw.legalFooter ?? raw.legal_footer, 'branding.legalFooter', 500),
    helpCenterUrl: optionalUrl(raw.helpCenterUrl ?? raw.help_center_url, 'branding.helpCenterUrl'),
    document: {
      legalName,
      footerText: optionalText(document.footerText ?? document.footer_text ?? raw.documentFooterText, 'branding.document.footerText', 500),
      letterheadUrl: null,
    },
    email: {
      fromName: optionalText(email.fromName ?? email.from_name ?? raw.emailFromName, 'branding.email.fromName', 120) || name || null,
      replyTo: replyTo || supportEmail,
    },
    assets: {
      logo: logoAsset,
      documentLetterhead: letterheadAsset,
    },
    mobile: { ...MOBILE_BRANDING_CONTRACT },
  };
}

export function assertBrandAssetMetadata(slot, metadata) {
  const policy = BRAND_ASSET_POLICY[slot];
  if (!policy) throw AppError.badRequest('Unknown brand asset slot', 'BRAND_ASSET_SLOT_INVALID', { slot });
  if (!metadata) {
    throw AppError.badRequest(`${policy.label} must reference a tenant-owned validated upload`, 'BRAND_ASSET_UPLOAD_NOT_FOUND', { slot });
  }
  if (metadata.is_active !== true) {
    throw AppError.badRequest(`${policy.label} upload is inactive`, 'BRAND_ASSET_UPLOAD_INACTIVE', { slot });
  }
  // Third consumer of the same rule; it used to carry its own private copy of
  // the clean-status allowlist. Because the generic upload path never advanced
  // its 'PENDING' stamp, this check rejected EVERY uploaded brand asset — the
  // same permanent fail-closed defect as the upload download gate, in a
  // different subsystem. It now reads the one shared policy.
  if (!isScanStatusServable(metadata.scan_status)) {
    throw AppError.badRequest(
      `${policy.label} upload must pass security scan before branding use`,
      'BRAND_ASSET_SCAN_NOT_CLEAN',
      { slot, scanStatus: metadata.scan_status || null, scanPolicy: resolveFileScanPolicy() },
    );
  }
  const mimeType = String(metadata.file_type || '').trim().toLowerCase();
  if (!policy.allowedMimeTypes.includes(mimeType)) {
    throw AppError.badRequest(`${policy.label} upload type is not allowed`, 'BRAND_ASSET_MIME_INVALID', { slot, mimeType, allowedMimeTypes: policy.allowedMimeTypes });
  }
  const fileSize = Number(metadata.file_size || 0);
  if (fileSize > policy.maxBytes) {
    throw AppError.badRequest(`${policy.label} upload is too large`, 'BRAND_ASSET_TOO_LARGE', { slot, fileSize, maxBytes: policy.maxBytes });
  }
}

