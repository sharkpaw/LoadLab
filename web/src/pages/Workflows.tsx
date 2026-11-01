import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileUp, Plus, Puzzle, Workflow } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtAgo } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Toggle, useLoad, useToast } from '../components/ui';
import type { Site } from '../components/SiteForm';

function countSteps(steps: any[] = []): number {
  return steps.reduce((a, s) => a + (s.type === 'request' || s.type === 'page' ? 1 : 0) + (s.type === 'group' ? countSteps(s.steps) : 0), 0);
}

export default function WorkflowsPage() {
  const nav = useNavigate();
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('');
  const sites = useLoad(() => api.get<Site[]>('/api/sites'));
  const { data, loading } = useLoad(() => api.get<any[]>(`/api/workflows?${new URLSearchParams({ ...(siteId && { siteId }), ...(status && { status }) })}`), [siteId, status]);
  const [harOpen, setHarOpen] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Workflows')}
        subtitle={t('User journeys: visit → open product → sign in → buy. Shared modules are reused across sites.')}
        actions={
          <>
            <Button icon={<FileUp className="size-4" />} onClick={() => setHarOpen(true)}>
              {t('Import HAR')}
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav(`/workflows/new${siteId ? `?siteId=${siteId}` : ''}`)}>
              {t('New workflow')}
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-60" value={siteId} onChange={(e) => setSiteId(e.target.value)} options={[{ value: '', label: t('All sites') }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        <Select
          className="w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: '', label: t('All statuses') },
            { value: 'draft', label: t('Draft') },
            { value: 'active', label: t('Active') },
            { value: 'archived', label: t('Archived') },
          ]}
        />
      </div>
      <Card pad={false}>
        {loading && !data ? (
          <Loading />
        ) : !data?.length ? (
          <Empty icon={<Workflow className="size-7" />} title={t('No workflows')}>
            {t('Start from a template, import a HAR file, or ask an AI agent over MCP to “draft a checkout flow for my site”.')}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-4 py-2 font-medium">{t('Name')}</th>
                  <th className="px-4 py-2 font-medium">{t('Site')}</th>
                  <th className="px-4 py-2 font-medium">{t('Status')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('Requests')}</th>
                  <th className="px-4 py-2 font-medium">{t('Version')}</th>
                  <th className="px-4 py-2 font-medium">{t('Updated')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((w) => (
                  <tr key={w.id} className="cursor-pointer border-b border-line/60 hover:bg-surface-2" onClick={() => nav(`/workflows/${w.id}`)}>
                    <td className="px-4 py-2.5">
                      <Link to={`/workflows/${w.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {w.name}
                      </Link>
                      {w.description && <div className="line-clamp-2 text-xs break-words text-ink-3" title={w.description}>{w.description}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">
                      {w.siteName ?? (
                        <span className="inline-flex items-center gap-1 text-tint-pink">
                          <Puzzle className="size-3.5" /> {t('Shared module')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-1">
                        <StatusBadge status={w.status} />
                        {w.source !== 'panel' && <Badge tone="accent">{sourceLabel(w.source)}</Badge>}
                      </div>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-ink-2">{countSteps(w.definition?.steps)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">v{w.version}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-3">{fmtAgo(w.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <HarImport open={harOpen} onClose={() => setHarOpen(false)} sites={sites.data ?? []} />
    </>
  );
}

function HarImport({ open, onClose, sites }: { open: boolean; onClose: () => void; sites: Site[] }) {
  const nav = useNavigate();
  const toast = useToast();
  const [siteId, setSiteId] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [assets, setAssets] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file || !siteId) return;
    setBusy(true);
    setErr(null);
    try {
      const har = JSON.parse(await file.text());
      const r = await api.post('/api/workflows/import-har', { har, siteId, name: name || undefined, includeAssets: assets });
      toast(t('{used} requests imported ({skipped} skipped)', { used: r.stats.used, skipped: r.stats.skipped }), 'good');
      nav(`/workflows/${r.workflow.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Workflow from a HAR file')}
      footer={
        <Button variant="primary" loading={busy} disabled={!file || !siteId} onClick={submit}>
          {t('Import')}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-3">
          {t('In Chrome open DevTools → Network, browse the site like a real user (sign in, product, cart…), then right-click → “Save all as HAR”. Only requests to the site’s hosts are kept; pauses become think steps.')}
        </p>
        {err && <Alert tone="bad">{err}</Alert>}
        <Field label={t('Site')}>
          <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} options={[{ value: '', label: t('Select…') }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} />
        </Field>
        <Field label={t('Workflow name (optional)')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('HAR file')}>
          <input type="file" accept=".har,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-ink-2" />
        </Field>
        <Toggle checked={assets} onChange={setAssets} label={t('Also import static files (js/css/img) as separate steps')} />
      </div>
    </Modal>
  );
}
