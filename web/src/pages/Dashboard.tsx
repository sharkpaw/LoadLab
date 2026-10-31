import { Link } from 'react-router-dom';
import { Activity, Bot, ClipboardList, Cpu, FileClock, Globe, Workflow } from 'lucide-react';
import { api } from '../lib/api';
import { sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtAgo, fmtBytes } from '../lib/format';
import { Badge, Card, Empty, Loading, PageHeader, Stat, useLoad } from '../components/ui';
import { RunTable } from '../components/RunTable';

export default function DashboardPage() {
  const { data, loading, reload } = useLoad(() => api.get('/api/overview'), [], 4000);
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const c = data.counts;
  return (
    <>
      <PageHeader title={t('Overview')} subtitle={t('Running tests, drafts awaiting review and latest results')} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label={t('Sites')} value={c.sites} />
        <Stat label={t('Active workflows')} value={c.workflows_active} sub={t('drafts: {n}', { n: c.workflows_draft })} />
        <Stat label={t('Test plans')} value={c.plans} sub={t('drafts: {n}', { n: c.plans_draft })} />
        <Stat label={t('Running tests')} value={c.runs_active} tone={c.runs_active ? 'good' : undefined} />
        <Stat label={t('Runs (last 7 days)')} value={c.runs_7d} sub={t('{n} total', { n: c.runs })} />
        <Stat label={t('Workers')} value={data.workers.filter((w: any) => w.online).length} sub={data.workers.length ? t('online') : t('no workers!')} tone={data.workers.some((w: any) => w.online) ? undefined : 'bad'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Card title={<span className="inline-flex items-center gap-2"><Activity className="size-4 text-accent" /> {t('Running / queued tests')}</span>} pad={false}>
            {data.active.length ? <RunTable runs={data.active} onChange={reload} compact /> : <Empty title={t('No tests are running')}>{t('Open a test plan and press “Start”.')}</Empty>}
          </Card>
          <Card title={t('Latest runs')} actions={<Link to="/runs" className="text-xs text-ink-3 hover:text-ink">{t('All →')}</Link>} pad={false}>
            {data.recent.length ? <RunTable runs={data.recent} onChange={reload} compact /> : <Empty icon={<FileClock className="size-6" />} title={t('No runs yet')} />}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title={<span className="inline-flex items-center gap-2"><Bot className="size-4 text-accent" /> {t('Drafts awaiting review')}</span>} pad={false}>
            {data.drafts.length ? (
              <ul className="divide-y divide-line/60">
                {data.drafts.map((d: any) => (
                  <li key={d.type + d.id}>
                    <Link to={d.type === 'plan' ? `/plans/${d.id}` : `/workflows/${d.id}`} className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-2">
                      {d.type === 'plan' ? <ClipboardList className="size-4 text-ink-3" /> : <Workflow className="size-4 text-ink-3" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{d.name}</div>
                        <div className="text-xs text-ink-3">{d.type === 'plan' ? t('Test plan') : t('Workflow')} · {fmtAgo(d.updatedAt)}</div>
                      </div>
                      <Badge tone={d.source === 'mcp' ? 'accent' : 'neutral'}>{sourceLabel(d.source)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={t('No drafts')}>{t('Workflow and test drafts created over MCP wait here for your review.')}</Empty>
            )}
          </Card>

          <Card title={<span className="inline-flex items-center gap-2"><Cpu className="size-4 text-accent" /> {t('Load generators')}</span>} actions={<Link to="/system" className="text-xs text-ink-3 hover:text-ink">{t('Details →')}</Link>}>
            {data.workers.length ? (
              <ul className="space-y-2.5">
                {data.workers.map((w: any) => (
                  <li key={w.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${w.online ? 'bg-good' : 'bg-bad'}`} aria-hidden />
                      <span className="truncate font-mono text-xs">{w.hostname}</span>
                      <span className="ml-auto text-xs text-ink-3">{w.activeRun ? t('busy') : w.online ? t('idle') : t('offline')}</span>
                    </div>
                    <div className="tabular mt-0.5 pl-4 text-xs text-ink-3">
                      {t('CPU {v}%', { v: Math.round(w.container?.cpuPct ?? w.processCpuPct ?? 0) })} · RAM {fmtBytes(w.container?.memoryBytes ?? w.processRss)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={<Globe className="size-6" />} title={t('No worker running')}>{t('Start the worker service with docker compose.')}</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
