import { jest } from '@jest/globals';
import { Linter } from 'eslint';
import noSuccessInCatch from '../../../scripts/eslint-rules/no-success-in-catch.mjs';
import { findMixedStatusAssertions } from '../../../scripts/lib/statusAssertionAst.mjs';
import { classifyStatusSet } from '../../../scripts/lib/statusAssertionPolicy.mjs';

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
});
