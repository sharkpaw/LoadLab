import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { t } from './i18n';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  // oauthProviderClient adds the signed OAuth query to sign-in/consent requests so MCP authorization continues
  plugins: [twoFactorClient(), oauthProviderClient()],
});

/** Readable message from a Better Auth error object. */
export function authError(err: { message?: string; status?: number; statusText?: string } | null | undefined): string {
  if (!err) return t('Unknown error');
  if (err.status === 429) return t('Too many attempts. Try again in a minute.');
  const map: Record<string, string> = {
    'Invalid email or password': t('Invalid email or password'),
    'Invalid code': t('Invalid code'),
    'Invalid password': t('Invalid password'),
    'Password too short': t('Password too short (at least 10 characters)'),
  };
  return map[err.message ?? ''] ?? err.message ?? err.statusText ?? t('Error');
}

/** After sign-in during an MCP OAuth flow the server answers with the URL to continue to. */
export function continueOAuth(data: unknown): boolean {
  const url = (data as { url?: string; redirect?: boolean } | null)?.url;
  if (url && new URLSearchParams(window.location.search).has('client_id')) {
    window.location.href = url;
    return true;
  }
  return false;
}
