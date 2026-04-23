import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';
import logger from '../../logging/logger.js';

const MAX_EXTRACTED_TEXT_CHARS = 50_000;
const OCR_TIMEOUT_MS = Number.parseInt(process.env.CLINICAL_AI_OCR_TIMEOUT_MS || '20000', 10);

export const DOCUMENT_OCR_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'text/plain',
  'text/csv',
  'text/rtf',
  'application/json',
  'application/fhir+json',
  'application/hl7-v2+er7',
]);

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/rtf',
  'application/json',
  'application/fhir+json',
  'application/hl7-v2+er7',
]);

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
]);

function normalizeMimeType(mimeType = '', fileName = '') {
  const declared = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (declared) return declared;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.rtf') return 'text/plain';
  return 'application/octet-stream';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(String.fromCharCode(0)).join('')
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');
}

function extensionForMime(mimeType) {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/tiff') return '.tiff';
  if (mimeType === 'image/bmp') return '.bmp';
  return '.bin';
}

function safetyFlag(severity, code, message) {
  return { severity, code, message };
}

function decodePdfLiteral(value) {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[index + 1];
    if (!next) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] || next;
      out += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length - 1;
    } else {
      out += next;
    }
    index += 1;
  }
  return out;
}

function uniqueLines(lines, limit = 500) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const text = normalizeText(line).replace(/\s+/g, ' ');
    const key = text.toLowerCase();
    if (!text || text.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export function extractNativePdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const body = buffer.toString('latin1');
  const literalMatches = [];
  const literalRe = /\((?:\\.|[^\\()]){2,2000}\)/g;
  let match;
  while ((match = literalRe.exec(body)) !== null && literalMatches.length < 1200) {
    const raw = match[0].slice(1, -1);
    const decoded = decodePdfLiteral(raw);
    if (/[A-Za-z0-9]/.test(decoded) && !/^D:\d{8}/.test(decoded)) {
      literalMatches.push(decoded);
    }
  }
  return uniqueLines(literalMatches).join('\n').slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function pageCountFromPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const body = buffer.toString('latin1');
  const matches = body.match(/\/Type\s*\/Page\b/g);
  return matches?.length || null;
}

function spawnCapture(command, args, timeoutMs = OCR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`OCR command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(errorText || `OCR command exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

async function withTempUpload(buffer, mimeType, callback) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vhhealth-ocr-'));
  const filePath = path.join(tmpDir, `upload${extensionForMime(mimeType)}`);
  try {
    await fs.writeFile(filePath, buffer);
    return await callback(filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runPdfTextCli(buffer, mimeType) {
  const command = process.env.CLINICAL_AI_OCR_PDFTEXT_CMD || 'pdftotext';
  return withTempUpload(buffer, mimeType, (filePath) =>
    spawnCapture(command, ['-layout', filePath, '-'])
  );
}

async function runTesseract(buffer, mimeType) {
  const command = process.env.CLINICAL_AI_OCR_TESSERACT_CMD || 'tesseract';
  return withTempUpload(buffer, mimeType, (filePath) =>
    spawnCapture(command, [filePath, 'stdout', '--psm', '6'])
  );
}

async function readImageMetadata(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return {
      width: meta.width || null,
      height: meta.height || null,
      format: meta.format || null,
      pages: meta.pages || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

export async function extractTextFromDocumentUpload({
  buffer,
  mimeType = '',
  fileName = '',
  rawTextHint = '',
} = {}) {
  const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const normalizedMimeType = normalizeMimeType(mimeType, fileName);
  const provider = String(process.env.CLINICAL_AI_OCR_PROVIDER || 'native').toLowerCase();
  const hash = fileHash(safeBuffer);
  const base = {
    file_name: fileName || null,
    file_hash: hash,
    file_size_bytes: safeBuffer.length,
    mime_type: normalizedMimeType,
    provider: 'native',
    status: 'pending',
    raw_text: '',
    text_char_count: 0,
    safety_flags: [],
    metadata: {},
  };

  const hintedText = normalizeText(rawTextHint);
  if (hintedText) {
    return {
      ...base,
      provider: 'manual_hint',
      status: 'completed',
      raw_text: hintedText,
      text_char_count: hintedText.length,
      safety_flags: [
        safetyFlag(
          'low',
          'OCR_TEXT_HINT_USED',
          'Uploaded file was paired with operator-supplied OCR text.'
        ),
      ],
    };
  }

  if (!DOCUMENT_OCR_MIME_TYPES.has(normalizedMimeType)) {
    return {
      ...base,
      provider: 'unsupported',
      status: 'unsupported',
      safety_flags: [
        safetyFlag(
          'high',
          'UNSUPPORTED_DOCUMENT_MIME',
          `Document OCR does not support ${normalizedMimeType}.`
        ),
      ],
    };
  }

  if (provider === 'none') {
    return {
      ...base,
      provider: 'none',
      status: 'no_text',
      safety_flags: [
        safetyFlag('medium', 'OCR_PROVIDER_DISABLED', 'Document OCR provider is disabled.'),
      ],
    };
  }

  if (provider === 'mock') {
    const mockText = normalizeText(process.env.CLINICAL_AI_OCR_MOCK_TEXT || '');
    return {
      ...base,
      provider: 'mock',
      status: mockText ? 'completed' : 'no_text',
      raw_text: mockText,
      text_char_count: mockText.length,
      safety_flags: mockText
        ? []
        : [safetyFlag('medium', 'MOCK_OCR_EMPTY', 'Mock OCR provider returned no text.')],
    };
  }

  if (TEXT_MIME_TYPES.has(normalizedMimeType)) {
    const rawText = normalizeText(safeBuffer.toString('utf8'));
    return {
      ...base,
      provider: 'native_text',
      status: rawText ? 'completed' : 'no_text',
      raw_text: rawText,
      text_char_count: rawText.length,
    };
  }

  if (normalizedMimeType === 'application/pdf') {
    const nativeText = normalizeText(extractNativePdfText(safeBuffer));
    if (nativeText) {
      return {
        ...base,
        provider: 'native_pdf_text',
        status: 'completed',
        raw_text: nativeText,
        text_char_count: nativeText.length,
        metadata: { page_count: pageCountFromPdf(safeBuffer) },
      };
    }

    const shouldTryPdfCli =
      provider === 'pdftotext' ||
      provider === 'external_cli' ||
      Boolean(process.env.CLINICAL_AI_OCR_PDFTEXT_CMD);
    if (shouldTryPdfCli) {
      try {
        const cliText = normalizeText(await runPdfTextCli(safeBuffer, normalizedMimeType));
        return {
          ...base,
          provider: 'pdftotext',
          status: cliText ? 'completed' : 'no_text',
          raw_text: cliText,
          text_char_count: cliText.length,
          metadata: { page_count: pageCountFromPdf(safeBuffer) },
          safety_flags: cliText
            ? []
            : [safetyFlag('medium', 'PDF_TEXT_LAYER_EMPTY', 'PDF text extraction returned no text.')],
        };
      } catch (err) {
        logger.warn('PDF OCR adapter failed', { error: err.message, fileName });
        return {
          ...base,
          provider: 'pdftotext',
          status: 'failed',
          metadata: { page_count: pageCountFromPdf(safeBuffer), error: err.message },
          safety_flags: [
            safetyFlag('high', 'OCR_PROVIDER_FAILED', 'PDF text extraction provider failed.'),
          ],
        };
      }
    }

    return {
      ...base,
      provider: 'native_pdf_text',
      status: 'no_text',
      metadata: { page_count: pageCountFromPdf(safeBuffer) },
      safety_flags: [
        safetyFlag(
          'medium',
          'PDF_TEXT_LAYER_EMPTY',
          'No selectable text was found in the PDF; configure a local OCR provider for scanned PDFs.'
        ),
      ],
    };
  }

  if (IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    const imageMetadata = await readImageMetadata(safeBuffer);
    const shouldTryTesseract =
      provider === 'tesseract' ||
      provider === 'external_cli' ||
      Boolean(process.env.CLINICAL_AI_OCR_TESSERACT_CMD);
    if (shouldTryTesseract) {
      try {
        const ocrText = normalizeText(await runTesseract(safeBuffer, normalizedMimeType));
        return {
          ...base,
          provider: 'tesseract',
          status: ocrText ? 'completed' : 'no_text',
          raw_text: ocrText,
          text_char_count: ocrText.length,
          metadata: { image: imageMetadata },
          safety_flags: ocrText
            ? []
            : [safetyFlag('medium', 'IMAGE_OCR_EMPTY', 'Image OCR returned no text.')],
        };
      } catch (err) {
        logger.warn('Image OCR adapter failed', { error: err.message, fileName });
        return {
          ...base,
          provider: 'tesseract',
          status: 'failed',
          metadata: { image: imageMetadata, error: err.message },
          safety_flags: [
            safetyFlag('high', 'OCR_PROVIDER_FAILED', 'Image OCR provider failed.'),
          ],
        };
      }
    }

    return {
      ...base,
      provider: 'image_metadata_only',
      status: 'no_text',
      metadata: { image: imageMetadata },
      safety_flags: [
        safetyFlag(
          'medium',
          'LOCAL_OCR_NOT_CONFIGURED',
          'Image upload was accepted, but no local OCR provider is configured.'
        ),
      ],
    };
  }

  return {
    ...base,
    provider: 'unsupported',
    status: 'unsupported',
    safety_flags: [
      safetyFlag('high', 'UNSUPPORTED_DOCUMENT_MIME', `Unsupported document type ${normalizedMimeType}.`),
    ],
  };
}

export default {
  DOCUMENT_OCR_MIME_TYPES,
  extractNativePdfText,
  extractTextFromDocumentUpload,
};
