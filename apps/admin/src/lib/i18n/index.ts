/**
 * Lightweight i18n utility for the VHHealth Admin Portal.
 *
 * Usage:
 *   import { t, setLocale, getLocale } from '@/lib/i18n';
 *
 *   // In components:
 *   <h1>{t('dashboard.title')}</h1>
 *   <button>{t('common.save')}</button>
 *
 *   // Switch language:
 *   setLocale('hi');
 *
 * Supports dotted key paths: t('auth.loginFailed')
 * Falls back to English if key is missing in current locale.
 */

import en from "./en.json";
import hi from "./hi.json";

type Locale = "en" | "hi";

const messages: Record<Locale, Record<string, unknown>> = { en, hi };

const STORAGE_KEY = "vhhealth_locale";

let currentLocale: Locale = "en";

// Rehydrate from localStorage on module load
if (typeof window !== "undefined") {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "hi") {
    currentLocale = stored;
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale) {
  currentLocale = locale;
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, locale);
  }
}

export function getAvailableLocales(): { code: Locale; label: string }[] {
  return [
    { code: "en", label: "English" },
    { code: "hi", label: "हिन्दी" },
  ];
}

/**
 * Translate a dotted key path. Returns the key itself if not found.
 *
 * @example t('common.save')    // "Save"
 * @example t('auth.login')     // "Login"
 * @example t('missing.key')    // "missing.key" (fallback)
 */
export function t(key: string): string {
  const value = resolve(messages[currentLocale], key);
  if (typeof value === "string") return value;

  // Fallback to English
  if (currentLocale !== "en") {
    const fallback = resolve(messages.en, key);
    if (typeof fallback === "string") return fallback;
  }

  return key;
}

function resolve(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
