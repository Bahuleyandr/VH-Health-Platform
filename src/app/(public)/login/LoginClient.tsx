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
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { QueryProvider } from '@/providers/query-provider';
import Image from 'next/image';
import styles from './Login.module.css';

function LoginInner() {
  const { login } = useAuth();

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
      await login(username.trim(), password);
      
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
          <p className={styles.welcomeSubtitle}>Admin Portal Access</p>
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
              Username
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
                className={`${styles.input} ${
                  touched.username && fieldErrors.username
                    ? styles.inputError
                    : touched.username && !fieldErrors.username && username
                    ? styles.inputSuccess
                    : ''
                }`}
                placeholder="Enter your username"
              />
              {touched.username && !fieldErrors.username && username && (
                <span className={styles.checkIcon}>✓</span>
              )}
            </div>
            {touched.username && fieldErrors.username && (
              <p className={styles.errorMessage}>{fieldErrors.username}</p>
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
        <p>© 2024 VH Health Hospital. All rights reserved.</p>
        <div className={styles.footerLinks}>
          <button type="button" className={styles.footerLink}>Terms</button>
          <button type="button" className={styles.footerLink}>Privacy</button>
          <button type="button" className={styles.footerLink}>Support</button>
        </div>
      </div>
    </div>
  );
}

export default function LoginClient() {
  return (
    <QueryProvider>
      <AuthProvider>
        <LoginInner />
      </AuthProvider>
    </QueryProvider>
  );
}
