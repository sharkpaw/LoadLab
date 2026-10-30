import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { t } from './i18n';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [twoFactorClient()],
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
