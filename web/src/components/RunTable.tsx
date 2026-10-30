import { Link, useNavigate } from 'react-router-dom';
import { Square, Star } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { ACTIVE_STATUSES, profileLabel, sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtAgo, fmtCompact, fmtMs, fmtPct } from '../lib/format';
import { Badge, Button, PassBadge, StatusBadge, useToast } from './ui';

export interface RunBrief {
  id: string;
  name: string;
  siteName?: string;
  siteId: string;
  kind: string;
  status: string;
  trigger: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  thresholdsPassed: boolean | null;
  isBaseline: boolean;
  stopReason: string | null;
  capacity: any;
  brief?: { requests: number | null; errorRate: number | null; p95: number | null; rpsAvg: number | null; maxVus: number | null; warnings: string[] | null };
}

/** `compact` drops secondary columns (requests, avg rps, capacity) for narrow cards like the dashboard. */
export function RunTable({ runs, onChange, showSite = true, selectable, selected, onSelect, compact }: { runs: RunBrief[]; onChange?: () => void; showSite?: boolean; selectable?: boolean; selected?: string[]; onSelect?: (id: string) => void; compact?: boolean }) {
  const toast = useToast();
  const nav = useNavigate();
  const stop = async (id: string) => {
    try {
      await api.post(`/api/runs/${id}/stop`);
      toast(t('Stop requested'));
      onChange?.();
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_td.tabular]:whitespace-nowrap [&_th]:whitespace-nowrap">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            {selectable && <th className="w-8 px-3 py-2" />}
            <th className="px-3 py-2 font-medium">{t('Run')}</th>
            {showSite && <th className="px-3 py-2 font-medium">{t('Site')}</th>}
            <th className="px-3 py-2 font-medium">{t('Status')}</th>
            {!compact && <th className="px-3 py-2 text-right font-medium">{t('Requests')}</th>}
            {!compact && <th className="px-3 py-2 text-right font-medium">{t('Avg rps')}</th>}
            <th className="px-3 py-2 text-right font-medium">p95</th>
            <th className="px-3 py-2 text-right font-medium">{t('Errors')}</th>
            {!compact && <th className="px-3 py-2 text-right font-medium">{t('Capacity')}</th>}
            <th className="px-3 py-2 font-medium">{t('Time')}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const active = ACTIVE_STATUSES.includes(r.status);
            const err = r.brief?.errorRate;
            return (
              <tr key={r.id} className="cursor-pointer border-b border-line/60 hover:bg-surface-2" onClick={() => nav(`/runs/${r.id}`)}>
                {selectable && (
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected?.includes(r.id) ?? false} onChange={() => onSelect?.(r.id)} />
                  </td>
                )}
                <td className="min-w-[220px] px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {r.isBaseline && <Star className="size-3.5 fill-warn text-warn" aria-label={t('Baseline')} />}
                    <Link to={`/runs/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.name}
                    </Link>
                  </div>
                  <div className="mt-0.5 flex gap-1.5 text-xs text-ink-3">
                    <span>{profileLabel(r.kind)}</span>
                    {r.trigger !== 'panel' && <Badge>{sourceLabel(r.trigger)}</Badge>}
                  </div>
                </td>
                {showSite && <td className="px-3 py-2 whitespace-nowrap text-ink-2">{r.siteName}</td>}
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={r.status} />
                    <PassBadge passed={r.thresholdsPassed} />
                    {!!r.brief?.warnings?.length && <Badge tone="warn">{t('warning')}</Badge>}
                  </div>
                </td>
                {!compact && <td className="tabular px-3 py-2 text-right text-ink-2">{fmtCompact(r.brief?.requests)}</td>}
                {!compact && <td className="tabular px-3 py-2 text-right text-ink-2">{r.brief?.rpsAvg != null ? r.brief.rpsAvg.toFixed(1) : '—'}</td>}
                <td className="tabular px-3 py-2 text-right">{fmtMs(r.brief?.p95)}</td>
                <td className={`tabular px-3 py-2 text-right ${err && err > 0.01 ? 'text-bad' : 'text-ink-2'}`}>{fmtPct(err)}</td>
                {!compact && <td className="tabular px-3 py-2 text-right text-ink-2">{r.capacity?.maxHealthy ? `${r.capacity.maxHealthy.rps} rps` : '—'}</td>}
                <td className="px-3 py-2 text-xs whitespace-nowrap text-ink-3">{fmtAgo(r.createdAt)}</td>
                <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  {active && (
                    <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={() => stop(r.id)}>
                      {t('Stop')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
