// src/utils/fileUtils.js

import fs from 'fs';
import path from 'path';

/**
 * Ensure directory exists, create if not.
 * @param {string} dirPath - Path of the directory to ensure.
 */
export function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Save file content to the given directory.
 * @param {string} dir - Target directory.
 * @param {string} filename - Target filename.
 * @param {Buffer|string} content - Content to write.
 * @returns {string} - Full path of the saved file.
 */
export function saveFile(dir, filename, content) {
  ensureDirectoryExists(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Delete a file if it exists.
 * @param {string} filePath - Path to the file.
 * @returns {boolean} - True if deleted, false if not found.
 */
export function deleteFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * List all files in a directory.
 * @param {string} dir - Directory path.
 * @returns {string[]} - List of filenames.
 */
export function listFiles(dir) {
  if (fs.existsSync(dir)) {
    return fs.readdirSync(dir);
  }
  return [];
}
