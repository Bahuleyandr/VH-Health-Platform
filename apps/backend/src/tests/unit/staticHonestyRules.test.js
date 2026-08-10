import { jest } from '@jest/globals';
import { Linter } from 'eslint';
import noSuccessInCatch from '../../../scripts/eslint-rules/no-success-in-catch.mjs';
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
});
