import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { LogOut, ShieldCheck, ShieldOff, Trash2, UserPlus, Users } from 'lucide-react';
import type { Me } from '../App';
import { api, errorText } from '../lib/api';
import { authClient, authError } from '../lib/auth';
import { fmtAgo } from '../lib/format';
import { t } from '../lib/i18n';
import { Alert, Badge, Button, Card, Field, Input, PasswordInput, Modal, useLoad, useToast } from './ui';

export function AccountSecurity({ me, onChange }: { me: Me; onChange: () => void }) {
  const toast = useToast();
  // --- password ---
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busyPw, setBusyPw] = useState(false);
  const changePassword = async () => {
    if (next.length < 10) return toast(t('The new password must be at least 10 characters'), 'bad');
    setBusyPw(true);
    const { error } = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true });
    setBusyPw(false);
    if (error) return toast(authError(error), 'bad');
    setCur('');
    setNext('');
    toast(t('Password changed; other sessions were signed out'), 'good');
    sessions.reload();
  };

  // --- 2FA ---
  const enabled = !!me.user.twoFactorEnabled;
  const [tfaOpen, setTfaOpen] = useState(false);
  const [tfaPassword, setTfaPassword] = useState('');
  const [setup, setSetup] = useState<{ qr: string; uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [tfaErr, setTfaErr] = useState<string | null>(null);
  const [tfaBusy, setTfaBusy] = useState(false);

  const startEnable = async () => {
    setTfaBusy(true);
    setTfaErr(null);
    const { data, error } = await authClient.twoFactor.enable({ password: tfaPassword });
    setTfaBusy(false);
    if (error || !data) return setTfaErr(authError(error));
    if (!('totpURI' in data)) return setTfaErr(t('Unexpected response: could not get the TOTP setup'));
    const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
    setSetup({ qr: await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 }), uri: data.totpURI, secret, backupCodes: data.backupCodes });
  };
  const confirmEnable = async () => {
    setTfaBusy(true);
    setTfaErr(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
    setTfaBusy(false);
    if (error) return setTfaErr(authError(error));
    toast(t('Two-factor authentication enabled'), 'good');
    closeTfa();
    onChange();
  };
  const disable = async () => {
    setTfaBusy(true);
    setTfaErr(null);
    const { error } = await authClient.twoFactor.disable({ password: tfaPassword });
    setTfaBusy(false);
    if (error) return setTfaErr(authError(error));
    toast(t('Two-factor authentication disabled'));
    closeTfa();
    onChange();
  };
  const closeTfa = () => {
    setTfaOpen(false);
    setTfaPassword('');
    setSetup(null);
    setCode('');
    setTfaErr(null);
  };

  // --- sessions ---
  const sessions = useLoad(async () => (await authClient.listSessions()).data ?? []);
  const current = useLoad(async () => (await authClient.getSession()).data?.session.token ?? null);

  return (
    <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-accent" /> {t('Account security')}</span>}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t('Two-factor authentication (TOTP)')}</div>
            <div className="text-xs text-ink-3">{t('Sign-in codes from Google Authenticator, 1Password, Authy, etc.')}</div>
          </div>
          {enabled ? <Badge tone="good">{t('on')}</Badge> : <Badge tone="warn">{t('off')}</Badge>}
          <Button size="sm" variant={enabled ? 'danger' : 'primary'} icon={enabled ? <ShieldOff className="size-3.5" /> : <ShieldCheck className="size-3.5" />} onClick={() => setTfaOpen(true)}>
            {enabled ? t('Disable') : t('Enable')}
          </Button>
        </div>

        <div className="border-t border-line pt-4">
          <div className="mb-2 text-sm font-medium">{t('Change password')}</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <PasswordInput autoComplete="current-password" placeholder={t('Current password')} value={cur} onChange={(e) => setCur(e.target.value)} />
            <PasswordInput autoComplete="new-password" placeholder={t('New password (min 10)')} value={next} onChange={(e) => setNext(e.target.value)} />
            <Button onClick={changePassword} loading={busyPw} disabled={!cur || !next}>
              {t('Change')}
            </Button>
          </div>
        </div>

        <div className="border-t border-line pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t('Active sessions')}</span>
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut className="size-3.5" />}
              onClick={async () => {
                await authClient.revokeOtherSessions();
                toast(t('Other sessions signed out'), 'good');
                sessions.reload();
              }}
            >
              {t('Sign out others')}
            </Button>
          </div>
          <ul className="divide-y divide-line/60 rounded-md border border-line text-xs">
            {(sessions.data ?? []).map((s: any) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink-2">{s.userAgent || t('unknown browser')}</div>
                  <div className="text-ink-3">
                    {s.ipAddress || t('no IP')} · {fmtAgo(s.updatedAt)}
                  </div>
                </div>
                {s.token === current.data ? (
                  <Badge tone="accent">{t('this session')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await authClient.revokeSession({ token: s.token });
                      sessions.reload();
                    }}
                  >
                    {t('Sign out')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Modal open={tfaOpen} onClose={closeTfa} title={enabled ? t('Disable two-factor authentication') : t('Enable two-factor authentication')}>
        <div className="space-y-4">
          {tfaErr && <Alert tone="bad">{tfaErr}</Alert>}
          {!setup ? (
            <>
              <Field label={t('Your password')}>
                <PasswordInput autoFocus autoComplete="current-password" value={tfaPassword} onChange={(e) => setTfaPassword(e.target.value)} />
              </Field>
              <div className="flex justify-end">
                {enabled ? (
                  <Button variant="danger" loading={tfaBusy} onClick={disable} disabled={!tfaPassword}>
                    {t('Disable')}
                  </Button>
                ) : (
                  <Button variant="primary" loading={tfaBusy} onClick={startEnable} disabled={!tfaPassword}>
                    {t('Continue')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <img src={setup.qr} alt={t('TOTP QR code')} className="size-40 rounded bg-white p-1" />
                <div className="min-w-0 space-y-2 text-xs text-ink-2">
                  <p>{t('1. Scan the QR code with your authenticator app or enter the key manually:')}</p>
                  <code className="block rounded bg-bg p-2 font-mono break-all select-all">{setup.secret}</code>
                  <p>{t('2. Enter the 6-digit code the app shows.')}</p>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-ink-2">{t('Backup codes — store them somewhere safe; each works once')}</div>
                <div className="grid grid-cols-2 gap-1 rounded bg-bg p-2 font-mono text-xs select-all sm:grid-cols-5">
                  {setup.backupCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Input inputMode="numeric" autoComplete="one-time-code" className="text-center font-mono tracking-widest" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
                <Button variant="primary" loading={tfaBusy} onClick={confirmEnable} disabled={code.replace(/\s/g, '').length < 6}>
                  {t('Verify and enable')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </Card>
  );
}

export function UsersCard({ me }: { me: Me }) {
  const toast = useToast();
  const users = useLoad(() => api.get<any[]>('/api/users'));
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setErr(null);
  }, [open]);
  const create = async () => {
    try {
      await api.post('/api/users', form);
      toast(t('User added'), 'good');
      setOpen(false);
      setForm({ name: '', email: '', password: '' });
      users.reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Users className="size-4 text-accent" /> {t('Dashboard users')}</span>}
      actions={
        <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setOpen(true)}>
          {t('Add user')}
        </Button>
      }
      pad={false}
    >
      <ul className="divide-y divide-line/60">
        {(users.data ?? []).map((u) => (
          <li key={u.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{u.name}</div>
              <div className="truncate text-xs text-ink-3">{u.email}</div>
            </div>
            {u.twoFactorEnabled ? <Badge tone="good">2FA</Badge> : <Badge tone="warn">{t('no 2FA')}</Badge>}
            <span className="hidden text-xs text-ink-3 sm:inline">{u.lastSeenAt ? fmtAgo(u.lastSeenAt) : t('never signed in')}</span>
            {u.id === me.user.id ? (
              <Badge tone="accent">{t('you')}</Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('Delete')}
                onClick={async () => {
                  if (!confirm(t('Delete {email}?', { email: u.email }))) return;
                  try {
                    await api.del(`/api/users/${u.id}`);
                    users.reload();
                  } catch (e) {
                    toast(errorText(e), 'bad');
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2 text-xs text-ink-3">{t('Public sign-up is disabled; only signed-in users can add new users. Every user should enable 2FA.')}</p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('New user')}
        footer={
          <Button variant="primary" onClick={create} disabled={!form.email || form.password.length < 10}>
            {t('Add')}
          </Button>
        }
      >
        <div className="space-y-3">
          {err && <Alert tone="bad">{err}</Alert>}
          <Field label={t('Name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('Email')}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={t('Temporary password')} hint={t('At least 10 characters. The user should change it in Settings after the first sign-in.')}>
            <Input type="text" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
