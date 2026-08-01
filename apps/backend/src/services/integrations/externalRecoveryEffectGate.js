const issuedCapabilities = new WeakSet();

function normalizeFacilityId(value) {
  if (value === null || value === undefined || value === '') return null;
  const facilityId = Number(value);
  if (!Number.isSafeInteger(facilityId) || facilityId < 1) {
    throw new TypeError('Recovery capability facility must be a positive integer or null');
  }
  return facilityId;
}

export function mintExternalRecoveryCapability({
  inboxId,
  tenantId,
  facilityId,
  interfaceFamily = 'I10',
  effectDisposition,
}) {
  const capability = Object.freeze({
    inboxId: String(inboxId),
    tenantId: String(tenantId).toLowerCase(),
    facilityId: normalizeFacilityId(facilityId),
    interfaceFamily: String(interfaceFamily).toUpperCase(),
    effectDisposition,
  });
  issuedCapabilities.add(capability);
  return capability;
}

export function requireExternalRecoveryCapability(capability, expected = {}) {
  if (!capability || !issuedCapabilities.has(capability)) {
    throw new TypeError('A recovery-seam capability is required');
  }
  if (
    expected.tenantId
    && capability.tenantId !== String(expected.tenantId).toLowerCase()
  ) {
    throw new TypeError('Recovery capability tenant does not match');
  }
  if (
    expected.facilityId !== undefined
    && capability.facilityId !== normalizeFacilityId(expected.facilityId)
  ) {
    throw new TypeError('Recovery capability facility does not match');
  }
  if (
    expected.interfaceFamily
    && capability.interfaceFamily !== String(expected.interfaceFamily).toUpperCase()
  ) {
    throw new TypeError('Recovery capability interface family does not match');
  }
  if (
    expected.effectDisposition
    && capability.effectDisposition !== expected.effectDisposition
  ) {
    throw new TypeError('Recovery capability effect disposition does not match');
  }
  return capability;
}
