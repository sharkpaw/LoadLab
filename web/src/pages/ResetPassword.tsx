import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { authClient, authError } from '../lib/auth';
import { t } from '../lib/i18n';
import { Alert, Button, PasswordInput } from '../components/ui';
import { Logo } from '../components/Logo';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { ThemeSwitch } from '../components/ThemeSwitch';

export default function ResetPasswordPage() {
  const [qs] = useSearchParams();
  const nav = useNavigate();
  const token = qs.get('token');
  const invalid = qs.get('error') === 'INVALID_TOKEN' || !token;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 10) return setError(t('Password too short (at least 10 characters)'));
    if (pw !== pw2) return setError(t('The passwords do not match'));
    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: pw, token: token! });
    setBusy(false);
    if (error) return setError(authError(error));
    setDone(true);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-accent/10 to-transparent" aria-hidden />
      <div className="absolute top-5 right-6 flex items-center gap-3">
        <LanguageSwitch />
        <ThemeSwitch />
      </div>
      <form onSubmit={submit} className="relative w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-12" />
          <span className="text-2xl font-semibold tracking-tight">LoadLab</span>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{t('Choose a new password')}</h2>
        <p className="mt-1 mb-6 text-sm text-ink-3">{t('All other sessions will be signed out.')}</p>

        {invalid ? (
          <div className="space-y-4">
            <Alert tone="bad">{t('This reset link is invalid or has expired. Request a new one.')}</Alert>
            <Link to="/login" className="block text-center text-xs text-ink-3 hover:text-ink">
              {t('← Back to sign in')}
            </Link>
          </div>
        ) : done ? (
          <div className="space-y-4">
            <Alert tone="good">{t('Your password was changed. You can sign in now.')}</Alert>
            <Button variant="primary" className="h-11 w-full" onClick={() => nav('/login')}>
              {t('Sign in')} <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error && <Alert tone="bad">{error}</Alert>}
            {[
              { v: pw, set: setPw, label: t('New password (min 10)') },
              { v: pw2, set: setPw2, label: t('Repeat the new password') },
            ].map((f) => (
              <label key={f.label} className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-2">{f.label}</span>
                <div className="relative">
                  <Lock className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                  <PasswordInput autoComplete="new-password" className="h-11 pl-9" placeholder="••••••••" value={f.v} onChange={(e) => f.set(e.target.value)} />
                </div>
              </label>
            ))}
            <Button variant="primary" className="h-11 w-full" loading={busy} type="submit">
              {t('Set new password')}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
