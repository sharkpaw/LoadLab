import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Globe, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { t } from '../lib/i18n';
import { Button, Empty, Loading, Modal, PageHeader, useLoad } from '../components/ui';
import { SiteForm, type Site } from '../components/SiteForm';

export default function SitesPage() {
  const nav = useNavigate();
  const { data, loading } = useLoad(() => api.get<Site[]>('/api/sites'));
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Sites & benchmark')}
        subtitle={t('Sites under test. Click a site to see its performance history.')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            {t('Add site')}
          </Button>
        }
      />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="rounded-lg border border-line bg-surface">
          <Empty icon={<Globe className="size-7" />} title={t('No sites yet')}>
            {t('Add your own site. Tests can only send requests to the hosts of the sites you add.')}
          </Empty>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((s) => (
            <Link key={s.id} to={`/sites/${s.id}`} className="rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-accent" />
                <div className="truncate font-medium">{s.name}</div>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-ink-3">{s.baseUrl}</div>
              <div className="mt-3 flex gap-4 text-xs text-ink-2">
                <span>{t('{n} workflows', { n: s.workflowCount ?? 0 })}</span>
                <span>{t('{n} runs', { n: s.runCount ?? 0 })}</span>
                <span className="ml-auto text-ink-3">{s.lastRunAt ? t('last test {ago}', { ago: fmtAgo(s.lastRunAt) }) : t('no tests')}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('New site')}>
        <SiteForm compact onSaved={(s) => nav(`/sites/${s.id}`)} />
      </Modal>
    </>
  );
}
