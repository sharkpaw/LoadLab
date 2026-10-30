import { cx } from './ui';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * LoadLab mark, inline so it can animate: the load curve draws itself once and the
 * breakpoint marker pulses softly. Same artwork as /favicon.svg (docs/logo.svg).
 * SMIL instead of CSS: CSS dash animations next to a transform animation are not
 * repainted reliably in Chrome.
 */
export function Logo({ className, animated = true }: { className?: string; animated?: boolean }) {
  const animate = animated && !reducedMotion();
  const curve = 'M26 200 C66 198 88 174 112 152 S160 112 178 90 S206 52 230 38';
  return (
    <svg viewBox="0 0 256 256" className={cx('shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id="ll-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f9bf0" />
          <stop offset="1" stopColor="#1c5cab" />
        </linearGradient>
        <linearGradient id="ll-logo-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="56" fill="url(#ll-logo-bg)" />
      <path d={`${curve} L230 256 L26 256 Z`} fill="url(#ll-logo-area)" opacity={animate ? 0 : 1}>
        {animate && <animate attributeName="opacity" from="0" to="1" begin="0.9s" dur="0.8s" fill="freeze" />}
      </path>
      <line x1="178" y1="26" x2="178" y2="232" stroke="#ffd2c2" strokeWidth="7" strokeDasharray="13 11" strokeLinecap="round" />
      <path d={curve} fill="none" stroke="#ffffff" strokeWidth="20" strokeLinecap="round" strokeDasharray={animate ? 320 : undefined} strokeDashoffset={animate ? 320 : undefined}>
        {animate && <animate attributeName="stroke-dashoffset" from="320" to="0" begin="0.15s" dur="1.1s" calcMode="spline" keySplines="0.65 0 0.35 1" keyTimes="0;1" fill="freeze" />}
      </path>
      {animate && (
        <circle cx="178" cy="90" r="19" fill="none" stroke="#ffffff" strokeWidth="6" opacity="0">
          <animate attributeName="r" values="19;40;40" keyTimes="0;0.7;1" begin="1.3s" dur="2.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0;0" keyTimes="0;0.7;1" begin="1.3s" dur="2.8s" repeatCount="indefinite" />
        </circle>
      )}
      <circle cx="178" cy="90" r="19" fill="#d95926" stroke="#ffffff" strokeWidth="8" />
    </svg>
  );
}
