import { Link, useNavigate } from 'react-router-dom';
import { Activity, CalendarClock, ClipboardList, Play, Plus } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { profileLabel, sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtAgo, fmtMs, fmtPct } from '../lib/format';
import { Badge, Button, Card, cx, Empty, Loading, PageHeader, StatusBadge, useLoad, useToast } from '../components/ui';
import { useConfirmStart } from '../components/StartConfirm';

const isActive = (p: any) => p.lastRun?.status === 'queued' || p.lastRun?.status === 'running';

export default function PlansPage() {
  const nav = useNavigate();
  const toast = useToast();
  // polls so a test started elsewhere (or finishing) moves in and out of the "running" group
  const { data, loading } = useLoad(() => api.get<any[]>('/api/plans'), [], 5000);
  const confirmStart = useConfirmStart();
  // running and queued tests first, so they are visible without scrolling
  const plans = data ? [...data.filter(isActive), ...data.filter((p) => !isActive(p))] : data;

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

  return (
    <>
      <PageHeader
        title={t('Test plans')}
        subtitle={t('Site + workflow mix + load profile. Save it, start it with one click.')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/plans/new')}>
            {t('New plan')}
          </Button>
        }
      />
      <Card pad={false}>
        {loading && !data ? (
          <Loading />
        ) : !plans?.length ? (
          <Empty icon={<ClipboardList className="size-7" />} title={t('No plans')}>
            {t('Create a plan or have one drafted over MCP.')}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-4 py-2 font-medium">{t('Plan')}</th>
                  <th className="px-4 py-2 font-medium">{t('Site')}</th>
                  <th className="px-4 py-2 font-medium">{t('Profile')}</th>
                  <th className="px-4 py-2 font-medium">{t('Last run')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} className={cx('cursor-pointer border-b border-line/60 hover:bg-surface-2', isActive(p) && 'bg-accent/5')} onClick={() => nav(`/plans/${p.id}`)}>
                    <td className="w-full max-w-0 min-w-[12rem] px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link to={`/plans/${p.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {p.name}
                        </Link>
                        <StatusBadge status={p.status} />
                        {p.source !== 'panel' && <Badge tone="accent">{sourceLabel(p.source)}</Badge>}
                        {p.schedule && (
                          <Badge>
                            <CalendarClock className="size-3" /> {p.schedule}
                          </Badge>
                        )}
                      </div>
                      {p.notes && <div className="truncate text-xs text-ink-3" title={p.notes}>{p.notes}</div>}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">{p.siteName}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">
                      {profileLabel(p.config.profile.kind)}
                      <span className="ml-1 text-xs text-ink-3">· {t('{n} flows', { n: p.config.flows.length })}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      {p.lastRun && isActive(p) ? (
                        <div className="flex items-center gap-2">
                          <StatusBadge status={p.lastRun.status} />
                          <span className="text-ink-3">{t('started {ago}', { ago: fmtAgo(p.lastRun.createdAt) })}</span>
                        </div>
                      ) : p.lastRun ? (
                        <div className="flex items-center gap-2">
                          <StatusBadge status={p.lastRun.status} />
                          <span className="tabular text-ink-2">p95 {fmtMs(p.lastRun.p95)}</span>
                          <span className="tabular text-ink-3">{t('errors {v}', { v: fmtPct(p.lastRun.errorRate) })}</span>
                          <span className="text-ink-3">{fmtAgo(p.lastRun.createdAt)}</span>
                        </div>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      {isActive(p) ? (
                        <Button size="sm" icon={<Activity className="size-3" />} onClick={() => nav(`/runs/${p.lastRun.id}`)}>
                          {t('Watch live')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" icon={<Play className="size-3" />} onClick={() => start(p)}>
                          {t('Start')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
