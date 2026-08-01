import { decodeStrictUtf8 } from './mllpFrameReader.js';

export function messageText(message) {
  return Buffer.isBuffer(message) || message instanceof Uint8Array
    ? decodeStrictUtf8(message)
    : String(message);
}

export function extractMeta(message) {
  const segments = messageText(message).split(/\r\n|\r|\n/);
  const msh = segments.find((line) => line.startsWith('MSH|'));
  const obr = segments.find((line) => line.startsWith('OBR|'));
  if (!msh) {
    return {
      messageType: null,
      controlId: null,
      sendingApp: null,
      sendingFacility: null,
      sourceOccurredAtRaw: null,
    };
  }
  const fields = msh.split('|');
  return {
    sendingApp: fields[2] || null,
    sendingFacility: fields[3] || null,
    messageType: fields[8] || null,
    controlId: fields[9] || null,
    sourceOccurredAtRaw: obr?.split('|')[7] || null,
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
