import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');

const emptyMerges = (entry = '<<: *sources') => (
  `sources: &sources [${Array(100).fill('{}').join(',')}]
targets:
${Array(101).fill(`  - ${entry}`).join('\n')}
`
);

describe('development coverage configuration YAML merge limits', () => {
  let directory;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'vh-gateway-nyc-'));
    writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const load = (name, source) => {
    writeFileSync(path.join(directory, name), source);
    return loadNycConfig({ cwd: directory, nycrcPath: name });
  };

  it.each(['.yml', '.yaml'])('bounds repeated empty merge sources in %s files', async (extension) => {
    await expect(load(`nycrc${extension}`, emptyMerges()))
      .rejects.toThrow('merge keys exceeded maxTotalMergeKeys (10000)');
  });

  it('bounds explicit merge tags through the same configuration loader', async () => {
    await expect(load('nycrc.yaml', emptyMerges('{ !!merge "<<": *sources }')))
      .rejects.toThrow('merge keys exceeded maxTotalMergeKeys (10000)');
  });

  it('enforces the budget in an extended YAML configuration', async () => {
    writeFileSync(path.join(directory, 'extended.yml'), emptyMerges());
    await expect(load('nycrc.json', '{"extends":"./extended.yml"}'))
      .rejects.toThrow('merge keys exceeded maxTotalMergeKeys (10000)');
  });

  it('preserves ordinary anchors, merge precedence and explicit overrides', async () => {
    const config = await load('nycrc.yaml', `
defaults: &defaults {branches: 80, lines: 90}
site: &site {lines: 70, statements: 85}
thresholds:
  <<: [*defaults, *site, {}]
  lines: 95
all: true
reporter: [text, lcov]
`);
    expect(config).toEqual({
      cwd: directory,
      defaults: { branches: 80, lines: 90 },
      site: { lines: 70, statements: 85 },
      thresholds: { branches: 80, lines: 95, statements: 85 },
      all: true,
      reporter: ['text', 'lcov'],
    });
  });

  it('preserves JSON configuration loading', async () => {
    await expect(load('nycrc.json', '{"all":true,"reporter":["text"]}'))
      .resolves.toEqual({ cwd: directory, all: true, reporter: ['text'] });
  });

  it('continues to reject malformed YAML', async () => {
    await expect(load('nycrc.yaml', 'reporter: [text'))
      .rejects.toThrow(/unexpected end/);
  });
});
