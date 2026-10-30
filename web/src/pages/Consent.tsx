import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Check, ShieldCheck, X } from 'lucide-react';
import { authClient, authError } from '../lib/auth';
import { msg, t } from '../lib/i18n';
import { Alert, Button, Loading } from '../components/ui';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { Logo } from '../components/Logo';

interface PublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}

const SCOPE_TEXT: Record<string, string> = {
  openid: msg('Confirm your identity'),
  profile: msg('See your name'),
  email: msg('See your e-mail address'),
  offline_access: msg('Stay connected without asking again (refresh token)'),
};

/**
 * OAuth consent for MCP clients: an AI agent asks to use LoadLab's MCP tools on the user's behalf.
 * The signed authorization request is in the query; the client plugin sends it with the consent call.
 */
export default function ConsentPage({ signedIn }: { signedIn: boolean }) {
  const qs = new URLSearchParams(window.location.search);
  const clientId = qs.get('client_id') ?? '';
  const scopes = (qs.get('scope') ?? '').split(' ').filter(Boolean);
  const [client, setClient] = useState<PublicClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'accept' | 'deny' | null>(null);

  useEffect(() => {
    if (!clientId) return setLoading(false);
    fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setClient)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [clientId]);

  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'deny');
    setError(null);
    const { data, error } = await authClient.oauth2.consent({ accept });
    setBusy(null);
    if (error) return setError(authError(error));
    const url = (data as { url?: string } | null)?.url;
    if (url) window.location.href = url;
  };

  const name = client?.client_name || clientId || t('An application');

  return (
    <div className="relative flex min-h-dvh items-center justify-center p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-accent/10 to-transparent" aria-hidden />
      <div className="absolute top-5 right-6">
        <LanguageSwitch />
      </div>
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-12" />
          <span className="text-2xl font-semibold tracking-tight">LoadLab</span>
        </div>

        {loading ? (
          <Loading />
        ) : !clientId ? (
          <Alert tone="bad">{t('This authorization request is incomplete. Start the connection again from your AI client.')}</Alert>
        ) : !signedIn ? (
          <div className="space-y-4">
            <Alert tone="warn">{t('Your session expired. Sign in and start the connection again from your AI client.')}</Alert>
            <Link to="/login" className="block text-center text-xs text-ink-3 hover:text-ink">
              {t('← Back to sign in')}
            </Link>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-surface p-6">
            <div className="flex items-center gap-3">
              <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-surface-2">
                {client?.logo_uri ? <img src={client.logo_uri} alt="" className="size-full object-cover" /> : <Bot className="size-5 text-accent" />}
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">{t('{name} wants to connect', { name })}</h1>
                {client?.client_uri && <div className="truncate text-xs text-ink-3">{client.client_uri}</div>}
              </div>
            </div>

            <p className="mt-4 text-sm text-ink-2">{t('This AI agent will be able to use LoadLab over MCP as you: inspect sites, create workflow and test plan drafts, run debug runs and read results.')}</p>

            <ul className="mt-4 space-y-2 text-sm">
              {scopes.map((s) => (
                <li key={s} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-good" />
                  <span className="text-ink-2">{SCOPE_TEXT[s] ? t(SCOPE_TEXT[s]) : s}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex gap-2 rounded-md border border-line bg-bg/50 px-3 py-2 text-xs text-ink-3">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              {t('Only allow clients you started yourself just now. If you did not start this connection, deny it.')}
            </div>

            {error && (
              <div className="mt-4">
                <Alert tone="bad">{error}</Alert>
              </div>
            )}

            <div className="mt-6 grid grid-cols-2 gap-2">
              <Button className="h-10" icon={<X className="size-4" />} loading={busy === 'deny'} disabled={!!busy} onClick={() => decide(false)}>
                {t('Deny')}
              </Button>
              <Button variant="primary" className="h-10" icon={<Check className="size-4" />} loading={busy === 'accept'} disabled={!!busy} onClick={() => decide(true)}>
                {t('Allow')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
