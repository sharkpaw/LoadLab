import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, CalendarClock, ClipboardList, LayoutGrid, List, Play, Plus } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { profileLabel, sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtAgo, fmtMs, fmtPct } from '../lib/format';
import { Badge, Button, Card, cx, Empty, Loading, PageHeader, StatusBadge, StatusIcon, useLoad, useToast } from '../components/ui';
import { useConfirmStart } from '../components/StartConfirm';

type View = 'list' | 'grid';
const VIEW_KEY = 'loadlab.plansView';

const isActive = (p: any) => p.lastRun?.status === 'queued' || p.lastRun?.status === 'running';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export default function PlansPage() {
  const nav = useNavigate();
  const toast = useToast();
  // polls so a test started elsewhere (or finishing) moves in and out of the "running" group
  const { data, loading } = useLoad(() => api.get<any[]>('/api/plans'), [], 5000);
  const confirmStart = useConfirmStart();
  const [view, setView] = useState<View>(savedView);
  // running and queued tests first, so they are visible without scrolling
  const plans = data ? [...data.filter(isActive), ...data.filter((p) => !isActive(p))] : data;

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };

  const start = async (p: any) => {
    if (!(await confirmStart(p.name, `${p.siteName} · ${profileLabel(p.config.profile.kind)}`))) return;
    const id = p.id;
    try {
      const r = await api.post(`/api/plans/${id}/start`);
      nav(`/runs/${r.id}`);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  const action = (p: any) =>
    isActive(p) ? (
      <Button size="sm" icon={<Activity className="size-3" />} onClick={() => nav(`/runs/${p.lastRun.id}`)}>
        {t('Watch live')}
      </Button>
    ) : (
      <Button size="sm" variant="primary" icon={<Play className="size-3" />} onClick={() => start(p)}>
        {t('Start')}
      </Button>
    );

  return (
    <>
      <PageHeader
        title={t('Test plans')}
        subtitle={t('Site + workflow mix + load profile. Save it, start it with one click.')}
        actions={
          <>
            <ViewSwitch value={view} onChange={changeView} />
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/plans/new')}>
              {t('New plan')}
            </Button>
          </>
        }
      />
      {loading && !data ? (
        <Card>
          <Loading />
        </Card>
      ) : !plans?.length ? (
        <Card>
          <Empty icon={<ClipboardList className="size-7" />} title={t('No plans')}>
            {t('Create a plan or have one drafted over MCP.')}
          </Empty>
        </Card>
      ) : view === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.id}
              className={cx('flex cursor-pointer flex-col rounded-lg border bg-surface p-4 hover:bg-surface-2', isActive(p) ? 'border-accent/50' : 'border-line')}
              onClick={() => nav(`/plans/${p.id}`)}
            >
              <PlanName p={p} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <PlanBadges p={p} />
                <span className="text-xs text-ink-3">{planMeta(p)}</span>
              </div>
              {p.notes && <div className="mt-2 line-clamp-2 text-xs break-words text-ink-3">{p.notes}</div>}
              <div className="mt-auto pt-3">
                {p.lastRun && !isActive(p) ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Tile label="p95" value={fmtMs(p.lastRun.p95)} />
                    <Tile label={t('Error rate')} value={fmtPct(p.lastRun.errorRate)} />
                    <Tile label={t('Last run')} value={fmtAgo(p.lastRun.createdAt)} />
                  </div>
                ) : null}
                <div className="mt-3 flex items-center justify-between gap-2" onClick={(e) => e.stopPropagation()}>
                  {p.lastRun ? (
                    <div className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
                      <StatusBadge status={p.lastRun.status} />
                      {isActive(p) && <span className="truncate">{t('started {ago}', { ago: fmtAgo(p.lastRun.createdAt) })}</span>}
                    </div>
                  ) : (
                    <span className="text-xs text-ink-3">{t('No runs yet')}</span>
                  )}
                  {action(p)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card pad={false}>
          <div className="divide-y divide-line/60">
            {plans.map((p) => (
              <div
                key={p.id}
                className={cx(
                  'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_13rem_auto]',
                  isActive(p) && 'bg-accent/5',
                )}
                onClick={() => nav(`/plans/${p.id}`)}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <PlanName p={p} truncate />
                    <PlanBadges p={p} />
                  </div>
                  <div className="truncate text-xs text-ink-3">{planMeta(p)}</div>
                </div>
                <div className="order-last col-span-2 text-xs sm:order-none sm:col-span-1 sm:text-right">
                  {p.lastRun && isActive(p) ? (
                    <div className="flex items-center gap-2 sm:justify-end">
                      <StatusBadge status={p.lastRun.status} />
                      <span className="text-ink-3">{t('started {ago}', { ago: fmtAgo(p.lastRun.createdAt) })}</span>
                    </div>
                  ) : p.lastRun ? (
                    <>
                      <div className="flex items-center gap-1.5 text-sm text-ink sm:justify-end">
                        <StatusIcon status={p.lastRun.status} />
                        <span className="tabular">p95 {fmtMs(p.lastRun.p95)}</span>
                      </div>
                      <div className="tabular text-ink-3">
                        {t('errors {v}', { v: fmtPct(p.lastRun.errorRate) })} · {fmtAgo(p.lastRun.createdAt)}
                      </div>
                    </>
                  ) : (
                    <span className="text-ink-3">{t('No runs yet')}</span>
                  )}
                </div>
                <div className="text-right" onClick={(e) => e.stopPropagation()}>
                  {action(p)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

const planMeta = (p: any) => `${p.siteName} · ${profileLabel(p.config.profile.kind)} · ${t('{n} flows', { n: p.config.flows.length })}`;

function PlanName({ p, truncate }: { p: any; truncate?: boolean }) {
  return (
    <Link
      to={`/plans/${p.id}`}
      className={cx('font-medium text-ink hover:underline', truncate && 'truncate')}
      title={p.notes ? `${p.name}\n\n${p.notes}` : p.name}
      onClick={(e) => e.stopPropagation()}
    >
      {p.name}
    </Link>
  );
}

function PlanBadges({ p }: { p: any }) {
  return (
    <>
      <StatusBadge status={p.status} />
      {p.source !== 'panel' && <Badge tone="accent">{sourceLabel(p.source)}</Badge>}
      {p.schedule && (
        <Badge>
          <CalendarClock className="size-3" /> {p.schedule}
        </Badge>
      )}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-2 px-2.5 py-1.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="tabular truncate text-sm text-ink">{value}</div>
    </div>
  );
}

function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const opts = [
    { v: 'list' as const, icon: <List className="size-4" />, label: t('List view') },
    { v: 'grid' as const, icon: <LayoutGrid className="size-4" />, label: t('Grid view') },
  ];
  return (
    <div className="inline-flex h-9 rounded-md border border-line-strong bg-surface-2 p-0.5" role="group">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          title={o.label}
          aria-label={o.label}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx('inline-flex w-8 items-center justify-center rounded transition-colors', value === o.v ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink')}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
