import { useState } from 'react';
import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import { fmtMs } from '../lib/format';
import { t } from '../lib/i18n';
import { Badge, cx } from './ui';

export interface DebugEntry {
  flow: string;
  step: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  ok: boolean;
  error?: string;
  checks?: { name: string; ok: boolean }[];
  extracted?: Record<string, string>;
  bodyPreview?: string;
}

export function DebugTrace({ entries }: { entries: DebugEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!entries.length) return <div className="py-6 text-center text-sm text-ink-3">{t('No steps recorded yet…')}</div>;
  return (
    <ol className="space-y-1.5">
      {entries.map((e, i) => (
        <li key={i} className={cx('rounded-md border bg-surface-2', e.ok ? 'border-line' : 'border-bad/50')}>
          <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(open === i ? null : i)}>
            {e.ok ? <CheckCircle2 className="size-4 shrink-0 text-good" /> : <XCircle className="size-4 shrink-0 text-bad" />}
            <span className="text-sm font-medium">{e.step}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
              {e.method} {e.url}
            </span>
            {e.status !== undefined && <Badge tone={e.status >= 400 || e.status === 0 ? 'bad' : 'neutral'}>{e.status}</Badge>}
            <span className="tabular w-16 text-right text-xs text-ink-2">{fmtMs(e.durationMs)}</span>
            <ChevronRight className={cx('size-4 text-ink-3 transition-transform', open === i && 'rotate-90')} />
          </button>
          {open === i && (
            <div className="space-y-2 border-t border-line px-3 py-2 text-xs">
              {e.error && <div className="text-bad">{t('Error: {msg}', { msg: e.error })}</div>}
              {!!e.checks?.length && (
                <div>
                  <div className="mb-0.5 text-ink-3">{t('Checks')}</div>
                  {e.checks.map((c, j) => (
                    <div key={j} className={c.ok ? 'text-good' : 'text-bad'}>
                      {c.ok ? '✓' : '✗'} {c.name}
                    </div>
                  ))}
                </div>
              )}
              {e.extracted && Object.keys(e.extracted).length > 0 && (
                <div>
                  <div className="mb-0.5 text-ink-3">{t('Extracted variables')}</div>
                  {Object.entries(e.extracted).map(([k, v]) => (
                    <div key={k} className="font-mono">
                      <span className="text-warn">{k}</span> = <span className="break-all text-ink-2">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
              {e.bodyPreview && (
                <div>
                  <div className="mb-0.5 text-ink-3">{t('Response preview')}</div>
                  <pre className="max-h-60 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-ink-2">{e.bodyPreview}</pre>
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
