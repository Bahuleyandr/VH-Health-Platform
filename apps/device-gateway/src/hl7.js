export function extractMeta(message) {
  const msh = String(message).split(/\r\n|\r|\n/).find((line) => line.startsWith('MSH|'));
  if (!msh) return { messageType: null, controlId: null, sendingApp: null, sendingFacility: null };
  const fields = msh.split('|');
  return {
    sendingApp: fields[2] || null,
    sendingFacility: fields[3] || null,
    messageType: fields[8] || null,
    controlId: fields[9] || null,
  };
}

export function ack(message, ackCode = 'AA', text = '') {
  const meta = extractMeta(message);
  const now = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ackId = `GW${Date.now().toString(36).toUpperCase()}`;
  return [
    `MSH|^~\\&|VH_DEVICE_GATEWAY|VHHEALTH||DEVICE|${now}||ACK|${ackId}|P|2.5`,
    `MSA|${ackCode}|${meta.controlId || ''}|${text}`,
  ].join('\r');
}
