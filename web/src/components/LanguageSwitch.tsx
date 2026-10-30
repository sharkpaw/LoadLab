import { Languages } from 'lucide-react';
import { LANGUAGES, getLang, setLang, t, type Lang } from '../lib/i18n';
import { cx } from './ui';

export function LanguageSwitch({ className }: { className?: string }) {
  const lang = getLang();
  return (
    <div className={cx('flex items-center gap-1.5', className)} role="group" aria-label={t('Language')}>
      <Languages className="size-3.5 text-ink-3" aria-hidden />
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          onClick={() => setLang(l.code as Lang)}
          aria-pressed={lang === l.code}
          className={cx('rounded px-1.5 py-0.5 text-xs transition-colors', lang === l.code ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink')}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
