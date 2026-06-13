// AI-1 (WS5 B5.1) — unknown/unregistered module keys must fail safe.
//
// defaultModuleFor() previously returned enabled:true for ANY unregistered
// moduleKey, bypassing the enable gate and defaulting away the safety knobs.
// getClinicalAiModule() resolves an unregistered key through that fallback,
// so this proves the resolved module is now disabled + requires signoff +
// requires citations — and that REGISTERED modules are unaffected.

import { getClinicalAiModule } from '../services/ai/clinicalAiModuleService.js';
import prisma from '../lib/prisma.js';

describe('AI-1 unknown clinical AI module fallback', () => {
  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('resolves an unregistered module key as DISABLED with safety knobs on', async () => {
    const mod = await getClinicalAiModule('totally_unregistered_module_zzz_999');
    expect(mod).toBeTruthy();
    expect(mod.enabled).toBe(false);
    expect(mod.external_allowed).toBe(false);
    expect(mod.settings?.requiresClinicianSignoff).toBe(true);
    expect(mod.settings?.requiresCitations).toBe(true);
  });

  it('leaves a registered module key unchanged (still enabled, declared settings preserved)', async () => {
    // discharge_summary is enabled:true in the registry with requiresCitations.
    const mod = await getClinicalAiModule('discharge_summary');
    expect(mod.module_key).toBe('discharge_summary');
    expect(mod.enabled).toBe(true);
    expect(mod.settings?.requiresCitations).toBe(true);
    expect(mod.settings?.requiresClinicianSignoff).toBe(true);
  });
});
