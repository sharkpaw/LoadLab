import { useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { Me } from '../App';
import { api, errorText } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { msg, t } from '../lib/i18n';
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

const CLIENTS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'json', label: msg('Other clients (JSON)') },
  { key: 'url', label: msg('URL only') },
] as const;

type Method = 'oauth' | 'key';

/** Copy-ready setup for common MCP clients, with OAuth sign-in or an API key. */
function ClientSetup({ mcpUrl, tok, oauth }: { mcpUrl: string; tok: string; oauth: boolean }) {
  const [method, setMethod] = useState<Method>(oauth ? 'oauth' : 'key');
  const [client, setClient] = useState<(typeof CLIENTS)[number]['key']>('claude');
  const header = method === 'key' ? ` --header "Authorization: Bearer ${tok}"` : '';
  const entry = method === 'key' ? { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${tok}` } } : { type: 'http', url: mcpUrl };
  const code = {
    claude: `claude mcp add --transport http loadlab ${mcpUrl}${header}`,
    gemini: `gemini mcp add --transport http loadlab ${mcpUrl}${header}`,
    json: JSON.stringify({ mcpServers: { loadlab: entry } }, null, 2),
    url: method === 'key' ? `${mcpUrl}?token=${tok}` : mcpUrl,
  }[client];
  const methods: { key: Method; label: string; hint: string }[] = [
    { key: 'oauth', label: t('Sign in with OAuth'), hint: t('Recommended. No key to copy: the client opens LoadLab in your browser, you sign in and approve it.') },
    { key: 'key', label: t('API key'), hint: t('For clients without OAuth support or for scripts. Create a key above.') },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('Authentication method')}>
        {methods.map((m) => {
          const disabled = m.key === 'oauth' && !oauth;
          return (
            <button
              key={m.key}
              role="radio"
              aria-checked={method === m.key}
              disabled={disabled}
              onClick={() => setMethod(m.key)}
              className={`rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${method === m.key ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong hover:bg-surface-2'}`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{m.hint}</div>
            </button>
          );
        })}
      </div>
      {!oauth && <p className="text-xs text-warn">{t('OAuth is off: it needs an HTTPS PUBLIC_URL (or localhost) and MCP_OAUTH=true.')}</p>}
      <div>
        <div className="mb-2 flex flex-wrap gap-1">
          {CLIENTS.map((c) => (
            <button
              key={c.key}
              onClick={() => setClient(c.key)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${client === c.key ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
            >
              {t(c.label)}
            </button>
          ))}
        </div>
        <CodeBlock code={code} />
        {client === 'json' && <p className="mt-1.5 text-xs text-ink-3">{t('For Cursor, VS Code, Windsurf and most other clients. Some use “serverUrl” or “httpUrl” instead of “url”.')}</p>}
        {client === 'url' && method === 'key' && <p className="mt-1.5 text-xs text-warn">{t('For clients that cannot send headers (e.g. ChatGPT connectors). The key is part of the URL, so keep it private.')}</p>}
        {client === 'url' && method === 'oauth' && <p className="mt-1.5 text-xs text-ink-3">{t('Paste this URL into clients that only ask for a server address (e.g. ChatGPT or Claude.ai connectors); they start the sign-in themselves.')}</p>}
      </div>
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
      <PageHeader title={t('Settings & MCP')} subtitle={t('Account security, dashboard users and the MCP connection for AI agents')} />
      <div className="grid gap-4 xl:grid-cols-2">
        <AccountSecurity me={me} onChange={onChange} />
        <UsersCard me={me} />
        <Card title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4 text-accent" /> {t('API keys')}</span>}>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Key name (e.g. Cursor, Gemini CLI)')} />
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
            <p className="text-xs text-ink-3">{t('Works with any MCP client that supports Streamable HTTP: Claude, Gemini, ChatGPT, Cursor, VS Code, Windsurf and others.')}</p>
            <ClientSetup mcpUrl={mcpUrl} tok={tok} oauth={me.mcpOAuth} />
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
