// Unit pins for the specialty department gate's pure logic and its
// middleware state machine (resolver injected — no DB).

import { jest } from '@jest/globals';

const {
  SPECIALTY_DEPARTMENT_ALIASES,
  normalizeDepartment,
  departmentsMatchSpecialty,
  specialtyGateMode,
  specialtyDepartmentGuard,
} = await import('../../middleware/specialtyDepartmentMiddleware.js');

describe('normalizeDepartment', () => {
  it('lowercases, strips parentheticals and punctuation, collapses spaces', () => {
    expect(normalizeDepartment('ENT (Otorhinolaryngology)')).toBe('ent');
    expect(normalizeDepartment('  Obstetrics & Gynaecology ')).toBe('obstetrics gynaecology');
    expect(normalizeDepartment('Dentistry')).toBe('dentistry');
    expect(normalizeDepartment(null)).toBe('');
  });
});

describe('departmentsMatchSpecialty', () => {
  it('matches the linked-department name for each specialty', () => {
    expect(departmentsMatchSpecialty(new Set(['dentistry']), 'dental')).toBe(true);
    expect(departmentsMatchSpecialty(new Set(['oncology']), 'oncology')).toBe(true);
    expect(departmentsMatchSpecialty(new Set(['oncology']), 'radiation_oncology')).toBe(true);
    expect(departmentsMatchSpecialty(new Set(['ophthalmology']), 'ophthalmology')).toBe(true);
    expect(departmentsMatchSpecialty(new Set(['nephrology']), 'transplant')).toBe(true);
    expect(departmentsMatchSpecialty(new Set(['general surgery']), 'transplant')).toBe(true);
  });

  it('rejects unrelated departments', () => {
    expect(departmentsMatchSpecialty(new Set(['general medicine']), 'dental')).toBe(false);
    expect(departmentsMatchSpecialty(new Set(['housekeeping']), 'oncology')).toBe(false);
    expect(departmentsMatchSpecialty(new Set(), 'transplant')).toBe(false);
  });

  it('every specialty key has a non-empty alias set', () => {
    for (const [key, aliases] of Object.entries(SPECIALTY_DEPARTMENT_ALIASES)) {
      expect({ key, count: aliases.length }).toEqual({ key, count: aliases.length });
      expect(aliases.length).toBeGreaterThan(0);
    }
  });
});

describe('specialtyGateMode', () => {
  it('defaults to report and rejects junk', () => {
    expect(specialtyGateMode({})).toBe('report');
    expect(specialtyGateMode({ SPECIALTY_DEPARTMENT_GATE_MODE: 'enforce' })).toBe('enforce');
    expect(specialtyGateMode({ SPECIALTY_DEPARTMENT_GATE_MODE: 'OFF' })).toBe('off');
    expect(specialtyGateMode({ SPECIALTY_DEPARTMENT_GATE_MODE: 'banana' })).toBe('report');
  });
});

describe('middleware state machine (resolver injected)', () => {
  const saved = process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
    else process.env.SPECIALTY_DEPARTMENT_GATE_MODE = saved;
  });

  const run = async (guard, role = 'DOCTOR') => {
    const req = { user: { id: 7, uid: 'u-7', role }, ip: '1.2.3.4', originalUrl: '/x', method: 'GET' };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    let nexted = false;
    await guard(req, res, () => { nexted = true; });
    return { nexted, res };
  };

  it('report mode lets a mismatch through', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'report';
    const guard = specialtyDepartmentGuard('dental', {
      resolveDepartments: async () => new Set(['general medicine']),
    });
    const { nexted } = await run(guard);
    expect(nexted).toBe(true);
  });

  it('enforce mode denies a mismatch with the structured code', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const guard = specialtyDepartmentGuard('dental', {
      resolveDepartments: async () => new Set(['general medicine']),
    });
    const { nexted, res } = await run(guard);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain('SPECIALTY_DEPARTMENT_REQUIRED');
  });

  it('enforce mode admits a department match', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const guard = specialtyDepartmentGuard('dental', {
      resolveDepartments: async () => new Set(['dentistry']),
    });
    const { nexted } = await run(guard);
    expect(nexted).toBe(true);
  });

  it('leadership bypasses even in enforce mode', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const resolveDepartments = jest.fn();
    const guard = specialtyDepartmentGuard('dental', { resolveDepartments });
    const { nexted } = await run(guard, 'CMO');
    expect(nexted).toBe(true);
    expect(resolveDepartments).not.toHaveBeenCalled();
  });

  it('report mode fails OPEN on resolver errors; enforce fails closed', async () => {
    const boom = async () => { throw new Error('db down'); };
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'report';
    let out = await run(specialtyDepartmentGuard('dental', { resolveDepartments: boom }));
    expect(out.nexted).toBe(true);

    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    out = await run(specialtyDepartmentGuard('dental', { resolveDepartments: boom }));
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(500);
  });

  it('off mode is inert', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'off';
    const resolveDepartments = jest.fn();
    const guard = specialtyDepartmentGuard('dental', { resolveDepartments });
    const { nexted } = await run(guard);
    expect(nexted).toBe(true);
    expect(resolveDepartments).not.toHaveBeenCalled();
  });

  it('rejects unknown specialty keys at construction', () => {
    expect(() => specialtyDepartmentGuard('cardiothoracic')).toThrow(/Unknown specialty key/);
  });
});
