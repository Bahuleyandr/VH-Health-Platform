import prisma from '../../lib/prisma.js';
import { getSignedFileUrl } from '../../utils/r2Storage.js';
import { getTenantById, updateTenant } from './tenantService.js';
import { mergeGenericTenantSettings } from './tenantSettingsMutationPolicy.js';
import {
  assertBrandAssetMetadata,
  normalizeBrandKit,
} from './brandKitSchema.js';

const SIGNED_URL_TTL_SECONDS = 3600;

function settingsObject(settings) {
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
}

function mergeBrandKit(current, patch) {
  const currentObj = settingsObject(current);
  const patchObj = settingsObject(patch);
  return {
    ...currentObj,
    ...patchObj,
    document: {
      ...settingsObject(currentObj.document),
      ...settingsObject(patchObj.document),
    },
    email: {
      ...settingsObject(currentObj.email),
      ...settingsObject(patchObj.email),
    },
    assets: {
      ...settingsObject(currentObj.assets),
      ...settingsObject(patchObj.assets),
    },
  };
}

async function getUploadMetadata(tenantId, storageKey) {
  if (!storageKey) return null;
  return prisma.file_metadata.findFirst({
    where: {
      tenant_id: tenantId,
      storage_key: storageKey,
    },
    select: {
      storage_key: true,
      file_name: true,
      file_type: true,
      file_size: true,
      scan_status: true,
      is_active: true,
    },
  });
}

async function validateAssetRefs(tenantId, kit) {
  for (const slot of ['logo', 'documentLetterhead']) {
    const asset = kit.assets?.[slot];
    if (!asset?.storageKey) continue;
    const metadata = await getUploadMetadata(tenantId, asset.storageKey);
    assertBrandAssetMetadata(slot, metadata);
    asset.mimeType = metadata.file_type;
    asset.fileSize = Number(metadata.file_size || 0);
  }
}

async function attachSignedAssetUrls(tenantId, kit, { baseUrl } = {}) {
  for (const slot of ['logo', 'documentLetterhead']) {
    const asset = kit.assets?.[slot];
    if (!asset?.storageKey) continue;
    const metadata = await getUploadMetadata(tenantId, asset.storageKey);
    try {
      assertBrandAssetMetadata(slot, metadata);
      asset.mimeType = metadata.file_type;
      asset.fileSize = Number(metadata.file_size || 0);
      asset.url = await getSignedFileUrl(asset.storageKey, SIGNED_URL_TTL_SECONDS, { baseUrl });
    } catch {
      asset.url = null;
    }
  }
  if (kit.assets.logo?.url) kit.logoUrl = kit.assets.logo.url;
  if (kit.assets.documentLetterhead?.url) kit.document.letterheadUrl = kit.assets.documentLetterhead.url;
  return kit;
}

export async function getTenantBrandKit(tenantId, options = {}) {
  const tenant = options.tenant || await getTenantById(tenantId);
  const fallbackName = tenant?.name || 'VH Health';
  const settings = settingsObject(tenant?.settings);
  const kit = normalizeBrandKit(settings.branding, { fallbackName });
  kit.fallbacks = {
    name: !settingsObject(settings.branding).name,
    logo: !kit.logoUrl && !kit.assets.logo?.storageKey,
    supportEmail: !kit.supportEmail,
    legalName: !kit.legalName,
    helpCenter: !kit.helpCenterUrl,
  };
  return attachSignedAssetUrls(tenantId, kit, options);
}

export async function updateTenantBrandKit(tenantId, patch = {}) {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return null;
  const settings = settingsObject(tenant.settings);
  const merged = mergeBrandKit(settings.branding, patch);
  const normalized = normalizeBrandKit(merged);
  await validateAssetRefs(tenantId, normalized);
  const updated = await updateTenant(tenantId, {
    settings: mergeGenericTenantSettings(settings, { branding: normalized }),
  });
  return getTenantBrandKit(tenantId, { tenant: updated });
}
