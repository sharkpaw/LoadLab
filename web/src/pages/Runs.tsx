import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, GitCompare } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Card, Empty, Loading, PageHeader, Select, useLoad } from '../components/ui';
import { RunTable } from '../components/RunTable';
import type { Site } from '../components/SiteForm';

export default function RunsPage() {
  const nav = useNavigate();
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const sites = useLoad(() => api.get<Site[]>('/api/sites'));
  const { data, loading, reload } = useLoad(() => api.get<any[]>(`/api/runs?${new URLSearchParams({ ...(siteId && { siteId }), ...(status && { status }), limit: '200' })}`), [siteId, status], 5000);
  return (
    <>
      <PageHeader
        title={t('Runs')}
        subtitle={t('All test runs. Watch and stop running tests from here.')}
        actions={
          <Button icon={<GitCompare className="size-4" />} disabled={sel.length !== 2} onClick={() => nav(`/compare?a=${sel[0]}&b=${sel[1]}`)}>
            {t('Compare 2 selected runs')}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-60" value={siteId} onChange={(e) => setSiteId(e.target.value)} options={[{ value: '', label: t('All sites') }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        <Select
          className="w-48"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: '', label: t('All statuses') },
            { value: 'active', label: t('Running / queued') },
            { value: 'completed', label: t('Completed') },
            { value: 'stopped', label: t('Stopped') },
            { value: 'failed', label: t('Failed') },
          ]}
        />
      </div>
      <Card pad={false}>
        {loading && !data ? (
          <Loading />
        ) : data?.length ? (
          <RunTable runs={data} onChange={reload} selectable selected={sel} onSelect={(id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]))} />
        ) : (
          <Empty icon={<Activity className="size-7" />} title={t('No runs found')} />
        )}
      </Card>
    </>
  );
}
