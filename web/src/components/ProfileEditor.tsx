import { Plus, Trash2 } from 'lucide-react';
import { PROFILE_KINDS } from '../lib/constants';
import { msg, t } from '../lib/i18n';
import { fmtDuration } from '../lib/format';
import { Button, Field, NumberInput, cx } from './ui';
import { StagePreview } from './charts';

export interface Profile {
  kind: string;
  vus?: number;
  duration?: number;
  rate?: number;
  stages?: { duration: number; target: number }[];
  startRate?: number;
  maxRate?: number;
  preAllocatedVUs?: number;
  maxVUs?: number;
}

const scale = (v: number, f: number) => Math.max(1, Math.round(v * f));

export function defaultStages(kind: string, vus: number, duration: number) {
  if (kind === 'stress')
    return [
      { duration: 60, target: scale(vus, 0.25) },
      { duration: 120, target: scale(vus, 0.25) },
      { duration: 60, target: scale(vus, 0.5) },
      { duration: 120, target: scale(vus, 0.5) },
      { duration: 60, target: vus },
      { duration: 120, target: vus },
      { duration: 60, target: 0 },
    ];
  if (kind === 'spike')
    return [
      { duration: 30, target: scale(vus, 0.1) },
      { duration: 60, target: scale(vus, 0.1) },
      { duration: 10, target: vus },
      { duration: 60, target: vus },
      { duration: 10, target: scale(vus, 0.1) },
      { duration: 60, target: scale(vus, 0.1) },
      { duration: 10, target: 0 },
    ];
  return [
    { duration: 60, target: vus },
    { duration, target: vus },
    { duration: 30, target: 0 },
  ];
}

export const PROFILE_DEFAULTS: Record<string, Profile> = {
  smoke: { kind: 'smoke', vus: 1, duration: 60 },
  constant_vus: { kind: 'constant_vus', vus: 20, duration: 300 },
  constant_rate: { kind: 'constant_rate', rate: 10, duration: 300 },
  ramp: { kind: 'ramp', vus: 50, duration: 300 },
  stress: { kind: 'stress', vus: 200 },
  spike: { kind: 'spike', vus: 300 },
  soak: { kind: 'soak', vus: 30, duration: 3600 },
  breakpoint: { kind: 'breakpoint', startRate: 1, maxRate: 300, duration: 600 },
};

/** Load shape of a profile: (second, value) points. */
export function loadShape(p: Profile): { points: { t: number; v: number }[]; unit: string; total: number } {
  const pts: { t: number; v: number }[] = [];
  switch (p.kind) {
    case 'smoke':
    case 'constant_vus':
    case 'soak': {
      const d = p.duration ?? 60;
      const v = p.vus ?? 1;
      return { points: [{ t: 0, v }, { t: d, v }], unit: msg('virtual users'), total: d };
    }
    case 'constant_rate': {
      const d = p.duration ?? 300;
      return { points: [{ t: 0, v: p.rate ?? 10 }, { t: d, v: p.rate ?? 10 }], unit: msg('flows / s'), total: d };
    }
    case 'breakpoint': {
      if (p.stages?.length) break;
      const d = p.duration ?? 600;
      return { points: [{ t: 0, v: p.startRate ?? 1 }, { t: d, v: p.maxRate ?? 300 }], unit: msg('flows / s'), total: d };
    }
  }
  const stages = p.stages?.length ? p.stages : defaultStages(p.kind, p.vus ?? 50, p.duration ?? 300);
  let t = 0;
  pts.push({ t: 0, v: p.kind === 'breakpoint' ? (p.startRate ?? 0) : 0 });
  for (const s of stages) {
    t += s.duration;
    pts.push({ t, v: s.target });
  }
  return { points: pts, unit: p.kind === 'breakpoint' ? msg('flows / s') : msg('virtual users'), total: t };
}

export function ProfileEditor({ value, onChange }: { value: Profile; onChange: (p: Profile) => void }) {
  const p = value;
  const set = (patch: Partial<Profile>) => onChange({ ...p, ...patch });
  const usesStages = ['ramp', 'stress', 'spike'].includes(p.kind);
  const shape = loadShape(p);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {PROFILE_KINDS.map((k) => (
          <button
            key={k.kind}
            onClick={() => onChange({ ...PROFILE_DEFAULTS[k.kind] })}
            className={cx('rounded-md border px-3 py-2 text-left transition-colors', p.kind === k.kind ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong hover:bg-surface-2')}
          >
            <div className="text-sm font-medium">{t(k.label)}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{t(k.desc)}</div>
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {['smoke', 'constant_vus', 'soak', 'ramp', 'stress', 'spike'].includes(p.kind) && (
          <Field label={usesStages ? t('Target (peak) users') : t('Concurrent users (VUs)')}>
            <NumberInput min={1} value={p.vus} onChange={(v) => set({ vus: v, stages: undefined })} />
          </Field>
        )}
        {['smoke', 'constant_vus', 'soak', 'constant_rate', 'ramp', 'breakpoint'].includes(p.kind) && (
          <Field label={p.kind === 'ramp' ? t('Hold time at peak (s)') : p.kind === 'breakpoint' ? t('Ramp duration (s)') : t('Duration (s)')} hint={fmtDuration(p.duration)}>
            <NumberInput min={1} value={p.duration} onChange={(v) => set({ duration: v, ...(p.kind === 'ramp' ? { stages: undefined } : {}) })} />
          </Field>
        )}
        {p.kind === 'constant_rate' && (
          <Field label={t('Rate (flows / s)')} hint={t('User flows started per second')}>
            <NumberInput min={0.01} step={0.5} value={p.rate} onChange={(v) => set({ rate: v })} />
          </Field>
        )}
        {p.kind === 'breakpoint' && (
          <>
            <Field label={t('Start rate (flows/s)')}>
              <NumberInput min={0} value={p.startRate} onChange={(v) => set({ startRate: v })} />
            </Field>
            <Field label={t('Max rate (flows/s)')}>
              <NumberInput min={1} value={p.maxRate} onChange={(v) => set({ maxRate: v })} />
            </Field>
          </>
        )}
        {(p.kind === 'constant_rate' || p.kind === 'breakpoint') && (
          <Field label={t('Max VUs')} hint={t('More VUs are needed as the system slows down')}>
            <NumberInput min={1} value={p.maxVUs} onChange={(v) => set({ maxVUs: v })} placeholder={t('auto')} />
          </Field>
        )}
      </div>

      {usesStages && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-2">{p.stages?.length ? t('Stages') : t('Stages (default — customize to edit)')}</span>
            {!p.stages?.length ? (
              <Button size="sm" onClick={() => set({ stages: defaultStages(p.kind, p.vus ?? 50, p.duration ?? 300) })}>
                {t('Customize')}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => set({ stages: undefined })}>
                {t('Reset to default')}
              </Button>
            )}
          </div>
          {!!p.stages?.length && (
            <div className="space-y-1.5">
              {p.stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-xs text-ink-3">{i + 1}.</span>
                  <NumberInput className="w-28" value={s.duration} onChange={(v) => set({ stages: p.stages!.map((x, j) => (j === i ? { ...x, duration: v ?? 1 } : x)) })} />
                  <span className="text-xs text-ink-3">{t('s to')}</span>
                  <NumberInput className="w-28" value={s.target} onChange={(v) => set({ stages: p.stages!.map((x, j) => (j === i ? { ...x, target: v ?? 0 } : x)) })} />
                  <span className="text-xs text-ink-3">{t('users')}</span>
                  <Button size="sm" variant="ghost" onClick={() => set({ stages: p.stages!.filter((_, j) => j !== i) })} aria-label={t('Delete')}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ stages: [...p.stages!, { duration: 60, target: p.stages!.at(-1)?.target ?? 10 }] })}>
                {t('Add stage')}
              </Button>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="mb-1 flex justify-between text-xs text-ink-3">
          <span>{t('Load shape ({unit})', { unit: t(shape.unit) })}</span>
          <span>{t('total ≈ {d}', { d: fmtDuration(shape.total) })}</span>
        </div>
        <StagePreview points={shape.points} unit={t(shape.unit)} />
      </div>
    </div>
  );
}
