import { useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { Me } from '../App';
import { api, errorText } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { t } from '../lib/i18n';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, useLoad, useToast } from '../components/ui';
import { AccountSecurity, UsersCard } from '../components/Security';

function CodeBlock({ code }: { code: string }) {
  const toast = useToast();
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-md bg-bg p-3 pr-10 font-mono text-xs text-ink-2">{code}</pre>
      <button
        className="absolute top-2 right-2 rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
        aria-label={t('Copy')}
        onClick={() => {
          navigator.clipboard.writeText(code);
          toast(t('Copied'));
        }}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

export default function SettingsPage({ me, onChange }: { me: Me; onChange: () => void }) {
  const toast = useToast();
  const tokens = useLoad(() => api.get<any[]>('/api/tokens'));
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const mcpUrl = `${me.publicUrl}/mcp`;
  const tok = created ?? '<API_KEY>';

  const create = async () => {
    try {
      const r = await api.post('/api/tokens', { name: name || 'MCP' });
      setCreated(r.token);
      setName('');
      tokens.reload();
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <>
      <PageHeader title={t('Settings & MCP')} subtitle={t('Account security, dashboard users and the Claude (MCP) connection')} />
      <div className="grid gap-4 xl:grid-cols-2">
        <AccountSecurity me={me} onChange={onChange} />
        <UsersCard me={me} />
        <Card title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4 text-accent" /> {t('API keys')}</span>}>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Key name (e.g. Claude Desktop)')} />
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>
                {t('Create')}
              </Button>
            </div>
            {created && (
              <Alert tone="good" title={t('Key created — it is shown only once')}>
                <code className="break-all">{created}</code>
              </Alert>
            )}
            <ul className="divide-y divide-line/60 rounded-md border border-line">
              {(tokens.data ?? []).map((tk) => (
                <li key={tk.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="font-medium">{tk.name}</span>
                  <code className="text-xs text-ink-3">{tk.prefix}…</code>
                  <span className="ml-auto text-xs text-ink-3">{tk.lastUsedAt ? t('last used {ago}', { ago: fmtAgo(tk.lastUsedAt) }) : t('never used')}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('Delete')}
                    onClick={async () => {
                      if (!confirm(t('Revoke this key?'))) return;
                      await api.del(`/api/tokens/${tk.id}`);
                      tokens.reload();
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
              {!tokens.data?.length && <li className="px-3 py-3 text-sm text-ink-3">{t('No keys yet.')}</li>}
            </ul>
          </div>
        </Card>

        <Card title={t('MCP connection')}>
          <div className="space-y-4 text-sm">
            <Field label={t('Server URL (Streamable HTTP)')}>
              <CodeBlock code={mcpUrl} />
            </Field>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-2">Claude Code</div>
              <CodeBlock code={`claude mcp add --transport http loadlab ${mcpUrl} --header "Authorization: Bearer ${tok}"`} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-2">{t('Claude Desktop / other clients (JSON)')}</div>
              <CodeBlock
                code={JSON.stringify({ mcpServers: { loadlab: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2)}
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-3">
              {t('Starting tests over MCP:')}
              {me.mcpAllowRun ? <Badge tone="warn">{t('on (MCP_ALLOW_RUN=true)')}</Badge> : <Badge tone="good">{t('off — drafts are started from the dashboard')}</Badge>}
            </div>
          </div>
        </Card>

        <Card title={t('Example prompts')} className="xl:col-span-2">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
            <li>{t('“Inspect my shop’s home page and draft a workflow that opens a random product, where 30% sign in and 10% add to cart; verify it with a debug run.”')}</li>
            <li>{t('“Create a shared ‘Sign in’ module that uses the email/password from the data.users dataset.”')}</li>
            <li>{t('“Draft a breakpoint test with these workflows in a 70/30 mix, stopping at p95 1 s or 2% errors.”')}</li>
            <li>{t('“Compare the last two stress tests; which step got slower?”')}</li>
            <li>{t('“How much disk and memory is the LoadLab server using?”')}</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
