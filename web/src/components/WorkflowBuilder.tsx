import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Clock,
  Copy,
  FileText,
  Globe2,
  Puzzle,
  Plus,
  Send,
  Trash2,
  Variable,
} from 'lucide-react';
import { msg, t } from '../lib/i18n';
import { Badge, Button, Field, Input, KeyValueEditor, NumberInput, Select, Textarea, Toggle, cx } from './ui';

// ---------------------------------------------------------------------------
// types and path helpers

export type Step = Record<string, any> & { type: string };
export type Path = number[];

export function getAt(steps: Step[], path: Path): Step | null {
  let list = steps;
  let cur: Step | null = null;
  for (const i of path) {
    cur = list[i] ?? null;
    if (!cur) return null;
    list = cur.steps ?? [];
  }
  return cur;
}

function mapList(steps: Step[], parent: Path, fn: (list: Step[]) => Step[]): Step[] {
  if (!parent.length) return fn(steps);
  const [h, ...rest] = parent;
  return steps.map((s, i) => (i === h ? { ...s, steps: mapList(s.steps ?? [], rest, fn) } : s));
}

export function updateAt(steps: Step[], path: Path, patch: Partial<Step>): Step[] {
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1];
  return mapList(steps, parent, (list) => list.map((s, i) => (i === idx ? clean({ ...s, ...patch }) : s)));
}

export function removeAt(steps: Step[], path: Path): Step[] {
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1];
  return mapList(steps, parent, (list) => list.filter((_, i) => i !== idx));
}

export function insertAt(steps: Step[], parent: Path, index: number, step: Step): Step[] {
  return mapList(steps, parent, (list) => [...list.slice(0, index), step, ...list.slice(index)]);
}

export function moveAt(steps: Step[], path: Path, dir: -1 | 1): Step[] {
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1];
  return mapList(steps, parent, (list) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    return copy;
  });
}

/** Drops undefined / empty values so the JSON stays clean. */
function clean(s: Step): Step {
  const o: Step = { type: s.type };
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0 && k !== 'steps') || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 && k !== 'content')) continue;
    o[k] = v;
  }
  return o;
}

export const NEW_STEP: Record<string, () => Step> = {
  page: () => ({ type: 'page', name: 'Page', url: '/', assets: true }),
  request: () => ({ type: 'request', name: 'Request', method: 'GET', url: '/api/' }),
  think: () => ({ type: 'think', min: 1, max: 3 }),
  set: () => ({ type: 'set', vars: { variable: '{{$randomInt 1 10}}' } }),
  group: () => ({ type: 'group', name: 'Group', probability: 0.5, steps: [] }),
  include: () => ({ type: 'include', workflowId: '' }),
};

const TYPE_META: Record<string, { label: string; icon: ReactNode; tone: string }> = {
  page: { label: msg('Page'), icon: <Globe2 className="size-3.5" />, tone: 'text-[#86b6ef]' },
  request: { label: msg('Request'), icon: <Send className="size-3.5" />, tone: 'text-[#5fc49c]' },
  think: { label: msg('Think'), icon: <Clock className="size-3.5" />, tone: 'text-ink-3' },
  set: { label: msg('Variable'), icon: <Variable className="size-3.5" />, tone: 'text-[#e3a73c]' },
  group: { label: msg('Group'), icon: <Boxes className="size-3.5" />, tone: 'text-[#b2aaf1]' },
  include: { label: msg('Module'), icon: <Puzzle className="size-3.5" />, tone: 'text-[#e381a8]' },
};

function stepTitle(s: Step, modules: Record<string, string>): string {
  switch (s.type) {
    case 'think':
      return t('think {min}–{max} s', { min: s.min, max: s.max });
    case 'set':
      return Object.keys(s.vars ?? {}).join(', ') || t('variable');
    case 'include':
      return s.name || modules[s.workflowId] || t('select a module');
    default:
      return s.name || t('(unnamed)');
  }
}

function stepSub(s: Step): string | null {
  if (s.type === 'request') return `${s.method ?? 'GET'} ${s.url}`;
  if (s.type === 'page') return `GET ${s.url}${s.assets ? ` + ${t('assets')}` : ''}`;
  if (s.type === 'group') return t('{n} steps', { n: s.steps?.length ?? 0 }) + (s.repeat ? ` · ${t('{min}–{max} times', { min: s.repeat.min, max: s.repeat.max })}` : '');
  return null;
}

// ---------------------------------------------------------------------------
// flow view

function AddMenu({ onAdd, compact }: { onAdd: (type: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx('flex items-center gap-1 rounded-md border border-dashed border-line-strong text-xs text-ink-3 hover:border-accent hover:text-ink', compact ? 'px-2 py-1' : 'w-full justify-center px-3 py-2')}
      >
        <Plus className="size-3.5" /> {t('Add step')}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-line-strong bg-surface-2 p-1 shadow-xl">
            {Object.entries(TYPE_META).map(([type, m]) => (
              <button
                key={type}
                onClick={() => {
                  onAdd(type);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-3"
              >
                <span className={m.tone}>{m.icon}</span>
                {t(m.label)}
                <span className="ml-auto text-[10px] text-ink-3">
                  {t(({ page: msg('HTML + assets'), request: msg('API call'), think: msg('user pauses'), set: msg('assignment'), group: msg('probability/repeat'), include: msg('shared flow') } as Record<string, string>)[type])}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface FlowProps {
  steps: Step[];
  parent: Path;
  selected: Path | null;
  onSelect: (p: Path) => void;
  onChange: (steps: Step[]) => void;
  root: Step[];
  modules: Record<string, string>;
  issues: Record<string, boolean>;
}

function FlowList({ steps, parent, selected, onSelect, onChange, root, modules, issues }: FlowProps) {
  const isSel = (p: Path) => selected && selected.length === p.length && selected.every((x, i) => x === p[i]);
  return (
    <div className="space-y-0">
      {steps.map((s, i) => {
        const path = [...parent, i];
        const m = TYPE_META[s.type] ?? TYPE_META.request;
        const sub = stepSub(s);
        return (
          <div key={i}>
            {i > 0 && <div className="ml-5 h-3 w-px bg-line-strong" />}
            <div
              onClick={(e) => {
                e.stopPropagation();
                onSelect(path);
              }}
              className={cx(
                'group relative cursor-pointer rounded-md border bg-surface-2 px-3 py-2 transition-colors',
                isSel(path) ? 'border-accent ring-1 ring-accent/40' : 'border-line hover:border-line-strong',
                issues[path.join('.')] && 'border-bad/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cx('grid size-6 shrink-0 place-items-center rounded bg-surface-3', m.tone)}>{m.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium">{stepTitle(s, modules)}</span>
                    {s.probability !== undefined && s.probability < 1 && <Badge tone="accent">{Math.round(s.probability * 100)}%</Badge>}
                    {(s.type === 'request' || s.type === 'page') && s.abortOnFail === false && <Badge>{t('continue on error')}</Badge>}
                    {s.extract?.length > 0 && <Badge tone="warn">→ {s.extract.map((x: any) => x.var).join(', ')}</Badge>}
                  </div>
                  {sub && <div className="truncate font-mono text-[11px] text-ink-3">{sub}</div>}
                </div>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                  <IconBtn label={t('Up')} onClick={() => onChange(moveAt(root, path, -1))}>
                    <ArrowUp className="size-3.5" />
                  </IconBtn>
                  <IconBtn label={t('Down')} onClick={() => onChange(moveAt(root, path, 1))}>
                    <ArrowDown className="size-3.5" />
                  </IconBtn>
                  <IconBtn label={t('Duplicate')} onClick={() => onChange(insertAt(root, parent, i + 1, structuredClone(s)))}>
                    <Copy className="size-3.5" />
                  </IconBtn>
                  <IconBtn label={t('Delete')} onClick={() => onChange(removeAt(root, path))}>
                    <Trash2 className="size-3.5" />
                  </IconBtn>
                </div>
              </div>
              {s.type === 'group' && (
                <div className="mt-2 border-l-2 border-[#9085e9]/40 pl-3" onClick={(e) => e.stopPropagation()}>
                  <FlowList steps={s.steps ?? []} parent={path} selected={selected} onSelect={onSelect} onChange={onChange} root={root} modules={modules} issues={issues} />
                  <div className="mt-2">
                    <AddMenu compact onAdd={(t) => {
                      onChange(insertAt(root, path, s.steps?.length ?? 0, NEW_STEP[t]()));
                      onSelect([...path, s.steps?.length ?? 0]);
                    }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IconBtn({ children, onClick, label }: { children: ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink">
      {children}
    </button>
  );
}

export function FlowView(props: { steps: Step[]; selected: Path | null; onSelect: (p: Path) => void; onChange: (s: Step[]) => void; modules: Record<string, string>; issues?: Record<string, boolean> }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs text-ink-3">
        <span className="grid size-5 place-items-center rounded-full bg-good/20 text-good">▶</span> {t('Virtual user iteration starts')}
      </div>
      <FlowList steps={props.steps} parent={[]} root={props.steps} selected={props.selected} onSelect={props.onSelect} onChange={props.onChange} modules={props.modules} issues={props.issues ?? {}} />
      <div className="ml-5 h-3 w-px bg-line-strong" />
      <AddMenu
        onAdd={(t) => {
          props.onChange(insertAt(props.steps, [], props.steps.length, NEW_STEP[t]()));
          props.onSelect([props.steps.length]);
        }}
      />
      <div className="mt-3 flex items-center gap-2 text-xs text-ink-3">
        <span className="grid size-5 place-items-center rounded-full bg-surface-3">■</span> {t('Iteration ends, a new one starts')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// step form

const CHECK_TYPES = [
  { value: 'status', label: msg('Status code') },
  { value: 'bodyContains', label: msg('Body contains') },
  { value: 'bodyNotContains', label: msg('Body does not contain') },
  { value: 'jsonPath', label: msg('JSON path') },
  { value: 'maxDuration', label: msg('Max duration') },
  { value: 'header', label: msg('Header present') },
];

function ChecksEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const set = (i: number, patch: any) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1.5">
      {value.map((c, i) => (
        <div key={i} className="flex flex-wrap gap-1.5 rounded border border-line p-1.5">
          <Select
            className="w-36"
            value={c.type}
            onChange={(e) => {
              const t = e.target.value;
              const d: any = { status: { value: 200 }, bodyContains: { value: '' }, bodyNotContains: { value: '' }, jsonPath: { path: '', exists: true }, maxDuration: { ms: 1000 }, header: { name: '' } }[t];
              set(i, { type: t, ...d, value: d.value, path: d.path, ms: d.ms, name: d.name, exists: d.exists, equals: undefined, contains: undefined });
            }}
            options={CHECK_TYPES.map((o) => ({ ...o, label: t(o.label) }))}
          />
          {c.type === 'status' && (
            <Input
              className="w-32 font-mono text-xs"
              value={Array.isArray(c.value) ? c.value.join(',') : String(c.value ?? '')}
              onChange={(e) => {
                const parts = e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
                set(i, { value: parts.length > 1 ? parts : (parts[0] ?? 200) });
              }}
              placeholder={t('200 or 200,302')}
            />
          )}
          {(c.type === 'bodyContains' || c.type === 'bodyNotContains') && <Input className="flex-1 text-xs" value={c.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} placeholder={t('text')} />}
          {c.type === 'jsonPath' && (
            <>
              <Input className="flex-1 font-mono text-xs" value={c.path ?? ''} onChange={(e) => set(i, { path: e.target.value })} placeholder="data.items[0].id" />
              <Input
                className="w-28 font-mono text-xs"
                value={c.equals === undefined ? '' : JSON.stringify(c.equals)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return set(i, { equals: undefined });
                  try {
                    set(i, { equals: JSON.parse(v) });
                  } catch {
                    set(i, { equals: v });
                  }
                }}
                placeholder={t('= (optional)')}
              />
            </>
          )}
          {c.type === 'maxDuration' && <NumberInput className="w-28" value={c.ms} onChange={(v) => set(i, { ms: v ?? 1000 })} placeholder="ms" />}
          {c.type === 'header' && (
            <>
              <Input className="w-36 text-xs" value={c.name ?? ''} onChange={(e) => set(i, { name: e.target.value })} placeholder="Header" />
              <Input className="flex-1 text-xs" value={c.contains ?? ''} onChange={(e) => set(i, { contains: e.target.value || undefined })} placeholder={t('contains (optional)')} />
            </>
          )}
          <Button variant="ghost" size="sm" className="h-auto" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('Delete')}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { type: 'status', value: 200 }])}>
        {t('Add check')}
      </Button>
    </div>
  );
}

function ExtractEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const set = (i: number, patch: any) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1.5">
      {value.map((x, i) => (
        <div key={i} className="space-y-1.5 rounded border border-line p-1.5">
          <div className="flex gap-1.5">
            <Input className="w-32 font-mono text-xs" value={x.var} onChange={(e) => set(i, { var: e.target.value })} placeholder={t('variable')} />
            <Select
              className="w-28"
              value={x.from}
              onChange={(e) => set(i, { from: e.target.value })}
              options={[
                { value: 'json', label: 'JSON' },
                { value: 'html', label: 'HTML' },
                { value: 'regex', label: 'Regex' },
                { value: 'header', label: msg('Header') },
                { value: 'cookie', label: t('Cookie') },
              ]}
            />
            <Select
              className="w-28"
              value={x.pick ?? 'first'}
              onChange={(e) => set(i, { pick: e.target.value === 'first' ? undefined : e.target.value })}
              options={[
                { value: 'first', label: t('first') },
                { value: 'random', label: t('random') },
                { value: 'all', label: t('all (list)') },
              ]}
            />
            <Button variant="ghost" size="sm" className="ml-auto h-auto" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('Delete')}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <div className="flex gap-1.5">
            {x.from === 'json' && <Input className="flex-1 font-mono text-xs" value={x.path ?? ''} onChange={(e) => set(i, { path: e.target.value })} placeholder="data.products[*].id" />}
            {x.from === 'regex' && <Input className="flex-1 font-mono text-xs" value={x.pattern ?? ''} onChange={(e) => set(i, { pattern: e.target.value })} placeholder={'name="csrf" value="([^"]+)"'} />}
            {(x.from === 'header' || x.from === 'cookie') && <Input className="flex-1 font-mono text-xs" value={x.name ?? ''} onChange={(e) => set(i, { name: e.target.value })} placeholder={t('name')} />}
            {x.from === 'html' && (
              <>
                <Input className="flex-1 font-mono text-xs" value={x.selector ?? ''} onChange={(e) => set(i, { selector: e.target.value })} placeholder="a.product-card" />
                <Input className="w-24 font-mono text-xs" value={x.attr ?? ''} onChange={(e) => set(i, { attr: e.target.value || undefined })} placeholder="href" />
              </>
            )}
            <label className="flex items-center gap-1 text-[11px] whitespace-nowrap text-ink-3">
              <input type="checkbox" checked={!!x.required} onChange={(e) => set(i, { required: e.target.checked || undefined })} /> {t('required')}
            </label>
          </div>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { var: 'value', from: 'json', path: '' }])}>
        {t('Extract variable')}
      </Button>
    </div>
  );
}

function BodyEditor({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const mode = value?.mode ?? 'none';
  const [text, setText] = useState(() => (value ? (typeof value.content === 'string' ? value.content : JSON.stringify(value.content, null, 2)) : ''));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(value ? (typeof value.content === 'string' ? value.content : JSON.stringify(value.content, null, 2)) : '');
    // reload only when the mode changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const commit = (raw: string) => {
    if (mode === 'raw') {
      setErr(null);
      return onChange({ ...value, content: raw });
    }
    try {
      onChange({ ...value, content: raw.trim() ? JSON.parse(raw) : {} });
      setErr(null);
    } catch {
      setErr(t('Not valid JSON'));
    }
  };
  return (
    <div className="space-y-1.5">
      <Select
        value={mode}
        onChange={(e) => {
          const m = e.target.value;
          if (m === 'none') onChange(undefined);
          else onChange({ mode: m, content: m === 'raw' ? '' : {} });
        }}
        options={[
          { value: 'none', label: t('No body') },
          { value: 'json', label: 'JSON' },
          { value: 'form', label: t('Form (x-www-form-urlencoded) — write as a JSON object') },
          { value: 'raw', label: t('Raw text') },
        ]}
      />
      {mode !== 'none' && (
        <>
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} placeholder={mode === 'raw' ? '' : '{ "email": "{{data.users.email}}" }'} />
          {err && <div className="text-xs text-bad">{err}</div>}
        </>
      )}
    </div>
  );
}

function CommonFields({ step, set, httpLike }: { step: Step; set: (p: Partial<Step>) => void; httpLike?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('Probability')} hint={t('1 = always, 0.3 = 30% of users')}>
        <NumberInput step={0.05} min={0} max={1} value={step.probability} onChange={(v) => set({ probability: v === undefined || v >= 1 ? undefined : Math.max(0, v) })} placeholder="1" />
      </Field>
      {httpLike !== false && (
        <div className="pt-6">
          <Toggle checked={step.abortOnFail !== false} onChange={(v) => set({ abortOnFail: v ? undefined : false })} label={t('End the iteration on failure')} />
        </div>
      )}
    </div>
  );
}

export function StepForm({ step, onChange, workflows, selfId }: { step: Step; onChange: (p: Partial<Step>) => void; workflows: { id: string; name: string; siteName?: string }[]; selfId?: string }) {
  const set = onChange;
  switch (step.type) {
    case 'request':
    case 'page':
      return (
        <div className="space-y-4">
          <Field label={t('Step name')} hint={t('Shown in reports under this name (groups dynamic URLs)')}>
            <Input value={step.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            {step.type === 'request' && (
              <Select className="w-28" value={step.method ?? 'GET'} onChange={(e) => set({ method: e.target.value })} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ value: m, label: m }))} />
            )}
            <Input className="flex-1 font-mono text-xs" value={step.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="/product/{{productId}}" />
          </div>
          {step.type === 'page' && (
            <div className="flex items-center gap-4">
              <Toggle checked={!!step.assets} onChange={(v) => set({ assets: v || undefined })} label={t('Load page assets (css/js/img)')} />
              {step.assets && (
                <Field label={t('Max')} className="w-24">
                  <NumberInput value={step.maxAssets} onChange={(v) => set({ maxAssets: v })} placeholder="20" />
                </Field>
              )}
            </div>
          )}
          <CommonFields step={step} set={set} />
          <Field label={t('Headers')}>
            <KeyValueEditor value={step.headers ?? {}} onChange={(v) => set({ headers: v })} keyPlaceholder="Header" />
          </Field>
          {step.type === 'request' && (
            <>
              <Field label={t('Query parameters')}>
                <KeyValueEditor value={step.query ?? {}} onChange={(v) => set({ query: v })} keyPlaceholder="param" />
              </Field>
              <Field label={t('Body')}>
                <BodyEditor value={step.body} onChange={(v) => set({ body: v })} />
              </Field>
            </>
          )}
          <Field label={t('Checks')} hint={t('A failed check marks the step as failed')}>
            <ChecksEditor value={step.checks ?? []} onChange={(v) => set({ checks: v })} />
          </Field>
          <Field label={t('Extract variables')} hint={t('Use as {{variable}} in later steps')}>
            <ExtractEditor value={step.extract ?? []} onChange={(v) => set({ extract: v })} />
          </Field>
          {step.type === 'request' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('Expected status codes')} hint={t('Empty means 200-399 succeed')}>
                <Input
                  className="font-mono text-xs"
                  value={(step.expectStatus ?? []).join(',')}
                  onChange={(e) => {
                    const v = e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
                    set({ expectStatus: v.length ? v : undefined });
                  }}
                  placeholder="200,201"
                />
              </Field>
              <Field label={t('Timeout (ms)')}>
                <NumberInput value={step.timeoutMs} onChange={(v) => set({ timeoutMs: v })} placeholder="30000" />
              </Field>
              <div className="col-span-2">
                <Toggle checked={step.followRedirects !== false} onChange={(v) => set({ followRedirects: v ? undefined : false })} label={t('Follow redirects')} />
              </div>
            </div>
          )}
        </div>
      );
    case 'think':
      return (
        <div className="space-y-3">
          <p className="text-sm text-ink-3">{t('Real users read and think. Without this pause each virtual user generates many times the load of a real user.')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Min (s)')}>
              <NumberInput step={0.5} value={step.min} onChange={(v) => set({ min: v ?? 0 })} />
            </Field>
            <Field label={t('Max (s)')}>
              <NumberInput step={0.5} value={step.max} onChange={(v) => set({ max: v ?? 0 })} />
            </Field>
          </div>
        </div>
      );
    case 'set':
      return (
        <Field label={t('Variables')} hint={t('Values can be templates: {{$randomInt 1 5}}, {{$randomItem products}}, {{$uuid}}')}>
          <KeyValueEditor value={step.vars ?? {}} onChange={(v) => set({ vars: v })} keyPlaceholder={t('name')} />
        </Field>
      );
    case 'group':
      return (
        <div className="space-y-4">
          <Field label={t('Group name')}>
            <Input value={step.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <CommonFields step={step} set={set} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Repeat at least')} hint={t('E.g. browse 1-4 products')}>
              <NumberInput value={step.repeat?.min} onChange={(v) => set({ repeat: v === undefined && step.repeat?.max === undefined ? undefined : { min: v ?? 1, max: Math.max(v ?? 1, step.repeat?.max ?? 1) } })} placeholder="1" />
            </Field>
            <Field label={t('Repeat at most')}>
              <NumberInput value={step.repeat?.max} onChange={(v) => set({ repeat: v === undefined ? undefined : { min: Math.min(step.repeat?.min ?? 1, v), max: v } })} placeholder="1" />
            </Field>
          </div>
        </div>
      );
    case 'include':
      return (
        <div className="space-y-4">
          <p className="text-sm text-ink-3">{t('Runs another workflow (e.g. a shared “Sign in” module) at this point. When the module changes, every flow that uses it is updated.')}</p>
          <Field label={t('Module')}>
            <Select
              value={step.workflowId ?? ''}
              onChange={(e) => set({ workflowId: e.target.value })}
              options={[{ value: '', label: t('Select…') }, ...workflows.filter((w) => w.id !== selfId).map((w) => ({ value: w.id, label: `${w.name}${w.siteName ? '' : ` (${t('shared')})`}` }))]}
            />
          </Field>
          <Field label={t('Display name (optional)')}>
            <Input value={step.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <CommonFields step={step} set={set} httpLike={false} />
        </div>
      );
    default:
      return <div className="text-sm text-ink-3">{t('Unknown step type')}</div>;
  }
}

export const TEMPLATES: { key: string; label: string; desc: string; icon: ReactNode; def: any }[] = [
  { key: 'blank', label: msg('Blank'), desc: msg('A single page visit'), icon: <FileText className="size-4" />, def: { resetSession: true, steps: [{ type: 'page', name: 'Home page', url: '/', assets: true, checks: [{ type: 'status', value: 200 }] }, { type: 'think', min: 2, max: 5 }] } },
  {
    key: 'shop',
    label: msg('E-commerce funnel'),
    desc: msg('Home → browse products → (30%) sign in → (10%) add to cart and buy'),
    icon: <Boxes className="size-4" />,
    def: {
      resetSession: true,
      steps: [
        { type: 'page', name: 'Home page', url: '/', assets: true, checks: [{ type: 'status', value: 200 }], extract: [{ var: 'productUrl', from: 'html', selector: 'a[href*="/product"]', attr: 'href', pick: 'random' }] },
        { type: 'think', min: 2, max: 5 },
        {
          type: 'group',
          name: 'Browse products',
          probability: 0.8,
          repeat: { min: 1, max: 3 },
          steps: [
            { type: 'page', name: 'Product detail', url: '{{productUrl}}', assets: true, checks: [{ type: 'status', value: 200 }] },
            { type: 'think', min: 3, max: 8 },
          ],
        },
        {
          type: 'group',
          name: 'Sign in and buy',
          probability: 0.3,
          steps: [
            { type: 'request', name: 'Sign in', method: 'POST', url: '/api/login', body: { mode: 'json', content: { email: '{{data.users.email}}', password: '{{data.users.password}}' } }, checks: [{ type: 'status', value: 200 }], extract: [{ var: 'token', from: 'json', path: 'token' }] },
            { type: 'think', min: 1, max: 3 },
            {
              type: 'group',
              name: 'Purchase',
              probability: 0.33,
              steps: [
                { type: 'request', name: 'Add to cart', method: 'POST', url: '/api/cart', headers: { Authorization: 'Bearer {{token}}' }, body: { mode: 'json', content: { productId: '{{productId}}', qty: '{{$num 1}}' } } },
                { type: 'think', min: 2, max: 4 },
                { type: 'request', name: 'Place order', method: 'POST', url: '/api/checkout', headers: { Authorization: 'Bearer {{token}}' } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'api',
    label: msg('API flow'),
    desc: msg('List → random item detail (JSON extraction)'),
    icon: <Send className="size-4" />,
    def: {
      resetSession: false,
      steps: [
        { type: 'request', name: 'List', method: 'GET', url: '/api/items', checks: [{ type: 'status', value: 200 }], extract: [{ var: 'itemId', from: 'json', path: 'items[*].id', pick: 'random', required: true }] },
        { type: 'think', min: 0.5, max: 1.5 },
        { type: 'request', name: 'Detail', method: 'GET', url: '/api/items/{{itemId}}', checks: [{ type: 'status', value: 200 }] },
      ],
    },
  },
];
