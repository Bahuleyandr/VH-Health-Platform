// src/app/(public)/login/LoginClient.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { QueryProvider } from '@/providers/query-provider';
import { Eye, EyeOff, User, Lock, AlertCircle, CheckCircle, ShieldCheck, Activity, Shield, BarChart3, Loader2 } from 'lucide-react';

function LoginInner() {
  const { login } = useAuth();

  // Form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  
  // Validation state
  const [touched, setTouched] = useState({ username: false, password: false });
  const [fieldErrors, setFieldErrors] = useState({ username: '', password: '' });
  
  // Submit state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Autofocus management
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    // Check for saved credentials
    const saved = localStorage.getItem('vh:remember');
    const savedUser = localStorage.getItem('vh:savedUsername');
    
    if (saved === 'true' && savedUser) {
      setRemember(true);
      setUsername(savedUser);
      // Focus password field if username is prefilled
      setTimeout(() => passwordRef.current?.focus(), 100);
    } else {
      // Focus username field
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
    
    // Validate all fields
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
      
      // Save preference after successful login
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
      
      // Add subtle shake animation to form
      const form = document.getElementById('login-form');
      form?.classList.add('animate-shake');
      setTimeout(() => form?.classList.remove('animate-shake'), 500);
    } finally {
      setIsLoading(false);
    }
  };

  const disabled = isLoading;
  const hasErrors = !!(fieldErrors.username || fieldErrors.password);
  const submitDisabled = disabled || !username || !password || hasErrors;

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      {/* Left: Brand Panel */}
      <div className="hidden lg:flex relative items-center justify-center overflow-hidden bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-slate-950 dark:to-slate-900">
        {/* Animated background elements */}
        <div className="absolute inset-0">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-300/30 rounded-full mix-blend-multiply filter blur-xl animate-blob"></div>
          <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-300/30 rounded-full mix-blend-multiply filter blur-xl animate-blob animation-delay-2000"></div>
          <div className="absolute top-40 left-40 w-80 h-80 bg-indigo-300/30 rounded-full mix-blend-multiply filter blur-xl animate-blob animation-delay-4000"></div>
        </div>

        <div className="relative z-10 px-12 max-w-lg">
          {/* Logo and Brand */}
          <div className="flex items-center gap-4 mb-12">
            <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white grid place-items-center shadow-xl transform hover:scale-105 transition-transform">
              <Activity className="h-8 w-8" />
            </div>
            <div>
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white">VH Health</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">Admin Portal</p>
            </div>
          </div>

          {/* Welcome Message */}
          <div className="mb-10">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
              Welcome Back
            </h1>
            <p className="text-lg text-gray-600 dark:text-gray-400">
              Secure access to your healthcare operations dashboard
            </p>
          </div>

          {/* Features */}
          <div className="grid gap-4">
            <Feature 
              icon={<Shield className="h-5 w-5" />}
              title="Role-based Access" 
              description="Granular permissions for each team member"
            />
            <Feature 
              icon={<BarChart3 className="h-5 w-5" />}
              title="Real-time Analytics" 
              description="Monitor system health and performance metrics"
            />
            <Feature 
              icon={<ShieldCheck className="h-5 w-5" />}
              title="HIPAA Compliant" 
              description="Enterprise-grade security and audit logging"
            />
          </div>
        </div>
      </div>

      {/* Right: Login Form */}
      <div className="flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-6 py-12">
        <div className="w-full max-w-md">
          {/* Mobile Logo */}
          <div className="lg:hidden mb-8 text-center">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white mb-4">
              <Activity className="h-7 w-7" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">VH Health Admin</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Sign in to continue</p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Sign In</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Enter your credentials to access the admin portal</p>
            </div>

            {/* Error Alert */}
            {error && (
              <div
                id="login-error"
                role="alert"
                className="mb-6 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4 animate-slideDown"
                aria-live="polite"
              >
                <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
              </div>
            )}

            <form
              id="login-form"
              className="space-y-5"
              onSubmit={handleSubmit}
              noValidate
            >
              {/* Username Field */}
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Username
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <User className={`h-5 w-5 ${
                      touched.username && fieldErrors.username 
                        ? 'text-red-400' 
                        : touched.username && !fieldErrors.username 
                        ? 'text-green-500'
                        : 'text-gray-400'
                    }`} />
                  </div>
                  <input
                    ref={userRef}
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    disabled={disabled}
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (touched.username) validateField('username', e.target.value);
                    }}
                    onBlur={() => handleBlur('username')}
                    className={`block w-full pl-10 pr-10 py-2.5 border ${
                      touched.username && fieldErrors.username 
                        ? 'border-red-300 focus:ring-red-500 focus:border-red-500' 
                        : touched.username && !fieldErrors.username && username
                        ? 'border-green-300 focus:ring-green-500 focus:border-green-500'
                        : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500'
                    } rounded-lg focus:outline-none focus:ring-2 transition-colors bg-white dark:bg-gray-900 dark:border-gray-600`}
                    placeholder="Enter your username"
                    aria-invalid={!!(touched.username && fieldErrors.username)}
                    aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                  />
                  {touched.username && !fieldErrors.username && username && (
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                      <CheckCircle className="h-5 w-5 text-green-500 animate-fadeIn" />
                    </div>
                  )}
                </div>
                {touched.username && fieldErrors.username && (
                  <p id="username-error" className="mt-1.5 text-sm text-red-600 animate-slideDown">
                    {fieldErrors.username}
                  </p>
                )}
              </div>

              {/* Password Field */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className={`h-5 w-5 ${
                      touched.password && fieldErrors.password 
                        ? 'text-red-400' 
                        : touched.password && !fieldErrors.password 
                        ? 'text-green-500'
                        : 'text-gray-400'
                    }`} />
                  </div>
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
                    className={`block w-full pl-10 pr-12 py-2.5 border ${
                      touched.password && fieldErrors.password 
                        ? 'border-red-300 focus:ring-red-500 focus:border-red-500' 
                        : touched.password && !fieldErrors.password && password
                        ? 'border-green-300 focus:ring-green-500 focus:border-green-500'
                        : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500'
                    } rounded-lg focus:outline-none focus:ring-2 transition-colors bg-white dark:bg-gray-900 dark:border-gray-600`}
                    placeholder="Enter your password"
                    aria-invalid={!!(touched.password && fieldErrors.password)}
                    aria-describedby={
                      (fieldErrors.password ? 'password-error ' : '') + 
                      (capsOn ? 'caps-warning' : '')
                    }
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={disabled}
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
                {touched.password && fieldErrors.password && (
                  <p id="password-error" className="mt-1.5 text-sm text-red-600 animate-slideDown">
                    {fieldErrors.password}
                  </p>
                )}
                {capsOn && (
                  <p id="caps-warning" className="mt-1.5 text-sm text-amber-600 dark:text-amber-400 animate-slideDown">
                    ⚠️ Caps Lock is ON
                  </p>
                )}
              </div>

              {/* Remember & Forgot */}
              <div className="flex items-center justify-between">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    disabled={disabled}
                  />
                  <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">Remember me</span>
                </label>
                <a 
                  href="/forgot-password" 
                  className="text-sm text-blue-600 hover:text-blue-500 transition-colors"
                >
                  Forgot password?
                </a>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={submitDisabled}
                className={`w-full py-2.5 px-4 rounded-lg font-medium transition-all transform hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                  submitDisabled
                    ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg'
                }`}
              >
                {isLoading ? (
                  <span className="flex items-center justify-center">
                    <Loader2 className="animate-spin -ml-1 mr-3 h-5 w-5" />
                    Signing in...
                  </span>
                ) : (
                  'Sign In'
                )}
              </button>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300 dark:border-gray-600"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white dark:bg-gray-800 text-gray-500">Or continue with</span>
                </div>
              </div>

              {/* SSO Options */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => window.location.href = '/api/auth/sso/google'}
                  className="flex items-center justify-center py-2.5 px-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span className="text-sm font-medium">Google</span>
                </button>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => window.location.href = '/api/auth/sso/azure'}
                  className="flex items-center justify-center py-2.5 px-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ShieldCheck className="w-5 h-5 mr-2 text-blue-600" />
                  <span className="text-sm font-medium">Azure AD</span>
                </button>
              </div>
            </form>

            {/* Footer Links */}
            <p className="mt-6 text-center text-xs text-gray-500 dark:text-gray-400">
              By continuing, you agree to our{' '}
              <a href="/terms" className="text-blue-600 hover:underline">Terms</a>
              {' '}and{' '}
              <a href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</a>
            </p>
          </div>

          {/* Security Badge */}
          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-1">
              <Shield className="h-3.5 w-3.5" />
              Protected by enterprise-grade security
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes blob {
          0% { transform: translate(0px, 0px) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
          100% { transform: translate(0px, 0px) scale(1); }
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
          20%, 40%, 60%, 80% { transform: translateX(2px); }
        }
        .animate-blob { animation: blob 7s infinite; }
        .animation-delay-2000 { animation-delay: 2s; }
        .animation-delay-4000 { animation-delay: 4s; }
        .animate-slideDown { animation: slideDown 0.3s ease-out; }
        .animate-fadeIn { animation: fadeIn 0.3s ease-out; }
        .animate-shake { animation: shake 0.5s ease-in-out; }
      `}</style>
    </div>
  );
}

function Feature({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex gap-4 p-4 rounded-xl bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm border border-white/20 dark:border-gray-700/20">
      <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
        {icon}
      </div>
      <div>
        <p className="font-medium text-gray-900 dark:text-white">{title}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
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