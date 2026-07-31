const issuedCapabilities = new WeakSet();

export function mintExternalRecoveryCapability({
  inboxId,
  tenantId,
  facilityId,
  effectDisposition,
}) {
  const capability = Object.freeze({
    inboxId: String(inboxId),
    tenantId: String(tenantId).toLowerCase(),
    facilityId: Number(facilityId),
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
    && capability.facilityId !== Number(expected.facilityId)
  ) {
    throw new TypeError('Recovery capability facility does not match');
  }
  if (
    expected.effectDisposition
    && capability.effectDisposition !== expected.effectDisposition
  ) {
    throw new TypeError('Recovery capability effect disposition does not match');
  }
  return capability;
}
