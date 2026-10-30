import { useEffect, useReducer } from 'react';
import { tr } from '../locales/tr';

/**
 * Minimal i18n: English source strings are the keys; other languages map them.
 *   t('Save')                      → "Kaydet" in Turkish
 *   t('{n} runs', { n: 3 })        → placeholders in {braces}
 * Always pass a string literal to t() (or msg() in constants) so scripts/check-i18n.ts can find it.
 */

export type Lang = 'en' | 'tr';

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
];

const DICTS: Record<Lang, Record<string, string>> = { en: {}, tr };
const STORAGE_KEY = 'loadlab.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'tr') return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

/** BCP-47 locale for number/date formatting. */
export function locale(): string {
  return current === 'tr' ? 'tr-TR' : 'en-US';
}

function interpolate(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

/** Marks a source string for extraction without translating it yet (for constant arrays; call t() at render). */
export const msg = (s: string) => s;

export function t(s: string, vars?: Record<string, string | number>): string {
  if (current === 'en') return interpolate(s, vars);
  const hit = DICTS[current][s];
  if (hit === undefined && import.meta.env.DEV) console.warn(`[i18n] missing ${current}: ${JSON.stringify(s)}`);
  return interpolate(hit ?? s, vars);
}

/** Exact server messages (see server executor/services); listed so check-i18n requires their translations. */
export const SERVER_MESSAGES = [
  msg('Stopped by user'),
  msg('Canceled while queued'),
  msg('Maximum duration exceeded'),
  msg('Worker shut down'),
  msg('Worker not responding (crashed or restarted)'),
];

/**
 * Text produced by the server (stop reasons, warnings, breach reasons) is English.
 * Translate the known patterns; unknown text is shown as-is.
 */
export function tServer(s: string | null | undefined): string {
  if (!s) return '';
  if (current === 'en') return s;
  const exact = DICTS[current][s];
  if (exact) return exact;
  let m: RegExpExecArray | null;
  if ((m = /^Threshold exceeded: (.*)$/.exec(s))) return t('Threshold exceeded: {reason}', { reason: tServer(m[1]) });
  if ((m = /^p95 (\S+) ms > (\S+) ms \(last (\d+)s\)$/.exec(s))) return t('p95 {a} ms > {b} ms (last {w}s)', { a: m[1], b: m[2], w: m[3] });
  if ((m = /^error rate (\S+)% > (\S+)% \(last (\d+)s\)$/.exec(s))) return t('error rate {a}% > {b}% (last {w}s)', { a: m[1], b: m[2], w: m[3] });
  if ((m = /^(\d+) iterations could not start \(dropped\)/.exec(s))) return t('{n} iterations could not start (dropped). The VU pool was too small for the target rate, or the system slowed down; increase maxVUs.', { n: m[1] });
  if ((m = /^Load generator \(k6\) CPU reached (\d+)% \((\S+) cores\)/.exec(s))) {
    return t('Load generator (k6) CPU reached {pct}% ({cores} cores). Results may be limited by the load generator; give the worker more CPU.', { pct: m[1], cores: m[2] });
  }
  if ((m = /^k6 exit code: (.*)$/.exec(s))) return t('k6 exit code: {code}', { code: m[1] });
  return s;
}

/** Re-render the calling component (use once at the app root) when the language changes. */
export function useLang(): Lang {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return current;
}
