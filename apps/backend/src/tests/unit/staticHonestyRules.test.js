import { jest } from '@jest/globals';
import { Linter, RuleTester } from 'eslint';
import noSuccessInCatch from '../../../scripts/eslint-rules/no-success-in-catch.mjs';
import { findMixedStatusAssertions } from '../../../scripts/lib/statusAssertionAst.mjs';
import { classifyStatusSet } from '../../../scripts/lib/statusAssertionPolicy.mjs';

const noSuccessRuleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

noSuccessRuleTester.run('no-success-in-catch assigned aliases', noSuccessInCatch, {
  valid: [
    'function handler() { const success = () => null; try { work(); } catch { success(res); } }',
  ],
  invalid: [
    {
      code: 'const ok = success; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'const ok = responseHelper.success; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'let ok; ok = responseHelper.success; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'function handler() { try { work(); } catch { (0, success)(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'let ok = responseHelper.success; if (flag) ok = error; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'let ok = responseHelper.success; function unused() { ok = error; } function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'let ok = error; function handler() { try { work(); } catch { ok(res, []); } } function maybe() { ok = responseHelper.success; }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'const ok = flag ? responseHelper.success : error; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'let ok; ({ success: ok } = responseHelper); function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'const ok = flag && responseHelper.success; function handler() { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
    {
      code: 'function handler(ok = responseHelper.success) { try { work(); } catch { ok(res, []); } }',
      errors: [{ messageId: 'fakeSuccess' }],
    },
  ],
});

describe('no-success-in-catch lint rule', () => {
  function lint(code) {
    const linter = new Linter({ configType: 'flat' });
    return linter.verify(code, [{
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { vhhealth: { rules: { 'no-success-in-catch': noSuccessInCatch } } },
      rules: { 'vhhealth/no-success-in-catch': 'error' },
    }]);
  }

  it('flags direct and qualified success responses inside catches', () => {
    expect(lint('async function handler() { try { await work(); } catch (err) { success(res, [], "ok"); } }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
    expect(lint('async function handler() { try { await work(); } catch (err) { return responseHelper.success(res, []); } }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
  });

  it('flags imported aliases, computed success members, and Promise catch callbacks', () => {
    expect(lint('import { success as ok } from "./responseHelper.js"; async function handler() { try { await work(); } catch { ok(res, []); } }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
    expect(lint('async function handler() { try { await work(); } catch { return responseHelper["success"](res, []); } }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
    expect(lint('function handler() { return work().catch(() => success(res, [], "ok")); }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
    expect(lint('const { success: ok } = responseHelper; function handler() { return work()["catch"](() => ok(res, [])); }'))
      .toEqual([expect.objectContaining({ ruleId: 'vhhealth/no-success-in-catch' })]);
  });

  it('allows honest errors in catches and success on a normal path', () => {
    expect(lint('async function handler() { try { return success(res, await work()); } catch (err) { return error(res, "failed", 500); } }'))
      .toEqual([]);
  });
});

describe('mixed status assertion policy', () => {
  test.each([
    [[200, 500], { mixesServerFailure: true, mixesAuthOutcome: false }],
    [[200, 401], { mixesServerFailure: false, mixesAuthOutcome: true }],
    [[204, 403, 404], { mixesServerFailure: false, mixesAuthOutcome: true }],
    [[401, 403], { mixesServerFailure: false, mixesAuthOutcome: false }],
    [[200, 201, 404], { mixesServerFailure: false, mixesAuthOutcome: false }],
  ])('classifies %j', (codes, expected) => {
    expect(classifyStatusSet(codes)).toEqual(expected);
  });

  it('finds multiline mixed arrays and split conditional assertions through the AST', () => {
    const findings = findMixedStatusAssertions(`
      test('direct', () => {
        expect([
          200,
          403,
        ]).toContain(response.status);
      });
      test('split', () => {
        if (res.status !== 200) {
          expect([403, 404]).toContain(res.status);
        }
      });
      test('split-else', () => {
        if (response.status === 204) {
          expect(response.body).toBeUndefined();
        } else {
          expect([401, 403]).toContain(response.status);
        }
      });
    `);

    expect(findings).toEqual([
      expect.objectContaining({ codes: [200, 403], kind: 'status_set', mixesAuthOutcome: true }),
      expect.objectContaining({ codes: [200, 403, 404], kind: 'conditional_split', mixesAuthOutcome: true }),
      expect.objectContaining({ codes: [204, 401, 403], kind: 'conditional_split', mixesAuthOutcome: true }),
    ]);
  });

  it('allows a documented mixed-status contract and exact assertions', () => {
    const findings = findMixedStatusAssertions(`
      expect(res.status).toBe(200);
      // ban-exempt: readiness is 200 when ready and 503 while dependencies recover
      expect([200, 503]).toContain(readiness.status);
    `);

    expect(findings).toEqual([
      expect.objectContaining({ codes: [200, 503], exempt: true }),
    ]);
  });

  it('resolves local const status sets, numeric aliases, and negated includes splits', () => {
    const findings = findMixedStatusAssertions(`
      test('bound set', () => {
        const accepted = [200, 403];
        expect(accepted).toContain(res.status);
      });
      test('bound numeric split', () => {
        const ok = 200;
        if (res.status !== ok) {
          expect([401, 403]).toContain(res.status);
        }
      });
      test('negated includes split', () => {
        const successful = [200, 204];
        if (!successful.includes(res.status)) {
          const denied = [401, 403];
          expect(denied).toContain(res.status);
        }
      });
    `);

    expect(findings).toEqual([
      expect.objectContaining({ codes: [200, 403], kind: 'status_set', mixesAuthOutcome: true }),
      expect.objectContaining({ codes: [200, 401, 403], kind: 'conditional_split', mixesAuthOutcome: true }),
      expect.objectContaining({ codes: [200, 204, 401, 403], kind: 'conditional_split', mixesAuthOutcome: true }),
    ]);
  });

  it('resolves the nearest lexical const binding instead of a shadowed outer set', () => {
    const findings = findMixedStatusAssertions(`
      const accepted = [200, 403];
      test('shadowed', () => {
        const accepted = [401, 403];
        expect(accepted).toContain(res.status);
      });
      const loopAccepted = [200, 403];
      for (let loopAccepted = [401, 403]; flag;) {
        expect(loopAccepted).toContain(res.status);
        break;
      }
    `);

    expect(findings).toEqual([]);
  });

  it('tracks mutable lexical status sets and respects parameter shadowing', () => {
    const findings = findMixedStatusAssertions(`
      test('mutable set', () => {
        let accepted = [200, 403];
        expect(accepted).toContain(res.status);
      });
      const accepted = [401, 403];
      function check() {
        let accepted = [200, 403];
        expect(accepted).toContain(res.status);
      }
      const outerMixed = [200, 403];
      function parameterShadow(outerMixed) {
        expect(outerMixed).toContain(res.status);
      }
    `);

    expect(findings).toEqual([
      expect.objectContaining({ codes: [200, 403], kind: 'status_set', mixesAuthOutcome: true }),
      expect.objectContaining({ codes: [200, 403], kind: 'status_set', mixesAuthOutcome: true }),
    ]);
  });

  it('tracks branched, defaulted, and mutated status sets', () => {
    const findings = findMixedStatusAssertions(`
      const conditional = flag ? [200, 403] : [401, 403];
      expect(conditional).toContain(res.status);
      const logical = flag && [200, 403];
      expect(logical).toContain(res.status);
      const pushed = [200];
      pushed.push(403);
      expect(pushed).toContain(res.status);
      const unshifted = [403];
      unshifted.unshift(200);
      expect(unshifted).toContain(res.status);
      const spliced = [200];
      spliced.splice(1, 0, 403);
      expect(spliced).toContain(res.status);
      const aliased = [200];
      const alias = aliased;
      alias.push(403);
      expect(aliased).toContain(res.status);
      function defaulted(accepted = [200, 403]) {
        expect(accepted).toContain(res.status);
      }
    `);

    expect(findings).toHaveLength(7);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ codes: expect.arrayContaining([200, 403]), mixesAuthOutcome: true }),
    ]));
  });
});
