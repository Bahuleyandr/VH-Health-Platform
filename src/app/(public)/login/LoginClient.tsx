// src/app/(public)/login/LoginClient.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { QueryProvider } from '@/providers/query-provider';
import {
  Eye,
  EyeOff,
  User,
  Lock,
  AlertCircle,
  CheckCircle,
  Activity,
  ShieldCheck,
} from 'lucide-react';

/**
 * Merged login:
 * - Your inline validation + micro-animations (shake, blobs, slideDown)
 * - My a11y, theme tokens, caps-lock hint, SSO stubs, two-column brand panel
 * - Unified "Remember me" keys: vh:remember / vh:savedUsername
 */
function LoginInner() {
  const { login } = useAuth();

  // form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);

  // UI state
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // validation & errors
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username: string; password: string }>({
    username: '',
    password: '',
  });
  const [touched, setTouched] = useState<{ username: boolean; password: boolean }>({
    username: false,
    password: false,
  });

  // refs for focus management
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  // autofocus & restore remember-me
  useEffect(() => {
    userRef.current?.focus();
    const saved = localStorage.getItem('vh:remember');
    const savedUser = localStorage.getItem('vh:savedUsername');
    if (saved === 'true' && savedUser) {
      setRememberMe(true);
      setUsername(savedUser);
      // move focus to password for quick login
      setTimeout(() => passRef.current?.focus(), 0);
    }
  }, []);

  // validators
  const validateField = (field: 'username' | 'password', value: string) => {
    let msg = '';
    if (!value) {
      msg = field === 'username' ? 'Username is required' : 'Password is required';
    } else if (field === 'username' && value.length < 3) {
      msg = 'Username must be at least 3 characters';
    } else if (field === 'password' && value.length < 4) {
      msg = 'Password must be at least 4 characters';
    }
    setFieldErrors((prev) => ({ ...prev, [field]: msg }));
    return msg;
  };

  const validateAll = () => {
    const u = username.trim();
    const p = password;
    const uErr = validateField('username', u);
    const pErr = validateField('password', p);
    return { ok: !uErr && !pErr, uErr, pErr };
  };

  const handleBlur = (field: 'username' | 'password') => {
    setTouched((t) => ({ ...t, [field]: true }));
    validateField(field, field === 'username' ? username.trim() : password);
  };

  const onCapsCheck = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsOn(e.getModifierState && e.getModifierState('CapsLock'));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched({ username: true, password: true });

    const { ok, uErr, pErr } = validateAll();
    if (!ok) {
      // shake + focus first invalid
      const form = document.getElementById('login-form');
      form?.classList.add('animate-shake');
      setTimeout(() => form?.classList.remove('animate-shake'), 500);
      if (uErr) userRef.current?.focus();
      else if (pErr) passRef.current?.focus();
      return;
    }

    setError('');
    setIsLoading(true);
    try {
      // persist username preference
      if (rememberMe) {
        localStorage.setItem('vh:remember', 'true');
        localStorage.setItem('vh:savedUsername', username.trim());
      } else {
        localStorage.removeItem('vh:remember');
        localStorage.removeItem('vh:savedUsername');
      }
      await login(username.trim(), password);
      // redirect handled by context
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Login failed. Please check your credentials.';
      setError(msg);
      // shake on failure
      const form = document.getElementById('login-form');
      form?.classList.add('animate-shake');
      setTimeout(() => form?.classList.remove('animate-shake'), 500);
      // focus username for quick retry
      userRef.current?.focus();
    } finally {
      setIsLoading(false);
    }
  };

  const hasErrors = !!(fieldErrors.username || fieldErrors.password);
  const disabled = isLoading || !username || !password;

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-background relative overflow-hidden">
      {/* Brand / Illustration (desktop only) */}
      <div className="relative hidden lg:flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-slate-950 dark:to-slate-900" />
        <div className="relative z-10 px-12">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl bg-blue-600 text-white grid place-items-center text-xl font-bold shadow-elev-3">
              VH
            </div>
            <div>
              <h2 className="text-2xl font-semibold">VH Health Admin</h2>
              <p className="text-sm text-muted-foreground">Secure access to your operations</p>
            </div>
          </div>

          <div className="mt-10 grid gap-4">
            <Feature title="Role-based access" description="Only what each role needs to see." />
            <Feature title="Audit-ready" description="Every sensitive action is tracked." />
            <Feature title="SLA monitoring" description="Realtime system health & alerts." />
          </div>
        </div>

        {/* decorative blobs */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-96 w-96 rounded-full bg-blue-200/40 blur-3xl dark:bg-blue-500/10 animate-blob" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl dark:bg-indigo-500/10 animate-blob animation-delay-2000" />
        <div className="pointer-events-none absolute top-20 left-24 h-80 w-80 rounded-full bg-pink-200/40 blur-3xl dark:bg-pink-500/10 animate-blob animation-delay-4000" />
      </div>

      {/* Form column */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          {/* Logo / header (mobile+desktop) */}
          <div className="mb-6 text-center lg:hidden">
            <div className="mx-auto mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-white shadow-lg">
              <Activity className="h-8 w-8" aria-hidden="true" />
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              VH Health
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Admin Portal Access</p>
          </div>

          <div className="rounded-2xl border bg-card p-6 shadow-elev-2 backdrop-blur">
            <div className="text-center">
              <h2 className="text-2xl font-semibold">Welcome back</h2>
              <p className="mt-1 text-sm text-muted-foreground">Enter your credentials to continue</p>
            </div>

            {/* error banner */}
            {error && (
              <div
                id="login-error"
                role="alert"
                aria-live="polite"
                className="mt-4 flex items-start gap-2 rounded-lg border border-red-600/20 bg-red-50 p-3 text-sm text-red-700 animate-slideDown dark:bg-red-500/10 dark:text-red-300"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <form
              id="login-form"
              className="mt-6 grid gap-5"
              onSubmit={handleSubmit}
              aria-busy={isLoading}
              noValidate
            >
              {/* username */}
              <div>
                <label htmlFor="username" className="mb-1 block text-sm font-medium">
                  Username
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 grid w-9 place-items-center text-muted-foreground">
                    <User
                      className={`h-4 w-4 ${
                        touched.username && fieldErrors.username ? 'text-red-500' : ''
                      }`}
                      aria-hidden="true"
                    />
                  </span>
                  <input
                    ref={userRef}
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    inputMode="text"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={isLoading}
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (touched.username) validateField('username', e.target.value);
                    }}
                    onBlur={() => handleBlur('username')}
                    aria-invalid={!!(touched.username && fieldErrors.username)}
                    aria-describedby={
                      (touched.username && fieldErrors.username ? 'username-error ' : '') +
                      (error ? 'login-error' : '')
                    }
                    className={`w-full rounded-lg border px-10 py-2.5 text-base shadow-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring ${
                      touched.username && fieldErrors.username
                        ? 'border-red-300'
                        : 'border-input bg-background'
                    }`}
                    placeholder="you@company.com"
                  />
                  {touched.username && !fieldErrors.username && username && (
                    <span className="absolute inset-y-0 right-0 grid place-items-center pr-3">
                      <CheckCircle className="h-5 w-5 text-emerald-500" aria-hidden="true" />
                    </span>
                  )}
                </div>
                {touched.username && fieldErrors.username && (
                  <p id="username-error" className="mt-1 text-sm text-red-600 animate-slideDown">
                    {fieldErrors.username}
                  </p>
                )}
              </div>

              {/* password */}
              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium">
                  Password
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 grid w-9 place-items-center text-muted-foreground">
                    <Lock
                      className={`h-4 w-4 ${
                        touched.password && fieldErrors.password ? 'text-red-500' : ''
                      }`}
                      aria-hidden="true"
                    />
                  </span>
                  <input
                    ref={passRef}
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    disabled={isLoading}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (touched.password) validateField('password', e.target.value);
                    }}
                    onBlur={() => handleBlur('password')}
                    onKeyUp={onCapsCheck}
                    aria-invalid={!!(touched.password && fieldErrors.password)}
                    aria-describedby={
                      (touched.password && fieldErrors.password ? 'password-error ' : '') +
                      (capsOn ? 'caps-hint ' : '') +
                      (error ? 'login-error' : '')
                    }
                    className={`w-full rounded-lg border px-10 py-2.5 pr-10 text-base shadow-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring ${
                      touched.password && fieldErrors.password
                        ? 'border-red-300'
                        : 'border-input bg-background'
                    }`}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    disabled={isLoading}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {capsOn && (
                  <p id="caps-hint" className="mt-1 text-xs text-amber-600">
                    Caps Lock is ON
                  </p>
                )}
                {touched.password && fieldErrors.password && (
                  <p id="password-error" className="mt-1 text-sm text-red-600 animate-slideDown">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              {/* options */}
              <div className="flex items-center justify-between">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-muted-foreground/30 text-blue-600 focus:ring-blue-600"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    disabled={isLoading}
                  />
                  Remember me
                </label>
                <a className="text-sm text-blue-600 hover:underline" href="/forgot-password">
                  Forgot password?
                </a>
              </div>

              {/* submit */}
              <button
                type="submit"
                disabled={disabled || hasErrors}
                className={`inline-flex h-10 w-full items-center justify-center rounded-lg px-4 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
                  disabled || hasErrors
                    ? 'bg-gray-400/80 dark:bg-gray-600/60 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 shadow-lg hover:shadow-xl transition-all'
                }`}
              >
                {isLoading ? (
                  <span className="inline-flex items-center gap-2">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                    Signing in…
                  </span>
                ) : (
                  'Sign in'
                )}
              </button>

              {/* divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              {/* SSO stubs */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-lg border bg-background px-4 text-sm hover:bg-muted"
                  onClick={() => (window.location.href = '/api/auth/sso/google')}
                  disabled={isLoading}
                >
                  {/* simple G icon path */}
                  <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                    <path d="M21.35 11.1h-9.18v2.96h5.26a4.51 4.51 0 01-1.95 2.95l3.15 2.44c1.84-1.7 2.9-4.2 2.9-7.17 0-.49-.04-.96-.11-1.42z" />
                    <path d="M12.17 22c2.62 0 4.82-.86 6.42-2.35l-3.15-2.44c-.88.6-2 1-3.27 1a5.66 5.66 0 01-5.35-3.79H3.52v2.38A10 10 0 0012.17 22z" />
                    <path d="M6.82 14.42a6 6 0 010-3.84V8.2H3.52a10 10 0 000 7.6l3.3-1.38z" />
                    <path d="M12.17 6.27c1.42 0 2.7.49 3.71 1.46l2.78-2.78A9.63 9.63 0 0012.17 2a10 10 0 00-8.65 4.95l3.3 2.38a5.67 5.67 0 015.35-3.06z" />
                  </svg>
                  Continue with Google
                </button>

                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-lg border bg-background px-4 text-sm hover:bg-muted"
                  onClick={() => (window.location.href = '/api/auth/sso/azure')}
                  disabled={isLoading}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                  Continue with Azure AD
                </button>
              </div>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            By continuing you agree to our{' '}
            <a className="underline hover:text-foreground" href="/terms">
              Terms
            </a>{' '}
            &{' '}
            <a className="underline hover:text-foreground" href="/privacy">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>

      {/* Local styles for micro-animations */}
      <style jsx>{`
        @keyframes blob {
          0% { transform: translate(0px, 0px) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
          100% { transform: translate(0px, 0px) scale(1); }
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
          20%, 40%, 60%, 80% { transform: translateX(2px); }
        }
        .animate-blob { animation: blob 7s infinite; }
        .animation-delay-2000 { animation-delay: 2s; }
        .animation-delay-4000 { animation-delay: 4s; }
        .animate-slideDown { animation: slideDown 0.28s ease-out; }
        .animate-shake { animation: shake 0.5s ease-in-out; }
      `}</style>
    </div>
  );
}

function Feature({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border bg-card/50 p-4 shadow-sm backdrop-blur-sm">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export default function LoginClient() {
  // If your (public) segment is already wrapped globally, remove the providers here.
  return (
    <QueryProvider>
      <AuthProvider>
        <LoginInner />
      </AuthProvider>
    </QueryProvider>
  );
}
