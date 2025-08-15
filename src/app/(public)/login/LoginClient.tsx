// src/app/(public)/login/LoginClient.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { QueryProvider } from '@/providers/query-provider';
import { Eye, EyeOff, User, Lock, AlertCircle, CheckCircle, Activity, Heart, Stethoscope, Shield } from 'lucide-react';

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
    <div className="min-h-screen relative flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-teal-50 overflow-hidden">
      {/* Hospital Background Image - Watermarked */}
      <div 
        className="absolute inset-0 opacity-[0.03] bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url('/images/hospital-building.jpg')`, // Replace with your hospital image
        }}
      />
      
      {/* Decorative Medical Icons Background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 left-20 text-blue-200 opacity-20 transform rotate-12">
          <Stethoscope className="w-32 h-32" />
        </div>
        <div className="absolute bottom-20 right-20 text-teal-200 opacity-20 transform -rotate-12">
          <Heart className="w-40 h-40" />
        </div>
        <div className="absolute top-1/3 right-1/4 text-blue-200 opacity-10">
          <Activity className="w-24 h-24" />
        </div>
        <div className="absolute bottom-1/4 left-1/3 text-teal-200 opacity-15 transform rotate-45">
          <Shield className="w-28 h-28" />
        </div>
      </div>

      {/* Animated gradient orbs */}
      <div className="absolute top-0 -left-4 w-72 h-72 bg-blue-300 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob"></div>
      <div className="absolute top-0 -right-4 w-72 h-72 bg-teal-300 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-2000"></div>
      <div className="absolute -bottom-8 left-20 w-72 h-72 bg-green-300 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-4000"></div>

      {/* Main Login Container */}
      <div className="relative z-10 w-full max-w-md mx-4">
        {/* Hospital Logo and Branding */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            {/* Replace src with your actual hospital logo */}
            <img 
              src="/images/hospital-logo.png" 
              alt="VH Health Hospital" 
              className="h-20 w-auto"
              onError={(e) => {
                // Fallback if logo doesn't load
                e.currentTarget.style.display = 'none';
                document.getElementById('logo-fallback')?.classList.remove('hidden');
              }}
            />
            {/* Fallback Logo */}
            <div id="logo-fallback" className="hidden">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-blue-500 to-teal-600 rounded-2xl shadow-xl">
                <div className="text-white">
                  <Heart className="w-10 h-10" />
                </div>
              </div>
            </div>
          </div>
          
          <h1 className="text-3xl font-bold text-gray-800 mb-1">VH Health</h1>
          <p className="text-sm text-gray-600">Excellence in Healthcare</p>
        </div>

        {/* Login Card */}
        <div className="bg-white/95 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/50">
          {/* Welcome Section */}
          <div className="text-center mb-6">
            <h2 className="text-2xl font-semibold text-gray-800">Welcome Back</h2>
            <p className="text-sm text-gray-600 mt-1">Admin Portal Access</p>
          </div>

          {/* Error Alert */}
          {error && (
            <div
              id="login-error"
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-xl bg-red-50 border border-red-200 p-4 animate-slideDown"
              aria-live="polite"
            >
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-red-700">{error}</span>
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
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1.5">
                Username
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className={`h-5 w-5 transition-colors ${
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
                  className={`block w-full pl-10 pr-10 py-3 border-2 ${
                    touched.username && fieldErrors.username 
                      ? 'border-red-300 focus:ring-red-500 focus:border-red-500 bg-red-50' 
                      : touched.username && !fieldErrors.username && username
                      ? 'border-green-300 focus:ring-green-500 focus:border-green-500 bg-green-50'
                      : 'border-gray-200 focus:ring-blue-500 focus:border-blue-500 bg-white'
                  } rounded-xl focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-all text-gray-900 placeholder-gray-400`}
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
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1.5">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className={`h-5 w-5 transition-colors ${
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
                  className={`block w-full pl-10 pr-12 py-3 border-2 ${
                    touched.password && fieldErrors.password 
                      ? 'border-red-300 focus:ring-red-500 focus:border-red-500 bg-red-50' 
                      : touched.password && !fieldErrors.password && password
                      ? 'border-green-300 focus:ring-green-500 focus:border-green-500 bg-green-50'
                      : 'border-gray-200 focus:ring-blue-500 focus:border-blue-500 bg-white'
                  } rounded-xl focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-all text-gray-900 placeholder-gray-400`}
                  placeholder="Enter your password"
                  aria-invalid={!!(touched.password && fieldErrors.password)}
                  aria-describedby={
                    (fieldErrors.password ? 'password-error ' : '') + 
                    (capsOn ? 'caps-warning' : '')
                  }
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
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
                <p id="caps-warning" className="mt-1.5 text-sm text-amber-600 animate-slideDown">
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
                <span className="ml-2 text-sm text-gray-600">Remember me</span>
              </label>
              <a 
                href="/forgot-password" 
                className="text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
              >
                Forgot password?
              </a>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={submitDisabled}
              className={`w-full py-3 px-4 rounded-xl font-semibold text-white transition-all transform hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                submitDisabled
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-600 to-teal-600 hover:from-blue-700 hover:to-teal-700 shadow-lg focus:ring-blue-500'
              }`}
            >
              {isLoading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Security Features */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
              <div className="flex items-center gap-1">
                <Shield className="h-3.5 w-3.5 text-green-500" />
                <span>HIPAA Compliant</span>
              </div>
              <div className="flex items-center gap-1">
                <Lock className="h-3.5 w-3.5 text-blue-500" />
                <span>256-bit Encryption</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-600">
            © 2024 VH Health Hospital. All rights reserved.
          </p>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs">
            <a href="/terms" className="text-blue-600 hover:text-blue-700 font-medium">Terms</a>
            <span className="text-gray-400">•</span>
            <a href="/privacy" className="text-blue-600 hover:text-blue-700 font-medium">Privacy</a>
            <span className="text-gray-400">•</span>
            <a href="/support" className="text-blue-600 hover:text-blue-700 font-medium">Support</a>
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
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
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

export default function LoginClient() {
  return (
    <QueryProvider>
      <AuthProvider>
        <LoginInner />
      </AuthProvider>
    </QueryProvider>
  );
}