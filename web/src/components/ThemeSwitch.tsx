import { Monitor, Moon, Sun } from 'lucide-react';
import { setTheme, useTheme, type ThemeMode } from '../lib/theme';
import { msg, t } from '../lib/i18n';
import { cx } from './ui';

const MODES: Record<ThemeMode, { label: string; icon: typeof Sun; next: ThemeMode }> = {
  system: { label: msg('Automatic'), icon: Monitor, next: 'light' },
  light: { label: msg('Light'), icon: Sun, next: 'dark' },
  dark: { label: msg('Dark'), icon: Moon, next: 'system' },
};

/** One icon button that cycles Automatic → Light → Dark; the icon shows the current mode. */
export function ThemeSwitch({ className }: { className?: string }) {
  const mode = useTheme();
  const { label, icon: Icon, next } = MODES[mode];
  const title = t('Theme: {mode}', { mode: t(label) });
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={title}
      aria-label={title}
      className={cx('grid size-7 shrink-0 place-items-center rounded-md border border-line text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink', className)}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
