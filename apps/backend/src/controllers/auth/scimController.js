import {
  deleteScimUser,
  getScimUser,
  listScimGroups,
  listScimUsers,
  patchScimUser,
  resolveScimContext,
  scimErrorPayload,
  serviceProviderConfig,
  upsertScimUser,
} from '../../services/auth/scimProvisioningService.js';
import { AppError } from '../../utils/AppError.js';

function errorStatus(err) {
  return err?.statusCode || err?.status || 500;
}

function scimTypeFor(err) {
  const code = String(err?.code || '');
  if (code.includes('FILTER')) return 'invalidFilter';
  if (code.includes('PATCH')) return 'invalidSyntax';
  if (code.includes('ROLE') || code.includes('MAPPING')) return 'invalidValue';
  return null;
}

function sendScimError(res, err) {
  const status = errorStatus(err);
  const detail = err instanceof AppError ? err.message : 'SCIM request failed';
  return res.status(status).json(scimErrorPayload(status, detail, scimTypeFor(err)));
}

async function contextFor(req) {
  return resolveScimContext({
    tenantSlug: req.params.tenantSlug,
    providerKey: req.params.providerKey,
    req,
  });
}

export async function getServiceProviderConfig(req, res) {
  try {
    await contextFor(req);
    return res.json(serviceProviderConfig());
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function getGroups(req, res) {
  try {
    const context = await contextFor(req);
    return res.json(await listScimGroups(context, req.query || {}));
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function getUsers(req, res) {
  try {
    const context = await contextFor(req);
    return res.json(await listScimUsers(context, req.query || {}));
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function createUser(req, res) {
  try {
    const context = await contextFor(req);
    const result = await upsertScimUser(context, req.body || {}, { method: 'post', req });
    return res.status(result.created ? 201 : 200).json(result.resource);
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function getUser(req, res) {
  try {
    const context = await contextFor(req);
    return res.json(await getScimUser(context, req.params.id));
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function replaceUser(req, res) {
  try {
    const context = await contextFor(req);
    const result = await upsertScimUser(context, req.body || {}, {
      id: req.params.id,
      method: 'put',
      req,
    });
    return res.status(result.created ? 201 : 200).json(result.resource);
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function updateUser(req, res) {
  try {
    const context = await contextFor(req);
    const result = await patchScimUser(context, req.params.id, req.body || {}, { req });
    return res.json(result.resource);
  } catch (err) {
    return sendScimError(res, err);
  }
}

export async function removeUser(req, res) {
  try {
    const context = await contextFor(req);
    await deleteScimUser(context, req.params.id, { req });
    return res.status(204).end();
  } catch (err) {
    return sendScimError(res, err);
  }
}
