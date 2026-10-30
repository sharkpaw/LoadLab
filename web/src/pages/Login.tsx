import { useEffect, useState } from 'react';
import { ArrowRight, Bot, KeyRound, Lock, Mail, ShieldCheck, Workflow, Zap } from 'lucide-react';
import { authClient, authError, continueOAuth } from '../lib/auth';
import { msg, t } from '../lib/i18n';
import { Alert, Button, Input, PasswordInput } from '../components/ui';
import { Logo } from '../components/Logo';
import { LanguageSwitch } from '../components/LanguageSwitch';

/** Decorative load / latency chart for the brand panel (pure SVG, animated with CSS). */
function HeroChart() {
  // ramp of virtual users and a latency line that bends at the breakpoint
  const vus = 'M0,190 C60,188 90,170 130,150 S210,108 260,90 S350,52 420,40';
  const p95 = 'M0,160 C70,158 120,156 170,150 S240,140 280,128 S330,70 360,48 S400,22 420,16';
  return (
    <svg viewBox="0 0 420 210" className="h-auto max-h-[26vh] w-full" aria-hidden>
      <defs>
        <linearGradient id="ll-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#3987e5" stopOpacity="0.35" />
          <stop offset="1" stopColor="#3987e5" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[40, 80, 120, 160, 200].map((y) => (
        <line key={y} x1="0" x2="420" y1={y} y2={y} stroke="#2c2c29" strokeWidth="1" />
      ))}
      <path d={`${vus} L420,210 L0,210 Z`} fill="url(#ll-area)" className="ll-fade" />
      <path d={vus} fill="none" stroke="#3987e5" strokeWidth="2.5" strokeLinecap="round" className="ll-draw" />
      <path d={p95} fill="none" stroke="#d95926" strokeWidth="2.5" strokeLinecap="round" className="ll-draw ll-delay" />
      <line x1="300" x2="300" y1="10" y2="210" stroke="#e66767" strokeDasharray="4 4" className="ll-fade ll-delay-2" />
      <g className="ll-fade ll-delay-2">
        <rect x="306" y="12" rx="4" width="110" height="22" fill="#e66767" fillOpacity="0.15" />
        <text x="314" y="27" fill="#e66767" fontSize="11" fontFamily="ui-sans-serif, system-ui">{t('breakpoint')}</text>
      </g>
    </svg>
  );
}

const FEATURES = [
  { icon: Workflow, title: msg('Real user journeys'), desc: msg('Visit → browse products → sign in → buy, with probabilities and shared modules.') },
  { icon: Zap, title: msg('Find your breaking point'), desc: msg('Ramp until p95 or errors cross your limit and get the healthy capacity.') },
  { icon: Bot, title: msg('Built for AI agents (MCP)'), desc: msg('Claude, Gemini, ChatGPT or any MCP client drafts workflows and tests; you review and press start.') },
];

/** One feature at a time, sliding every few seconds; pauses on hover, dots to jump. */
function FeatureSlider() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const h = setInterval(() => setI((x) => (x + 1) % FEATURES.length), 4500);
    return () => clearInterval(h);
  }, [paused]);
  return (
    <div className="relative shrink-0" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="overflow-hidden rounded-xl border border-line bg-bg/50 backdrop-blur">
        <ul className="ll-slide flex" style={{ transform: `translateX(-${i * 100}%)` }} aria-live="polite">
          {FEATURES.map((f, idx) => (
            <li key={f.title} className="flex w-full shrink-0 gap-3 p-4" aria-hidden={idx !== i}>
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2">
                <f.icon className="size-4 text-accent" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium">{t(f.title)}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{t(f.desc)}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex gap-1.5">
        {FEATURES.map((f, idx) => (
          <button
            key={f.title}
            onClick={() => setI(idx)}
            aria-label={t(f.title)}
            className={`h-1.5 rounded-full transition-all ${idx === i ? 'w-6 bg-accent' : 'w-1.5 bg-line-strong hover:bg-ink-3'}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'password' | 'totp' | 'backup' | 'forgot' | 'sent'>('password');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'forgot') {
        const { error } = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
        if (error) return setError(authError(error));
        setStep('sent');
        return;
      }
      if (step === 'password') {
        const { data, error } = await authClient.signIn.email({ email, password });
        if (error) return setError(authError(error));
        if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
          setStep('totp');
          return;
        }
        if (continueOAuth(data)) return;
        onLogin();
      } else {
        const { data, error } =
          step === 'totp'
            ? await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, ''), trustDevice: trust })
            : await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: trust });
        if (error) return setError(authError(error));
        if (continueOAuth(data)) return;
        onLogin();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    // Fills exactly one screen: no page scroll on desktop; the form column scrolls only on very short phones
    <div className="grid h-dvh overflow-hidden lg:grid-cols-[1.1fr_1fr]">
      {/* brand panel */}
      <aside className="relative hidden h-dvh min-h-0 flex-col overflow-hidden border-r border-line bg-surface p-10 lg:flex xl:p-12">
        <div className="pointer-events-none absolute -top-40 -left-40 size-[520px] rounded-full bg-accent/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -right-32 -bottom-48 size-[420px] rounded-full bg-[#d95926]/10 blur-3xl" aria-hidden />
        <div className="ll-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />

        <div className="relative flex shrink-0 items-center gap-3">
          <Logo className="size-12" />
          <span className="text-2xl font-semibold tracking-tight">LoadLab</span>
        </div>

        <div className="relative flex min-h-0 max-w-xl flex-1 flex-col justify-center py-6">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">
            {t('Know how much traffic your site can take')}
            <span className="text-accent">.</span>
          </h1>
          <p className="mt-3 text-sm text-ink-2 xl:text-base">{t('k6-powered load tests with real user journeys, live charts and a benchmark history for every site.')}</p>

          <div className="mt-6 min-h-0 rounded-xl border border-line bg-bg/60 p-4 backdrop-blur">
            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-ink-2">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-good" />
                </span>
                {t('Live run · checkout flow')}
              </span>
              <span className="flex gap-3 text-ink-3">
                <span className="flex items-center gap-1">
                  <span className="h-0.5 w-3 rounded bg-[#3987e5]" /> {t('users')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-0.5 w-3 rounded bg-[#d95926]" /> p95
                </span>
              </span>
            </div>
            <HeroChart />
            <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-ink-3">{t('Capacity')}</div>
                <div className="tabular text-base font-semibold">412 rps</div>
              </div>
              <div>
                <div className="text-ink-3">p95</div>
                <div className="tabular text-base font-semibold">184 ms</div>
              </div>
              <div>
                <div className="text-ink-3">{t('Errors')}</div>
                <div className="tabular text-base font-semibold text-good">0.02%</div>
              </div>
            </div>
          </div>
        </div>

        <FeatureSlider />
      </aside>

      {/* form */}
      <main className="relative flex h-dvh flex-col items-center justify-center gap-6 overflow-y-auto p-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-accent/10 to-transparent lg:hidden" aria-hidden />
        <div className="absolute top-5 right-6">
          <LanguageSwitch />
        </div>

        <form onSubmit={submit} className="relative w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo className="size-12" />
            <span className="text-2xl font-semibold tracking-tight">LoadLab</span>
          </div>

          {step === 'password' ? (
            <>
              <h2 className="text-2xl font-semibold tracking-tight">{t('Welcome back')}</h2>
              <p className="mt-1 mb-6 text-sm text-ink-3">{t('Sign in to the dashboard')}</p>
            </>
          ) : step === 'forgot' || step === 'sent' ? (
            <>
              <h2 className="text-2xl font-semibold tracking-tight">{t('Reset your password')}</h2>
              <p className="mt-1 mb-6 text-sm text-ink-3">{t('We will send a reset link to your e-mail address.')}</p>
            </>
          ) : (
            <>
              <div className="mb-4 grid size-11 place-items-center rounded-xl border border-accent/40 bg-accent/10">
                <ShieldCheck className="size-5 text-[#86b6ef]" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">{t('Two-factor authentication')}</h2>
              <p className="mt-1 mb-6 text-sm text-ink-3">{step === 'totp' ? t('6-digit code from your authenticator app') : t('Backup code')}</p>
            </>
          )}

          {error && (
            <div className="mb-4">
              <Alert tone="bad">{error}</Alert>
            </div>
          )}

          <div className="space-y-4">
            {step === 'sent' ? (
              <Alert tone="good" title={t('Check your inbox')}>
                {t('If an account exists for {email}, a reset link is on its way. It is valid for 30 minutes. If e-mail is not set up on this server, an administrator can find the link in the server log.', { email })}
              </Alert>
            ) : step === 'forgot' ? (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-2">{t('Email')}</span>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                  <Input type="email" autoFocus autoComplete="username" className="h-11 pl-9" placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </label>
            ) : step === 'password' ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-ink-2">{t('Email')}</span>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <Input type="email" autoFocus autoComplete="username" className="h-11 pl-9" placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-2">
                    {t('Password')}
                    <button type="button" className="font-normal text-ink-3 hover:text-ink" onClick={() => (setStep('forgot'), setError(null))}>
                      {t('Forgot password?')}
                    </button>
                  </span>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <PasswordInput autoComplete="current-password" className="h-11 pl-9" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                </label>
              </>
            ) : (
              <>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                  <Input
                    autoFocus
                    aria-label={step === 'totp' ? t('6-digit code from your authenticator app') : t('Backup code')}
                    inputMode={step === 'totp' ? 'numeric' : 'text'}
                    autoComplete="one-time-code"
                    className="h-12 pl-9 text-center font-mono text-xl tracking-[0.4em]"
                    placeholder={step === 'totp' ? '000000' : ''}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> {t('Trust this device for 30 days')}
                </label>
              </>
            )}

            {step !== 'sent' && (
              <Button variant="primary" className="h-11 w-full text-sm" loading={busy} type="submit">
                {step === 'password' ? t('Sign in') : step === 'forgot' ? t('Send reset link') : t('Verify')}
                {!busy && <ArrowRight className="size-4" />}
              </Button>
            )}

            {(step === 'forgot' || step === 'sent') && (
              <button type="button" className="w-full text-center text-xs text-ink-3 hover:text-ink" onClick={() => (setStep('password'), setError(null))}>
                {t('← Back to sign in')}
              </button>
            )}

            {(step === 'totp' || step === 'backup') && (
              <button type="button" className="w-full text-center text-xs text-ink-3 hover:text-ink" onClick={() => (setStep(step === 'totp' ? 'backup' : 'totp'), setCode(''), setError(null))}>
                {step === 'totp' ? t("Don't have your phone? Use a backup code") : t('Use the authenticator app code')}
              </button>
            )}
          </div>

        </form>
      </main>
    </div>
  );
}
