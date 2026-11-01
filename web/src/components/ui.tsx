import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Eye, EyeOff, Loader2, X, XCircle, Plus, Trash2, Ban, PauseCircle } from 'lucide-react';
import { statusLabel } from '../lib/constants';
import { t } from '../lib/i18n';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; icon?: ReactNode; loading?: boolean }) {
  const v: Record<BtnVariant, string> = {
    primary: 'bg-accent text-white hover:bg-accent-strong border-transparent',
    secondary: 'bg-surface-2 text-ink border-line-strong hover:bg-surface-3',
    ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-2 hover:text-ink',
    danger: 'bg-transparent text-bad border-bad/40 hover:bg-bad/10',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        v[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('min-w-0 rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad'; className?: string }) {
  const t = {
    neutral: 'bg-surface-3 text-ink-2',
    accent: 'bg-accent/15 text-tint-blue',
    good: 'bg-good/15 text-good',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad',
  }[tone];
  return <span className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', t, className)}>{children}</span>;
}

type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

function statusStyle(status: string): { tone: Tone; icon: ReactNode } {
  const map: Record<string, { tone: Tone; icon: ReactNode }> = {
    queued: { tone: 'neutral', icon: <CircleDashed className="size-3" /> },
    starting: { tone: 'accent', icon: <Loader2 className="size-3 animate-spin" /> },
    running: { tone: 'accent', icon: <Loader2 className="size-3 animate-spin" /> },
    stopping: { tone: 'warn', icon: <Loader2 className="size-3 animate-spin" /> },
    completed: { tone: 'good', icon: <CheckCircle2 className="size-3" /> },
    stopped: { tone: 'warn', icon: <PauseCircle className="size-3" /> },
    failed: { tone: 'bad', icon: <XCircle className="size-3" /> },
    canceled: { tone: 'neutral', icon: <Ban className="size-3" /> },
    draft: { tone: 'warn', icon: null },
    ready: { tone: 'good', icon: null },
    active: { tone: 'good', icon: null },
    archived: { tone: 'neutral', icon: null },
  };
  return map[status] ?? { tone: 'neutral', icon: null };
}

export function StatusBadge({ status }: { status: string }) {
  const m = statusStyle(status);
  return (
    <Badge tone={m.tone}>
      {m.icon}
      {statusLabel(status)}
    </Badge>
  );
}

/** The status icon alone, colored by tone; the label is the tooltip (for dense rows). */
export function StatusIcon({ status }: { status: string }) {
  const m = statusStyle(status);
  const color = { neutral: 'text-ink-3', accent: 'text-tint-blue', good: 'text-good', warn: 'text-warn', bad: 'text-bad' }[m.tone];
  return (
    <span className={cx('inline-flex [&>svg]:size-3.5', color)} title={statusLabel(status)} aria-label={statusLabel(status)}>
      {m.icon}
    </span>
  );
}

export function PassBadge({ passed }: { passed: boolean | null | undefined }) {
  if (passed === null || passed === undefined) return null;
  return passed ? (
    <Badge tone="good">
      <CheckCircle2 className="size-3" /> {t('Thresholds passed')}
    </Badge>
  ) : (
    <Badge tone="bad">
      <XCircle className="size-3" /> {t('Threshold failed')}
    </Badge>
  );
}

// ---------------------------------------------------------------------------

export const inputCls =
  'w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/50';

/** Drops the default w-full when the caller passes a width (w-* or flex-1); otherwise the two classes conflict. */
function fieldCls(...extra: (string | undefined)[]) {
  const e = cx(...extra);
  const base = /(^|\s)flex-1/.test(e) ? inputCls.replace('w-full ', '') : /(^|\s)w-/.test(e) ? inputCls.replace('w-full ', 'shrink-0 ') : inputCls;
  return cx(base, e, /(^|\s)flex-1/.test(e) && 'min-w-0');
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={fieldCls(props.className)} />;
}

/** Password field with a show/hide toggle. */
export function PasswordInput({ className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? 'text' : 'password'} className={cx(fieldCls(className), 'pr-10')} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? t('Hide password') : t('Show password')}
        title={show ? t('Hide password') : t('Show password')}
        className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function NumberInput({ value, onChange, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | undefined | null; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      {...rest}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className={fieldCls('tabular', rest.className)}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={fieldCls('font-mono text-xs', props.className)} />;
}

export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...props} className={fieldCls('pr-8', props.className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-2 select-none">
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && onChange(!checked)}
        onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}
      >
        <span className={cx('absolute top-0.5 size-4 rounded-full bg-white transition-all', checked ? 'left-4.5' : 'left-0.5')} />
      </span>
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={cx('tabular mt-1 text-2xl font-semibold tracking-tight', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-ink')}>{value}</div>
      {sub && <div className="tabular mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-md text-xs text-ink-3">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-ink-3', className)} />;
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && <div className="mb-1 text-xs text-ink-3">{back}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-ink-3">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm transition-colors', value === t.value ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div className={cx('w-full rounded-lg border border-line-strong bg-surface shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label={t('Close')}>
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ tone = 'warn', children, title }: { tone?: 'warn' | 'bad' | 'good' | 'accent'; children: ReactNode; title?: ReactNode }) {
  const t = { warn: 'border-warn/30 bg-warn/10', bad: 'border-bad/30 bg-bad/10', good: 'border-good/30 bg-good/10', accent: 'border-accent/30 bg-accent/10' }[tone];
  const ic = { warn: 'text-warn', bad: 'text-bad', good: 'text-good', accent: 'text-tint-blue' }[tone];
  return (
    <div className={cx('flex gap-2.5 rounded-md border px-3 py-2.5 text-sm', t)}>
      <AlertTriangle className={cx('mt-0.5 size-4 shrink-0', ic)} />
      <div className="min-w-0 text-ink-2">
        {title && <div className="font-medium text-ink">{title}</div>}
        <div className="whitespace-pre-wrap">{children}</div>
      </div>
    </div>
  );
}

/** Key/value editor (headers, variables). */
export function KeyValueEditor({ value, onChange, keyPlaceholder, valuePlaceholder }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value ?? {}));
  const last = useRef(JSON.stringify(value ?? {}));
  useEffect(() => {
    const s = JSON.stringify(value ?? {});
    if (s !== last.current) {
      last.current = s;
      setRows(Object.entries(value ?? {}));
    }
  }, [value]);
  const emit = (r: [string, string][]) => {
    setRows(r);
    const obj = Object.fromEntries(r.filter(([k]) => k.trim()));
    last.current = JSON.stringify(obj);
    onChange(obj);
  };
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <Input className="font-mono text-xs" placeholder={keyPlaceholder ?? t('key')} value={k} onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <Input className="font-mono text-xs" placeholder={valuePlaceholder ?? t('value')} value={v} onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <Button variant="ghost" size="sm" className="h-auto" onClick={() => emit(rows.filter((_, j) => j !== i))} aria-label={t('Delete')}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows([...rows, ['', '']])}>
        {t('Add')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts

type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'neutral' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'neutral') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'rounded-md border bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap shadow-lg',
              t.tone === 'bad' ? 'border-bad/50' : t.tone === 'good' ? 'border-good/50' : 'border-line-strong',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------------------

interface ConfirmOptions {
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  icon?: ReactNode;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => true);

/** Promise-based confirmation dialog: `if (!(await confirm({...}))) return;` */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = useCallback(
    (v: boolean) => {
      state?.resolve(v);
      setState(null);
    },
    [state],
  );
  const cancel = useCallback(() => close(false), [close]);
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal
        open={!!state}
        onClose={cancel}
        title={state?.title}
        footer={
          <>
            <Button onClick={cancel}>{t('Cancel')}</Button>
            <Button variant="primary" icon={state?.icon} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel}
            </Button>
          </>
        }
      >
        {state?.body}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// ---------------------------------------------------------------------------

/** Simple data loading hook with optional polling. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    reload();
    if (!pollMs) return;
    const h = setInterval(reload, pollMs);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}
