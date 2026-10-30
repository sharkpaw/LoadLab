import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { t } from '../lib/i18n';
import { Alert, Button, Field, Input, KeyValueEditor, Textarea, useToast } from './ui';

export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  description: string;
  allowedHosts: string[];
  headers: Record<string, string>;
  variables: Record<string, string>;
  datasets: Record<string, Record<string, unknown>[]>;
  workflowCount?: number;
  runCount?: number;
  lastRunAt?: string | null;
}

export function SiteForm({ site, onSaved, compact }: { site?: Site; onSaved: (s: Site) => void; compact?: boolean }) {
  const toast = useToast();
  const [name, setName] = useState(site?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(site?.baseUrl ?? 'https://');
  const [description, setDescription] = useState(site?.description ?? '');
  const [hosts, setHosts] = useState((site?.allowedHosts ?? []).join(', '));
  const [headers, setHeaders] = useState(site?.headers ?? {});
  const [variables, setVariables] = useState(site?.variables ?? {});
  const [datasets, setDatasets] = useState(JSON.stringify(site?.datasets ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    let ds: unknown;
    try {
      ds = datasets.trim() ? JSON.parse(datasets) : {};
    } catch {
      setError(t('Datasets are not valid JSON'));
      return;
    }
    const body = {
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      description,
      allowedHosts: hosts.split(/[,\s]+/).map((h) => h.trim()).filter(Boolean),
      headers,
      variables,
      datasets: ds,
    };
    setBusy(true);
    try {
      const s = site ? await api.put<Site>(`/api/sites/${site.id}`, body) : await api.post<Site>('/api/sites', body);
      toast(t('Site saved'), 'good');
      onSaved(s);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Shop (prod)')} />
        </Field>
        <Field label={t('Base URL')} hint={t('Workflow paths like “/path” are appended to this')}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com" />
        </Field>
      </div>
      <Field label={t('Extra allowed hosts')} hint={t('Tests can only send requests to the base URL host and this list. E.g. api.example.com, *.cdn.example.com')}>
        <Input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="api.example.com, cdn.example.com" />
      </Field>
      {!compact && (
        <>
          <Field label={t('Description')}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('Default headers')} hint={t('Added to every request (templates allowed)')}>
              <KeyValueEditor value={headers} onChange={setHeaders} keyPlaceholder="Header" />
            </Field>
            <Field label={t('Site variables')} hint={t('Use as {{name}} in workflows (e.g. test account details)')}>
              <KeyValueEditor value={variables} onChange={setVariables} keyPlaceholder={t('name')} />
            </Field>
          </div>
          <Field
            label={t('Datasets (JSON)')}
            hint={t('Each virtual user gets a different row. E.g. {"users":[{"email":"a@x.com","password":"..."}]} → {{data.users.email}}')}
          >
            <Textarea rows={6} value={datasets} onChange={(e) => setDatasets(e.target.value)} />
          </Field>
        </>
      )}
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} onClick={save}>
          {site ? t('Save') : t('Add site')}
        </Button>
      </div>
    </div>
  );
}
