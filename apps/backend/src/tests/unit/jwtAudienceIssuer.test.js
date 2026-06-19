// src/tests/unit/jwtAudienceIssuer.test.js
//
// Audit §3 (Auth) defense-in-depth: jwtUtils.verifyToken /
// verifyTokenAllowExpired must, in ADDITION to signature + expiry, validate the
// JWT `aud` (audience) and `iss` (issuer) claims — but in a STRICTLY
// backward-compatible way:
//
//   * A grandfathered token that carries NEITHER `aud` NOR `iss` MUST still
//     verify (pre-existing tokens expire naturally; we never reject solely for
//     a missing realm claim).
//   * A token that DOES carry an `aud` must present one of the accepted
//     per-realm audiences; a wrong `aud` is rejected.
//   * A token that DOES carry an `iss` must present the accepted issuer; a
//     wrong `iss` is rejected.
//   * Generation stamps a per-realm `aud` (patient / staff / admin) + the
//     issuer on every freshly-minted token, derived from the role unless the
//     caller set them explicitly (admin login already sets aud explicitly).
//
// Pure unit test: no DB, no app wiring. We sign tokens directly with the test
// JWT_SECRET (guaranteed >=32 chars by jest.setup.cjs) and only exercise
// jwtUtils. crypto.randomUUID() is real, so jti is present.

import jwt from 'jsonwebtoken';
import {
  generateToken,
  verifyToken,
  verifyTokenAllowExpired,
  JWT_ISSUER,
  JWT_AUDIENCES,
} from '../../utils/jwtUtils.js';

const SECRET = process.env.JWT_SECRET;

// Sign a raw token bypassing generateToken, so we control exactly which claims
// are present (used to forge legacy / wrong-aud / wrong-iss tokens).
function signRaw(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', ...opts });
}

describe('jwtUtils — aud/iss defense-in-depth (backward compatible)', () => {
  describe('exports', () => {
    it('exposes the issuer and per-realm audience constants', () => {
      expect(JWT_ISSUER).toBe('vh-health-backend');
      expect(JWT_AUDIENCES.patient).toBe('vh-health-patient');
      expect(JWT_AUDIENCES.staff).toBe('vh-health-staff');
      expect(JWT_AUDIENCES.admin).toBe('vh-health-admin');
    });
  });

  describe('(a) backward compatibility — legacy tokens with NO aud/iss', () => {
    it('verifyToken accepts a legacy token carrying neither aud nor iss', () => {
      // Shape of a pre-existing role-only token (what the field has today).
      const legacy = signRaw(
        { sub: 'legacy-uid', role: 'PATIENT', jti: 'legacy-jti' },
        { expiresIn: '1h' },
      );
      const decoded = verifyToken(legacy);
      expect(decoded).not.toBeNull();
      expect(decoded.role).toBe('PATIENT');
      expect(decoded.aud).toBeUndefined();
      expect(decoded.iss).toBeUndefined();
    });

    it('verifyTokenAllowExpired accepts a legacy (even expired) token with no aud/iss', () => {
      const legacyExpired = signRaw(
        { sub: 'legacy-uid', role: 'PATIENT', jti: 'legacy-jti', type: 'refresh' },
        { expiresIn: '-1h' },
      );
      const decoded = verifyTokenAllowExpired(legacyExpired);
      expect(decoded).not.toBeNull();
      expect(decoded.role).toBe('PATIENT');
    });

    it('accepts a legacy token that has iss but NO aud (partial legacy)', () => {
      const partial = signRaw(
        { sub: 'u', role: 'PATIENT', iss: 'vh-health-backend' },
        { expiresIn: '1h' },
      );
      expect(verifyToken(partial)).not.toBeNull();
    });

    it('accepts a legacy token that has aud but NO iss (partial legacy)', () => {
      const partial = signRaw(
        { sub: 'u', role: 'PATIENT', aud: 'vh-health-patient' },
        { expiresIn: '1h' },
      );
      expect(verifyToken(partial)).not.toBeNull();
    });
  });

  describe('(b) new tokens with a correct per-realm aud verify', () => {
    it('a patient token (role PATIENT) gets aud=vh-health-patient and verifies', () => {
      const token = generateToken({ uid: 'p1', role: 'PATIENT', phone: '+910000000000' });
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded.aud).toBe('vh-health-patient');
      expect(decoded.iss).toBe('vh-health-backend');
    });

    it('a staff token (clinical role) gets aud=vh-health-staff and verifies', () => {
      const token = generateToken({ uid: 's1', role: 'DOCTOR' });
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded.aud).toBe('vh-health-staff');
      expect(decoded.iss).toBe('vh-health-backend');
    });

    it('an admin token (role ADMIN) gets aud=vh-health-admin and verifies', () => {
      const token = generateToken({ uid: 'a1', role: 'ADMIN' });
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded.aud).toBe('vh-health-admin');
    });

    it('SUPER_ADMIN maps to the admin audience', () => {
      const token = generateToken({ uid: 'sa1', role: 'SUPER_ADMIN' });
      expect(verifyToken(token).aud).toBe('vh-health-admin');
    });

    it('an explicit caller-supplied aud/iss is preserved (admin login path)', () => {
      const token = generateToken({
        uid: 'a2',
        role: 'ADMIN',
        iss: 'vh-health-backend',
        aud: 'vh-health-admin',
      });
      const decoded = verifyToken(token);
      expect(decoded.aud).toBe('vh-health-admin');
      expect(decoded.iss).toBe('vh-health-backend');
    });

    it('verifyTokenAllowExpired accepts a freshly minted token with the realm aud', () => {
      const token = generateToken({ uid: 'p2', role: 'PATIENT' });
      expect(verifyTokenAllowExpired(token)).not.toBeNull();
    });
  });

  describe('(c) wrong aud is rejected', () => {
    it('verifyToken rejects a token whose aud is not an accepted realm value', () => {
      const forged = signRaw(
        { sub: 'u', role: 'PATIENT', iss: 'vh-health-backend', aud: 'some-other-service' },
        { expiresIn: '1h' },
      );
      expect(verifyToken(forged)).toBeNull();
      expect(verifyToken.lastError).toBe('JsonWebTokenError');
    });

    it('rejects a patient-realm token presented for cross-realm misuse via wrong aud', () => {
      const forged = signRaw(
        { sub: 'u', role: 'ADMIN', aud: 'vh-health-evil' },
        { expiresIn: '1h' },
      );
      expect(verifyToken(forged)).toBeNull();
    });

    it('verifyTokenAllowExpired also rejects a wrong aud', () => {
      const forged = signRaw(
        { sub: 'u', role: 'PATIENT', aud: 'some-other-service' },
        { expiresIn: '-1h' },
      );
      expect(verifyTokenAllowExpired(forged)).toBeNull();
    });
  });

  describe('(d) wrong iss is rejected', () => {
    it('verifyToken rejects a token whose iss is not the accepted issuer', () => {
      const forged = signRaw(
        { sub: 'u', role: 'PATIENT', iss: 'evil-issuer', aud: 'vh-health-patient' },
        { expiresIn: '1h' },
      );
      expect(verifyToken(forged)).toBeNull();
      expect(verifyToken.lastError).toBe('JsonWebTokenError');
    });

    it('verifyTokenAllowExpired also rejects a wrong iss', () => {
      const forged = signRaw(
        { sub: 'u', role: 'PATIENT', iss: 'evil-issuer' },
        { expiresIn: '-1h' },
      );
      expect(verifyTokenAllowExpired(forged)).toBeNull();
    });
  });

  describe('(e) existing happy-path (role-only current-shape token) still verifies', () => {
    it('a generateToken-minted token round-trips through verifyToken', () => {
      // This is the de-facto "current shape": uid + role + phone, no explicit
      // aud/iss from the caller. It must keep verifying after the change.
      const token = generateToken({ uid: 'happy', role: 'PATIENT', phone: '+919999999999' });
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded.sub).toBe('happy');
      expect(decoded.role).toBe('PATIENT');
      expect(typeof decoded.jti).toBe('string');
    });

    it('still rejects a token signed with the wrong secret (signature wins)', () => {
      const bad = jwt.sign({ sub: 'u', role: 'PATIENT' }, 'a-totally-different-secret-32charsxx', {
        algorithm: 'HS256',
        expiresIn: '1h',
      });
      expect(verifyToken(bad)).toBeNull();
    });

    it('still rejects an expired token via verifyToken (expiry wins)', () => {
      const expired = generateToken({ uid: 'u', role: 'PATIENT' });
      // re-sign as expired through raw path but with the realm claims present
      const expiredRealm = signRaw(
        { sub: 'u', role: 'PATIENT', iss: 'vh-health-backend', aud: 'vh-health-patient' },
        { expiresIn: '-1h' },
      );
      expect(verifyToken(expiredRealm)).toBeNull();
      expect(verifyToken.lastError).toBe('TokenExpiredError');
      // sanity: the non-expired equivalent verifies
      expect(verifyToken(expired)).not.toBeNull();
    });
  });
});
