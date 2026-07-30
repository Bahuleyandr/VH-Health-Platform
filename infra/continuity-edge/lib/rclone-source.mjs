import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { safeRelativePath } from './constants.mjs';

function remotePath(root, relative) {
  if (!safeRelativePath(relative)) throw new Error('UNSAFE_PATH');
  const normalizedRoot = root.replace(/\/+$/, '');
  if (
    normalizedRoot.length === 0 ||
    normalizedRoot.includes('\\') ||
    normalizedRoot.split('/').includes('..')
  ) {
    throw new Error('source facility path is unsafe');
  }
  return `${normalizedRoot}/${relative}`;
}

export class RcloneFacilitySource {
  constructor({
    binary = 'rclone',
    configFile,
    remote,
    facilityPath,
    identityPath,
    knownHostsPath,
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(remote)) {
      throw new Error('rclone remote name is invalid');
    }
    this.binary = binary;
    this.configFile = path.resolve(configFile);
    this.remote = remote;
    this.facilityPath = facilityPath;
    this.identityPath = path.resolve(identityPath);
    this.knownHostsPath = path.resolve(knownHostsPath);
  }

  run(args, options = {}) {
    const result = spawnSync(
      this.binary,
      [
        '--config',
        this.configFile,
        '--sftp-key-file',
        this.identityPath,
        '--sftp-known-hosts-file',
        this.knownHostsPath,
        ...args,
      ],
      {
        encoding: options.encoding,
        maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `rclone failed (${result.status}): ${String(result.stderr || '').trim()}`,
      );
    }
    return result;
  }

  async readFile(relative) {
    const source = `${this.remote}:${remotePath(this.facilityPath, relative)}`;
    return this.run(['cat', source], { maxBuffer: 128 * 1024 }).stdout;
  }

  async copySet(relative, destination) {
    const source = `${this.remote}:${remotePath(this.facilityPath, relative)}`;
    this.run([
      'copy',
      source,
      path.resolve(destination),
      '--check-first',
      '--immutable',
      '--links',
      '--metadata',
      '--no-update-modtime',
    ]);
  }
}
