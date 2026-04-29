// src/app/(public)/login/LoginClient.tsx
'use client';

/* 
 * IMPORTANT: Image Setup Instructions
 * ------------------------------------
 * Your images should be placed in one of these locations:
 * 
 * Option 1: In the /public folder
 * - /public/images/hospital-logo.png
 * - /public/images/hospital-building.jpg
 * 
 * Option 2: In the root /images folder  
 * - /images/hospital-logo.png
 * - /images/hospital-building.jpg
 * 
 * If images still don't show:
 * 1. Check browser console for 404 errors
 * 2. Verify exact file names (case-sensitive)
 * 3. Try accessing directly: http://localhost:3000/images/hospital-logo.png
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import Image from 'next/image';
import styles from './Login.module.css';

function LoginInner() {
  const { login, verifyMfa, mfaSetupEnroll, mfaSetupConfirm, loginStaff } = useAuth();

  // Tab state: 'admin' | 'staff'
  const [loginMode, setLoginMode] = useState<'admin' | 'staff'>('admin');

  // Form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [logoError, setLogoError] = useState(false);

  // Validation state
  const [touched, setTouched] = useState({ username: false, password: false });
  const [fieldErrors, setFieldErrors] = useState({ username: '', password: '' });

  // Submit state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // MFA state — populated when the backend returns a 2FA challenge.
  const [mfaChallenge, setMfaChallenge] = useState<{ challengeToken: string; adminHint?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaUseBackup, setMfaUseBackup] = useState(false);

  // MFA setup state — populated when the backend returns mfa_setup_required.
  const [mfaSetup, setMfaSetup] = useState<{ setupToken: string; adminHint?: string } | null>(null);
  const [mfaSetupData, setMfaSetupData] = useState<{
    qrCodeDataUrl: string;
    otpauthUrl: string;
    backupCodes: string[];
    encryptedSecret: string;
  } | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState('');
  const [mfaSetupAcked, setMfaSetupAcked] = useState(false);

  // Autofocus management
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  
  useEffect(() => {
    // Check for saved credentials
    const saved = localStorage.getItem('vh:remember');
    const savedUser = localStorage.getItem('vh:savedUsername');
    
    if (saved === 'true' && savedUser) {
      setRemember(true);
      setUsername(savedUser);
      setTimeout(() => passwordRef.current?.focus(), 100);
    } else {
      userRef.current?.focus();
    }
  }, []);

  // Real-time validation
  const validateField = (field: 'username' | 'password', value: string) => {
    const errors = { ...fieldErrors };
    
    if (field === 'username') {
      if (!value) {
        errors.username = 'Username is required';
      } else if (value.length < 3) {
        errors.username = 'Username must be at least 3 characters';
      } else {
        errors.username = '';
      }
    }
    
    if (field === 'password') {
      if (!value) {
        errors.password = 'Password is required';
      } else if (value.length < 4) {
        errors.password = 'Password must be at least 4 characters';
      } else {
        errors.password = '';
      }
    }
    
    setFieldErrors(errors);
  };

  const handleBlur = (field: 'username' | 'password') => {
    setTouched({ ...touched, [field]: true });
    validateField(field, field === 'username' ? username : password);
  };

  const onCapsCheck = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.getModifierState) {
      setCapsOn(e.getModifierState('CapsLock'));
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    
    setTouched({ username: true, password: true });
    validateField('username', username);
    validateField('password', password);
    
    if (!username || !password || fieldErrors.username || fieldErrors.password) {
      return;
    }
    
    setError('');
    setIsLoading(true);
    
    try {
      if (loginMode === 'staff') {
        await loginStaff(username.trim(), password);
      } else {
        const outcome = await login(username.trim(), password);
        if (outcome.kind === 'mfa') {
          setMfaChallenge({
            challengeToken: outcome.challenge.challengeToken,
            adminHint: outcome.challenge.adminHint?.username,
          });
          setMfaCode('');
          setMfaUseBackup(false);
          return; // Stop here — the TOTP panel takes over.
        }
        if (outcome.kind === 'mfa_setup_required') {
          // SUPER_ADMIN without TOTP — kick off first-time enrollment.
          setMfaSetup({
            setupToken: outcome.challenge.setupToken,
            adminHint: outcome.challenge.adminHint?.username,
          });
          setMfaSetupData(null);
          setMfaSetupCode('');
          setMfaSetupAcked(false);
          try {
            const data = await mfaSetupEnroll({ setupToken: outcome.challenge.setupToken });
            setMfaSetupData(data);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to start MFA setup');
          }
          return; // Stop here — the enrollment panel takes over.
        }
      }

      if (remember) {
        localStorage.setItem('vh:remember', 'true');
        localStorage.setItem('vh:savedUsername', username.trim());
      } else {
        localStorage.removeItem('vh:remember');
        localStorage.removeItem('vh:savedUsername');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed. Please check your credentials.';
      setError(msg);
      
      // Add shake animation to form
      if (formRef.current) {
        formRef.current.classList.add(styles.formShake);
        setTimeout(() => {
          formRef.current?.classList.remove(styles.formShake);
        }, 500);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const disabled = isLoading;
  const hasErrors = !!(fieldErrors.username || fieldErrors.password);
  const submitDisabled = disabled || !username || !password || hasErrors;

  return (
    <div className={styles.container}>
      <div className={styles.hospitalBackground} />
      <div className={styles.backgroundPattern} />
      
      <div className={styles.card}>
        {/* Logo Section */}
        <div className={styles.logo}>
          {logoError ? (
            <div className={styles.logoIcon}>VH</div>
          ) : (
            <Image
              src="/images/hospital-logo.png"
              alt="VH Health Hospital logo"
              width={160}            // adjust to match your layout
              height={160}
              className={styles.logoImage}
              onError={() => setLogoError(true)}
              priority               // hero image for better LCP
            />
          )}
          <h1 className={styles.title}>VH Health</h1>
          <p className={styles.subtitle}>Excellence in Healthcare</p>
        </div>

        {/* Welcome Section */}
        <div className={styles.welcomeSection}>
          <h2 className={styles.welcomeTitle}>Welcome Back</h2>
          <p className={styles.welcomeSubtitle}>
            {loginMode === 'staff' ? 'Staff Portal Access' : 'Admin Portal Access'}
          </p>
        </div>

        {/* Login Mode Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <button
            type="button"
            onClick={() => { setLoginMode('admin'); setError(''); setTouched({ username: false, password: false }); }}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '0.375rem',
              border: loginMode === 'admin' ? '2px solid #6366f1' : '2px solid transparent',
              background: loginMode === 'admin' ? '#6366f115' : 'transparent',
              color: loginMode === 'admin' ? '#6366f1' : '#94a3b8',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: '0.875rem',
              transition: 'all 0.15s',
            }}
          >
            🛡️ Admin Login
          </button>
          <button
            type="button"
            onClick={() => { setLoginMode('staff'); setError(''); setTouched({ username: false, password: false }); }}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '0.375rem',
              border: loginMode === 'staff' ? '2px solid #10b981' : '2px solid transparent',
              background: loginMode === 'staff' ? '#10b98115' : 'transparent',
              color: loginMode === 'staff' ? '#10b981' : '#94a3b8',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: '0.875rem',
              transition: 'all 0.15s',
            }}
          >
            👤 Staff Login
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div role="alert" className={styles.errorBox}>
            <span>⚠️</span>
            <p className={styles.errorText}>{error}</p>
          </div>
        )}

        <form ref={formRef} onSubmit={handleSubmit}>
          {/* Username Field */}
          <div className={styles.inputGroup}>
            <label htmlFor="username" className={styles.label}>
              {loginMode === 'staff' ? 'Employee ID' : 'Username'}
            </label>
            <div className={styles.inputWrapper}>
              <span
                className={`${styles.inputIcon} ${
                  touched.username && fieldErrors.username
                    ? styles.inputIconError
                    : touched.username && !fieldErrors.username && username
                    ? styles.inputIconSuccess
                    : ''
                }`}
              >
                👤
              </span>
              <input
                ref={userRef}
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                disabled={disabled}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (touched.username) validateField('username', e.target.value);
                }}
                onBlur={() => handleBlur('username')}
                aria-invalid={touched.username && fieldErrors.username ? "true" : undefined}
                aria-describedby={touched.username && fieldErrors.username ? "username-error" : undefined}
                className={`${styles.input} ${
                  touched.username && fieldErrors.username
                    ? styles.inputError
                    : touched.username && !fieldErrors.username && username
                    ? styles.inputSuccess
                    : ''
                }`}
                placeholder={loginMode === 'staff' ? 'Enter your employee ID' : 'Enter your username'}
              />
              {touched.username && !fieldErrors.username && username && (
                <span className={styles.checkIcon}>✓</span>
              )}
            </div>
            {touched.username && fieldErrors.username && (
              <p id="username-error" role="alert" className={styles.errorMessage}>{fieldErrors.username}</p>
            )}
          </div>

          {/* Password Field */}
          <div className={styles.inputGroup}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <div className={styles.inputWrapper}>
              <span
                className={`${styles.inputIcon} ${
                  touched.password && fieldErrors.password
                    ? styles.inputIconError
                    : touched.password && !fieldErrors.password && password
                    ? styles.inputIconSuccess
                    : ''
                }`}
              >
                🔒
              </span>
              <input
                ref={passwordRef}
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                disabled={disabled}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (touched.password) validateField('password', e.target.value);
                }}
                onBlur={() => handleBlur('password')}
                onKeyUp={onCapsCheck}
                aria-invalid={touched.password && fieldErrors.password ? "true" : undefined}
                aria-describedby={touched.password && fieldErrors.password ? "password-error" : undefined}
                className={`${styles.input} ${
                  touched.password && fieldErrors.password
                    ? styles.inputError
                    : touched.password && !fieldErrors.password && password
                    ? styles.inputSuccess
                    : ''
                }`}
                placeholder="Enter your password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                disabled={disabled}
                className={styles.passwordToggle}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>
            {touched.password && fieldErrors.password && (
              <p id="password-error" role="alert" className={styles.errorMessage}>{fieldErrors.password}</p>
            )}
            {capsOn && <p className={styles.capsWarning}>⚠️ Caps Lock is ON</p>}
          </div>

          {/* Remember & Forgot */}
          <div className={styles.rememberRow}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={disabled}
              />
              Remember me
            </label>
            <button type="button" className={styles.forgotLink} onClick={() => {}}>
              Forgot password?
            </button>
          </div>

          {/* Submit Button */}
          <button type="submit" disabled={submitDisabled} className={styles.submitButton}>
            {isLoading ? (
              <span className={styles.loadingSpinner}>
                <span className={styles.spinner}></span>
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* ── MFA challenge panel ───────────────────────────────────── */}
        {mfaChallenge && (
          <div
            style={{
              marginTop: 24,
              padding: 16,
              borderRadius: 10,
              border: '1px solid #6366f1',
              background: 'rgba(99, 102, 241, 0.08)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Two-factor authentication</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>
              Enter the 6-digit code from your authenticator app
              {mfaChallenge.adminHint ? ` for ${mfaChallenge.adminHint}` : ''}.
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, mfaUseBackup ? 14 : 6))}
              placeholder={mfaUseBackup ? 'Backup code' : '123456'}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #6366f155',
                fontSize: 18,
                letterSpacing: mfaUseBackup ? 0 : 4,
                marginBottom: 10,
                background: '#fff',
                color: '#111',
              }}
              aria-label={mfaUseBackup ? 'Backup code' : 'Authenticator code'}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 }}>
              <input type="checkbox" checked={mfaUseBackup} onChange={(e) => { setMfaUseBackup(e.target.checked); setMfaCode(''); }} />
              Use a backup recovery code instead
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => { setMfaChallenge(null); setMfaCode(''); setError(''); }}
                disabled={isLoading}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'transparent', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isLoading || !mfaCode.trim()}
                onClick={async () => {
                  setError('');
                  setIsLoading(true);
                  try {
                    await verifyMfa({
                      challengeToken: mfaChallenge.challengeToken,
                      code: mfaCode.trim(),
                      useBackupCode: mfaUseBackup,
                    });
                    if (remember) {
                      localStorage.setItem('vh:remember', 'true');
                      localStorage.setItem('vh:savedUsername', username.trim());
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'MFA verification failed');
                  } finally {
                    setIsLoading(false);
                  }
                }}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: '#6366f1',
                  color: '#fff',
                  border: 'none',
                  cursor: isLoading ? 'wait' : 'pointer',
                  fontWeight: 600,
                  opacity: isLoading ? 0.7 : 1,
                }}
              >
                {isLoading ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          </div>
        )}

        {/* ── MFA first-time setup panel ─────────────────────────────── */}
        {mfaSetup && (
          <div
            style={{
              marginTop: 24,
              padding: 16,
              borderRadius: 10,
              border: '1px solid #f59e0b',
              background: 'rgba(245, 158, 11, 0.08)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              First-time two-factor setup required
            </div>
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>
              This account is a Super Admin and must enable an authenticator app
              before first use. Scan the QR code below with Google Authenticator,
              Authy, 1Password, or Bitwarden, then enter the 6-digit code.
            </div>

            {!mfaSetupData ? (
              <div style={{ padding: 12, opacity: 0.8 }}>
                Preparing your enrollment credentials…
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mfaSetupData.qrCodeDataUrl}
                    alt="Authenticator QR code"
                    width={200}
                    height={200}
                    style={{ background: '#fff', padding: 8, borderRadius: 8 }}
                  />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Save these backup codes
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
                    Store them somewhere safe — they are shown only once and let
                    you recover access if you lose your authenticator device.
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 6,
                      fontFamily: 'monospace',
                      fontSize: 13,
                      background: 'rgba(0,0,0,0.04)',
                      padding: 10,
                      borderRadius: 6,
                    }}
                  >
                    {mfaSetupData.backupCodes.map((c) => (
                      <code key={c}>{c}</code>
                    ))}
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={mfaSetupAcked}
                    onChange={(e) => setMfaSetupAcked(e.target.checked)}
                  />
                  I have saved the backup codes somewhere safe
                </label>

                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaSetupCode}
                  onChange={(e) => setMfaSetupCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="123456"
                  aria-label="Authenticator code"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid #f59e0b55',
                    fontSize: 18,
                    letterSpacing: 4,
                    marginBottom: 10,
                    background: '#fff',
                    color: '#111',
                  }}
                />

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setMfaSetup(null);
                      setMfaSetupData(null);
                      setMfaSetupCode('');
                      setMfaSetupAcked(false);
                      setError('');
                    }}
                    disabled={isLoading}
                    style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'transparent', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isLoading || !mfaSetupAcked || mfaSetupCode.length !== 6}
                    onClick={async () => {
                      if (!mfaSetupData) return;
                      setError('');
                      setIsLoading(true);
                      try {
                        await mfaSetupConfirm({
                          setupToken: mfaSetup.setupToken,
                          code: mfaSetupCode,
                          encryptedSecret: mfaSetupData.encryptedSecret,
                          backupCodes: mfaSetupData.backupCodes,
                        });
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'MFA setup failed');
                      } finally {
                        setIsLoading(false);
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: '#f59e0b',
                      color: '#fff',
                      border: 'none',
                      cursor: isLoading ? 'wait' : 'pointer',
                      fontWeight: 600,
                      opacity: isLoading ? 0.7 : 1,
                    }}
                  >
                    {isLoading ? 'Enrolling…' : 'Complete setup'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Security Badges */}
        <div className={styles.securityBadges}>
          <div className={styles.badge}>
            <span>🛡️</span>
            <span>HIPAA Compliant</span>
          </div>
          <div className={styles.badge}>
            <span>🔐</span>
            <span>256-bit Encryption</span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <p>© {new Date().getFullYear()} VH Health Hospital. All rights reserved.</p>
        <div className={styles.footerLinks}>
          <button type="button" className={styles.footerLink}>Terms</button>
          <button type="button" className={styles.footerLink}>Privacy</button>
          <button type="button" className={styles.footerLink}>Support</button>
        </div>
      </div>
    </div>
  );
}

// QueryClientProvider + AuthProvider are already mounted in the root layout
// via <Providers>, so no need to wrap again here.
export default function LoginClient() {
  return <LoginInner />;
}
