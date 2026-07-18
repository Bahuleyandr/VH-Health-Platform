import { readFileSync } from 'node:fs';

const scheduler = readFileSync(
  new URL('../../utils/scheduler.js', import.meta.url),
  'utf8',
);

describe('S1a Pathway projector scheduler wiring', () => {
  it('registers default-off shadow and stale-lease jobs with dynamic imports', () => {
    expect(scheduler).toContain(
      "registerCron('*/2 * * * *', withJobLock('pathway-projector-shadow'",
    );
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('pathway-projector-stale-lease-reaper'",
    );
    expect(scheduler).toContain(
      "import { isPathwayProjectorShadowEnabled } from '../config/pathwayProjectorConfig.js';",
    );
    expect(scheduler.match(/if \(!isPathwayProjectorShadowEnabled\(\)\) return;/g)).toHaveLength(2);
    expect(scheduler).not.toContain('process.env.PATHWAY_PROJECTOR_SHADOW_ENABLED');
    expect(scheduler.match(/await import\('\.\.\/services\/events\/pathwayProjectorService\.js'\)/g))
      .toHaveLength(2);
    expect(scheduler).not.toMatch(/^import .*pathwayProjectorService\.js/m);
  });

  it('does not add either Pathway projector job to startup execution', () => {
    const startupSection = scheduler.slice(scheduler.indexOf('export async function runAllScheduledTasksNow'));
    expect(startupSection).not.toContain("'pathway-projector-shadow'");
    expect(startupSection).not.toContain("'pathway-projector-stale-lease-reaper'");
  });
});
