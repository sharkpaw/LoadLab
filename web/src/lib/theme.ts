import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'loadlab.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let mode = read();

/** Resolves the mode to light/dark on <html data-theme>; the CSS tokens in index.css follow it. */
function apply() {
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0e0d' : '#f6f6f4');
}

media.addEventListener('change', () => mode === 'system' && apply());
apply();

export function setTheme(next: ThemeMode) {
  mode = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mode,
  );
}
